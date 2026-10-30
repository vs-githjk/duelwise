import json
import subprocess
import sys
import textwrap
from pathlib import Path

import numpy as np
import pytest

from trainer.bridge import BridgeError, BridgeEnv, SelfPlayDriver, find_bun

REPO = Path(__file__).resolve().parents[2]
ENV_HOST = REPO / "packages" / "core" / "src" / "bridge" / "env-host.ts"
N, SEED, STEPS = 8, 3, 60


def action_for(t, n=N):
    i = (np.arange(n)[:, None] * 7 + np.arange(2)[None, :] * 3 + t * 5) % 11
    return i.astype(np.int32)[:, :, None]  # (n, seat, actionDims=1)


def ts_reference():
    """The same toy env stepped in-process in TypeScript with the same action schedule."""
    script = textwrap.dedent(
        f"""
        import {{ createToyCounterEnv }} from {json.dumps(str(ENV_HOST))}
        const n = {N}, seed = {SEED}, steps = {STEPS}
        const env = createToyCounterEnv({{ n, seed }})
        const out: any[] = []
        out.push({{ obs: Array.from(env.reset(Array.from({{ length: n }}, (_, i) => seed + i))) }})
        for (let t = 0; t < steps; t++) {{
          const a = new Int32Array(n * 2)
          for (let i = 0; i < n; i++) for (let s = 0; s < 2; s++) a[i * 2 + s] = (i * 7 + s * 3 + t * 5) % 11
          const r = env.step(a)
          out.push({{ obs: Array.from(r.obs), reward: Array.from(r.reward), done: Array.from(r.done), infos: r.infos }})
        }}
        console.log(JSON.stringify(out))
        """
    )
    p = subprocess.run([find_bun(), "-e", script], capture_output=True, text=True, cwd=REPO, timeout=60)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def test_toy_env_over_the_bridge_equals_in_process_typescript():
    ref = ts_reference()
    with BridgeEnv("toy-counter", n=N, seed=SEED) as env:
        assert env.obs_shape == (3,) and env.action_dims == 1 and env.n == N
        obs = env.reset()
        assert obs.shape == (N, 3) and obs.dtype == np.float32
        np.testing.assert_array_equal(obs.reshape(-1), np.array(ref[0]["obs"], dtype=np.float32))
        total_done = 0
        for t in range(STEPS):
            obs, reward, done, infos = env.step(action_for(t))
            r = ref[t + 1]
            np.testing.assert_array_equal(obs.reshape(-1), np.array(r["obs"], dtype=np.float32))
            np.testing.assert_array_equal(reward, np.array(r["reward"], dtype=np.float32))
            np.testing.assert_array_equal(done.astype(np.uint8), np.array(r["done"], dtype=np.uint8))
            assert infos == r["infos"]
            total_done += int(done.sum())
        assert total_done >= N  # every env finished at least one game, so auto-reset was exercised


def test_steps_until_every_env_is_done_at_least_once():
    with BridgeEnv("toy-counter", n=8, seed=11) as env:
        env.reset()
        seen = np.zeros(8, dtype=bool)
        for t in range(100):
            _, _, done, infos = env.step(action_for(t))
            seen |= done
            assert len(infos) == int(done.sum())
        assert seen.all()


def test_bad_action_shape_is_rejected_before_sending():
    with BridgeEnv("toy-counter", n=2, seed=1) as env:
        env.reset()
        with pytest.raises(BridgeError):
            env.step(np.zeros((2, 1, 1), dtype=np.int32))


def test_game_without_an_env_fails_with_a_clear_message():
    # Fighter (T7) and arena (T10) envs are built; the turn-based games train through other paths and have no env.
    with pytest.raises(BridgeError, match="no env for game"):
        BridgeEnv("chess", n=1, seed=0)


def test_close_ends_the_process():
    env = BridgeEnv("toy-counter", n=1, seed=0)
    proc = env._proc
    env.close()
    assert proc.poll() is not None
    env.close()  # idempotent


FAKE_HOST = textwrap.dedent(
    """
    import json, struct, sys
    import numpy as np
    out, inp = sys.stdout.buffer, sys.stdin.buffer
    def send(h, p=b""):
        hb = json.dumps(h).encode()
        out.write(struct.pack("<II", 4 + len(hb) + len(p), len(hb)) + hb + p); out.flush()
    def recv():
        total = struct.unpack("<I", inp.read(4))[0]
        body = inp.read(total)
        hl = struct.unpack("<I", body[:4])[0]
        return json.loads(body[4:4 + hl]), body[4 + hl:]
    for k in range(3):
        send({"type": "eval_request", "n": 2, "obsSize": 4}, np.full((2, 4), k, dtype=np.float32).tobytes())
        h, p = recv()
        assert h["type"] == "eval_response"
        policy = np.frombuffer(p[: 2 * 3 * 4], dtype=np.float32).reshape(2, 3)
        value = np.frombuffer(p[2 * 3 * 4:], dtype=np.float32)
        if abs(float(policy.sum()) - 3.0) > 1e-6 or abs(float(value.sum()) - 2.0 * k) > 1e-6:
            sys.exit(5)
    send({"type": "games", "games": [{"id": 1}, {"id": 2}]})
    """
)


def test_selfplay_driver_answers_eval_requests_until_games(tmp_path):
    host = tmp_path / "fake_host.py"
    host.write_text(FAKE_HOST)
    seen = []

    def evaluate(batch):
        seen.append(batch.copy())
        n = batch.shape[0]
        return np.full((n, 3), 0.5, dtype=np.float32), np.full(n, batch[0, 0], dtype=np.float32)

    driver = SelfPlayDriver("four", n_games=2, sims=8, evaluate_fn=evaluate, cmd=[sys.executable, str(host)])
    games = driver.run()
    assert games == [{"id": 1}, {"id": 2}]
    assert [b[0, 0] for b in seen] == [0.0, 1.0, 2.0]
    assert all(b.shape == (2, 4) for b in seen)
