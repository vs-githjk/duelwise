#!/usr/bin/env python3
"""Generates the Duelwise logo direction SVGs (A, B, C).

Each direction has three files:
  <dir>-icon.svg      square app icon with background, 512 viewBox, rounded corners
  <dir>-maskable.svg  full-bleed square, art kept inside the 80 percent safe circle
  <dir>-mark.svg      the mark alone on a transparent ground (favicon, OAuth on own ground)
Palette is the Sunroom spec (plan/design/final/spec.md section 2) plus the persona tints
from apps/web/public/personas/*.svg. Run: python3 build.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))

CREAM = "#fff6ef"
PEACH = "#ffb088"
PEACH_DEEP = "#d9682f"
BLUE = "#2b6fe6"
INK = "#1f1a17"
PIP = "#e8c877"
MARLOW = "#8fb0d0"
VESPER = "#a98ac4"
SABLE_PLATE = "#2a2724"
SABLE_GOLD = "#c9a34d"

HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="{label}">\n<!-- Duelwise logo, direction {name}. {note} Hand-built vector, no fonts. -->\n'


def wrap(label, name, note, body):
    return HEAD.format(label=label, name=name, note=note) + body + "</svg>\n"


def scaled(inner, s):
    if s == 1:
        return inner
    return f'<g transform="translate(256 256) scale({s}) translate(-256 -256)">\n{inner}</g>\n'


# ---------- A. Face-off: player cursor vs agent eye across one cream slash ----------
A_CURSOR = (
    '<g transform="translate(130 112) scale(5.6)">'
    '<path d="M0 0 L0 23 L5.4 18.2 L9.6 27.4 L13.9 25.4 L9.8 16.5 L17.2 16.5 Z" '
    f'fill="{INK}" stroke="{CREAM}" stroke-width="2.2" stroke-linejoin="round"/></g>\n'
)
A_EYE = (
    '<defs><clipPath id="a-eye"><path d="M-88 0 Q0 -26 88 0 Q0 64 -88 0 Z" transform="translate(344 344)"/></clipPath></defs>\n'
    '<g transform="translate(344 344)">'
    f'<path d="M-88 0 Q0 -26 88 0 Q0 64 -88 0 Z" fill="{CREAM}"/>'
    '</g>\n'
    f'<circle cx="318" cy="340" r="30" fill="{INK}" clip-path="url(#a-eye)"/>\n'
)


def a_ground(clip):
    g = f'<rect width="512" height="512" fill="{PEACH}"/>\n'
    g += f'<path d="M512 0 L512 512 L0 512 Z" fill="{BLUE}"/>\n'
    g += f'<path d="M0 512 L512 0" stroke="{CREAM}" stroke-width="40"/>\n'
    return g


def direction_a():
    art = A_CURSOR + A_EYE
    icon = (
        '<defs><clipPath id="a-rr"><rect width="512" height="512" rx="112"/></clipPath></defs>\n'
        '<g clip-path="url(#a-rr)">\n' + a_ground(True) + art + '</g>\n'
    )
    mask = a_ground(False) + scaled(art, 0.96)
    # Mark: the split tile is the mark; keep rounded corners, no extra ground.
    mark = icon
    return icon, mask, mark


# ---------- B. Side-eye D: the D is the agent, its counter is one smug eye ----------
B_D = (
    '<defs><clipPath id="b-eye"><path d="M200 226 Q266 206 332 226 A66 50 0 0 1 200 226 Z"/></clipPath></defs>\n'
    f'<path d="M136 112 H256 A144 144 0 0 1 256 400 H136 Z" fill="{BLUE}"/>\n'
    f'<path d="M200 226 Q266 206 332 226 A66 50 0 0 1 200 226 Z" fill="{CREAM}"/>\n'
    f'<circle cx="238" cy="236" r="27" fill="{INK}" clip-path="url(#b-eye)"/>\n'
    f'<path d="M232 322 Q272 350 308 314" fill="none" stroke="{CREAM}" stroke-width="20" stroke-linecap="round"/>\n'
)


def direction_b():
    icon = f'<rect width="512" height="512" rx="112" fill="{PEACH}"/>\n' + B_D
    mask = f'<rect width="512" height="512" fill="{PEACH}"/>\n' + scaled(B_D, 0.94)
    mark = B_D
    return icon, mask, mark


# ---------- C. The Climb: four persona stops, each one bigger, stacked up to Sable ----------
def tile(cx, cy, s, r, fill, ring=None):
    x, y = cx - s / 2, cy - s / 2
    out = f'<rect x="{x:g}" y="{y:g}" width="{s}" height="{s}" rx="{r}" fill="{fill}" stroke="{CREAM}" stroke-width="12"/>\n'
    if ring:
        inset = 18
        out += (
            f'<rect x="{x + inset:g}" y="{y + inset:g}" width="{s - 2 * inset}" height="{s - 2 * inset}" '
            f'rx="{max(r - inset, 6)}" fill="none" stroke="{ring}" stroke-width="8"/>\n'
        )
    return out


C_TILES = (
    tile(116, 396, 96, 24, PIP)
    + tile(196, 316, 120, 30, MARLOW)
    + tile(284, 228, 144, 36, VESPER)
    + tile(380, 132, 168, 42, SABLE_PLATE, ring=SABLE_GOLD)
)


def direction_c():
    icon = f'<rect width="512" height="512" rx="112" fill="{BLUE}"/>\n' + scaled(C_TILES, 0.88)
    mask = f'<rect width="512" height="512" fill="{BLUE}"/>\n' + scaled(C_TILES, 0.78)
    mark = C_TILES
    return icon, mask, mark


# ---------- C1. The Climb to the D: three stops, the final boss is the Side-eye D ----------
def small_d(cx, cy, h, uid):
    """B's D (bbox 136..400 x, 112..400 y, centre 268,256; 288 tall) scaled to h and centred at cx,cy."""
    k = h / 288
    body = B_D.replace('id="b-eye"', f'id="b-eye-{uid}"').replace('url(#b-eye)', f'url(#b-eye-{uid})')
    body = body.replace(f'fill="{BLUE}"/>', f'fill="{BLUE}" stroke="{CREAM}" stroke-width="{12 / k:.1f}" stroke-linejoin="round" paint-order="stroke"/>', 1)
    return f'<g transform="translate({cx} {cy}) scale({k:.4f}) translate(-268 -256)">\n{body}</g>\n'


