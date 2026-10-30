# CleanRL (PPO)

- Source: https://github.com/vwxyzjn/cleanrl, file `cleanrl/ppo.py`
- License: MIT, Copyright (c) 2019 CleanRL developers
- Used in: `training/trainer/ppo/ppo.py` (policy and value network, GAE, clipped PPO update)
- Changes: multi-discrete action space with one shared trunk, rollout loop moved to `train_realtime.py`
  (batched bridge envs and a PFSP league of opponents), constant learning rate, the update as a plain function
  over a flat batch. The MIT license header is kept at the top of `ppo.py`.
- Shipped to users: no. Only the exported ONNX weights ship; the training code does not.