C1_ART = (
    tile(108, 404, 88, 22, PIP)
    + tile(190, 322, 108, 27, MARLOW)
    + tile(282, 230, 128, 32, VESPER)
    + small_d(392, 126, 184, "c1")
)


def direction_c1():
    icon = f'<rect width="512" height="512" rx="112" fill="{PEACH}"/>\n' + scaled(C1_ART, 0.95)
    mask = f'<rect width="512" height="512" fill="{PEACH}"/>\n' + scaled(C1_ART, 0.8)
    mark = C1_ART
    return icon, mask, mark


# ---------- C2. The Climb inside the D: the eye is the last stop ----------
def c2_tile(cx, cy, s, r, fill):
    x, y = cx - s / 2, cy - s / 2
    return f'<rect x="{x:g}" y="{y:g}" width="{s}" height="{s}" rx="{r}" fill="{fill}" stroke="{CREAM}" stroke-width="8"/>\n'


C2_ART = (
    '<defs><clipPath id="c2-eye"><path d="M264 184 Q318 168 372 184 A54 40 0 0 1 264 184 Z"/></clipPath></defs>\n'
    f'<path d="M136 112 H256 A144 144 0 0 1 256 400 H136 Z" fill="{BLUE}"/>\n'
    f'<path d="M264 184 Q318 168 372 184 A54 40 0 0 1 264 184 Z" fill="{CREAM}"/>\n'
    f'<circle cx="298" cy="194" r="23" fill="{INK}" clip-path="url(#c2-eye)"/>\n'
    + c2_tile(176, 364, 50, 13, PIP)
    + c2_tile(226, 314, 62, 16, MARLOW)
    + c2_tile(282, 258, 74, 19, VESPER)
)


def direction_c2():
    icon = f'<rect width="512" height="512" rx="112" fill="{PEACH}"/>\n' + C2_ART
    mask = f'<rect width="512" height="512" fill="{PEACH}"/>\n' + scaled(C2_ART, 0.94)
    mark = C2_ART
    return icon, mask, mark


# ---------- X. Two climbs cross: blue D (agent) top right, red head (challenger) top left ----------
RED = "#c9452f"  # Sunroom --bad, the warm game red; Tinderbox already uses it


def sq_tile(cx, cy, size, fill):
    x, y = cx - size / 2, cy - size / 2
    return f'<rect x="{x:g}" y="{y:g}" width="{size}" height="{size}" rx="6" fill="{fill}" stroke="{CREAM}" stroke-width="10"/>\n'


def sable_tile(cx, cy, size):
    x, y = cx - size / 2, cy - size / 2
    i = 12
    return (f'<rect x="{x:g}" y="{y:g}" width="{size}" height="{size}" rx="6" fill="{SABLE_PLATE}" stroke="{CREAM}" stroke-width="10"/>\n'
            f'<rect x="{x + i:g}" y="{y + i:g}" width="{size - 2 * i}" height="{size - 2 * i}" rx="3" fill="none" stroke="{SABLE_GOLD}" stroke-width="5"/>\n')


# Each climb runs Pip, Marlow, Vesper (shared crossing), Sable, then the head in its top corner.
X_TILES = (
    sq_tile(96, 416, 68, PIP) + sq_tile(416, 416, 68, PIP)
    + sq_tile(176, 336, 78, MARLOW) + sq_tile(336, 336, 78, MARLOW)
    + sq_tile(256, 256, 94, VESPER)
    + sable_tile(336, 176, 78) + sable_tile(176, 176, 78)
)

BLUE_D = None  # set below


def blue_head(cx, cy, h, uid):
    return small_d(cx, cy, h, uid)


def red_d_head(cx, cy, h, uid):
    """Mirrored D (stem on the right) in red, eye wide open looking right, angry inner brow, frown."""
    k = h / 288
    body = (
        f'<defs><clipPath id="x-reye-{uid}"><ellipse cx="266" cy="226" rx="66" ry="50"/></clipPath></defs>\n'
        f'<path d="M136 112 H256 A144 144 0 0 1 256 400 H136 Z" fill="{RED}" stroke="{CREAM}" stroke-width="{12 / k:.1f}" stroke-linejoin="round" paint-order="stroke"/>\n'
        f'<ellipse cx="266" cy="226" rx="66" ry="50" fill="{CREAM}"/>\n'
        f'<circle cx="236" cy="232" r="27" fill="{INK}" clip-path="url(#x-reye-{uid})"/>\n'
        f'<path d="M196 150 L336 184" fill="none" stroke="{CREAM}" stroke-width="22" stroke-linecap="round"/>\n'
        f'<path d="M232 342 Q272 312 308 342" fill="none" stroke="{CREAM}" stroke-width="20" stroke-linecap="round"/>\n'
    )
    return f'<g transform="translate({cx} {cy}) scale({-k:.4f} {k:.4f}) translate(-268 -256)">\n{body}</g>\n'


def red_q_head(cx, cy, r, uid):
    """Q in red: a disc whose counter is an eye looking right, with a tail toward the crossing."""
    tx1, ty1, tx2, ty2 = cx + r * 0.42, cy + r * 0.42, cx + r * 0.82, cy + r * 0.82
    return (
        f'<defs><clipPath id="x-qeye-{uid}"><ellipse cx="{cx + 4}" cy="{cy - 3}" rx="{r * 0.54:.0f}" ry="{r * 0.4:.0f}"/></clipPath></defs>\n'
        f'<path d="M{tx1} {ty1} L{tx2} {ty2}" stroke="{CREAM}" stroke-width="{r * 0.72:.0f}" stroke-linecap="butt"/>\n'
        f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{RED}" stroke="{CREAM}" stroke-width="12"/>\n'
        f'<path d="M{tx1} {ty1} L{tx2} {ty2}" stroke="{RED}" stroke-width="{r * 0.42:.0f}" stroke-linecap="butt"/>\n'
        f'<ellipse cx="{cx + 4}" cy="{cy - 3}" rx="{r * 0.54:.0f}" ry="{r * 0.4:.0f}" fill="{CREAM}"/>\n'
        f'<circle cx="{cx + r * 0.3:.0f}" cy="{cy}" r="{r * 0.25:.0f}" fill="{INK}" clip-path="url(#x-qeye-{uid})"/>\n'
    )


X1_ART = X_TILES + red_d_head(92, 92, 136, "x1") + blue_head(420, 92, 136, "x1b")
X2_ART = X_TILES + red_q_head(94, 94, 64, "x2") + blue_head(420, 92, 136, "x2b")


def make_x(art):
    def fn():
        icon = f'<rect width="512" height="512" rx="112" fill="{PEACH}"/>\n' + scaled(art, 0.9)
        mask = f'<rect width="512" height="512" fill="{PEACH}"/>\n' + scaled(art, 0.76)
        return icon, mask, art
    return fn


# ---------- X1 final: cream ground, ink outlines, warm-to-red and cool-to-blue tiles ----------
# Agent's climb (bottom left to the blue D): mint, sky, then blue. Challenger's climb (bottom right to the red D): peach, orange, then coral.
MINT, SKY, DEEP_SKY = "#8fe0b8", "#7cc4f5", "#4b8ff0"
PEACH_T, ORANGE, CORAL = "#ffb088", "#ff8a4c", "#e85d3f"
GOLD = "#f6c445"
GROUND = CREAM


def ink_tile(cx, cy, size, fill, sw=10):
    x, y = cx - size / 2, cy - size / 2
    return f'<rect x="{x:g}" y="{y:g}" width="{size}" height="{size}" rx="8" fill="{fill}" stroke="{INK}" stroke-width="{sw}" stroke-linejoin="round"/>\n'


def blue_head_ink(cx, cy, h, uid):
    k = h / 288
    sw = 12 / k
    body = (
        f'<defs><clipPath id="f-beye-{uid}"><path d="M200 226 Q266 206 332 226 A66 50 0 0 1 200 226 Z"/></clipPath></defs>\n'
        f'<path d="M136 112 H256 A144 144 0 0 1 256 400 H136 Z" fill="{BLUE}" stroke="{INK}" stroke-width="{sw:.1f}" stroke-linejoin="round"/>\n'
        f'<path d="M200 226 Q266 206 332 226 A66 50 0 0 1 200 226 Z" fill="{CREAM}" stroke="{INK}" stroke-width="{sw * 0.55:.1f}" stroke-linejoin="round"/>\n'
        f'<circle cx="238" cy="236" r="27" fill="{INK}" clip-path="url(#f-beye-{uid})"/>\n'
        f'<path d="M232 322 Q272 350 308 314" fill="none" stroke="{INK}" stroke-width="{sw * 1.1:.1f}" stroke-linecap="round"/>\n'
    )
    return f'<g transform="translate({cx} {cy}) scale({k:.4f}) translate(-268 -256)">\n{body}</g>\n'


def red_head_ink(cx, cy, h, uid):
    k = h / 288
    sw = 12 / k
    body = (
        f'<defs><clipPath id="f-reye-{uid}"><ellipse cx="266" cy="226" rx="66" ry="50"/></clipPath></defs>\n'
        f'<path d="M136 112 H256 A144 144 0 0 1 256 400 H136 Z" fill="{RED}" stroke="{INK}" stroke-width="{sw:.1f}" stroke-linejoin="round"/>\n'
        f'<ellipse cx="266" cy="226" rx="66" ry="50" fill="{CREAM}" stroke="{INK}" stroke-width="{sw * 0.55:.1f}"/>\n'
        f'<circle cx="236" cy="232" r="27" fill="{INK}" clip-path="url(#f-reye-{uid})"/>\n'
        f'<path d="M196 146 L336 182" fill="none" stroke="{INK}" stroke-width="{sw * 1.3:.1f}" stroke-linecap="round"/>\n'
        f'<path d="M232 342 Q272 312 308 342" fill="none" stroke="{INK}" stroke-width="{sw * 1.1:.1f}" stroke-linecap="round"/>\n'
    )
    return f'<g transform="translate({cx} {cy}) scale({-k:.4f} {k:.4f}) translate(-268 -256)">\n{body}</g>\n'


# Seven tiles: each climb is start, step, crossing (shared), step, head.
X1F_ART = (
    ink_tile(110, 402, 72, MINT) + ink_tile(402, 402, 72, PEACH_T)
    + ink_tile(176, 336, 78, SKY) + ink_tile(336, 336, 78, ORANGE)
    + ink_tile(256, 256, 94, GOLD)
    + ink_tile(336, 176, 78, DEEP_SKY) + ink_tile(176, 176, 78, CORAL)
    + red_head_ink(92, 92, 136, "f7") + blue_head_ink(420, 92, 136, "f7b")
)

# Five tiles: start, crossing, step, head; bigger tiles so the X stays solid at 32.
X1L_ART = (
    ink_tile(150, 362, 96, MINT) + ink_tile(362, 362, 96, PEACH_T)
    + ink_tile(256, 256, 108, GOLD)
    + ink_tile(340, 172, 88, DEEP_SKY) + ink_tile(172, 172, 88, CORAL)
    + red_head_ink(92, 92, 140, "l5") + blue_head_ink(420, 92, 140, "l5b")
)


def make_final(art):
    def fn():
        icon = f'<rect width="512" height="512" rx="112" fill="{GROUND}"/>\n' + scaled(art, 0.9)
        mask = f'<rect width="512" height="512" fill="{GROUND}"/>\n' + scaled(art, 0.76)
        return icon, mask, art
    return fn


DIRS = {
    "a-faceoff": ("Duelwise: a player's cursor faces an agent's eye across a slash", "A, Face-off",
                  "Peach is the player's side, blue is the agents' side, the cream slash is the duel.", direction_a),
    "b-sideeye-d": ("Duelwise: a blue D with one side-glancing eye", "B, Side-eye D",
                    "The D is the agent. Its counter is a half-lidded eye looking at you, with a smirk under it.", direction_b),
    "c-climb": ("Duelwise: four stops climbing from Pip to Sable", "C, The Climb",
                "Pip, Marlow, Vesper and Sable as stepping tiles in their own tints, each bigger than the last.", direction_c),
    "c1-climb-to-d": ("Duelwise: three stops climbing to a blue D with a side-glancing eye", "C1, Climb to the D",
                      "Pip, Marlow and Vesper as stepping tiles; the last stop is the Side-eye D.", direction_c1),
    "c2-climb-in-d": ("Duelwise: a blue D with a side-glancing eye and three stops climbing inside it", "C2, Climb inside the D",
                      "The D holds the whole path; the eye is the last stop.", direction_c2),
    "x1-two-ds": ("Duelwise: two tile climbs cross, rising to a red D and a blue D facing each other", "X1, Two Ds",
                  "The agent's blue Side-eye D top right, a red mirrored D with an angry brow top left, three square stops crossing between them.", make_x(X1_ART)),
    "x2-q-and-d": ("Duelwise: two tile climbs cross, rising to a red Q and a blue D", "X2, Q and D",
                   "The agent's blue Side-eye D top right, a red Q whose counter is an eye top left, three square stops crossing between them.", make_x(X2_ART)),
    "x1-final": ("Duelwise: a red D and a blue D face off over two crossing tile climbs", "X1 final, seven tiles",
                 "Cream ground, ink outlines, mint to blue on the agent's climb, peach to coral on the challenger's, gold crossing.", make_final(X1F_ART)),
    "x1-final-lite": ("Duelwise: a red D and a blue D face off over two crossing tile climbs", "X1 final, five tiles",
                      "Same as x1-final with one fewer tile per side and bigger tiles.", make_final(X1L_ART)),
}

if __name__ == "__main__":
    for slug, (label, name, note, fn) in DIRS.items():
        icon, mask, mark = fn()
        for kind, body in (("icon", icon), ("maskable", mask), ("mark", mark)):
            path = os.path.join(HERE, f"{slug}-{kind}.svg")
            with open(path, "w") as f:
                f.write(wrap(label, name, note, body))
            print("wrote", path)
