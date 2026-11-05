#!/usr/bin/env python3
"""The settings page's empty-state recording, step 2: animate the captures of scripts/add-site-demo.mjs.

A plain browser window around a skeleton page; the cursor clicks OnlyRead's toolbar icon, the real popup opens,
the cursor clicks "Guard this site", and the popup turns On. One loop, light and dark, written as animated WebP to
extension/assets/add-site-{light,dark}.webp (needs Pillow and img2webp from libwebp).

    node scripts/add-site-demo.mjs && python3 scripts/add-site-demo.py
"""
from __future__ import annotations

import json
import math
import pathlib
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "test-results" / "add-site-demo"
OUT = ROOT / "extension" / "assets"
W, H = 1120, 700  # 2x of the 560 x 350 the page shows
TAB_H, BAR_H = 52, 60
FPS = 20

THEMES = {
    "light": {"frame": (222, 225, 232), "bar": (246, 247, 250), "tab": (255, 255, 255), "omni": (236, 238, 243),
              "text": (60, 64, 74), "mut": (120, 126, 140), "cursor": (20, 20, 24), "edge": (255, 255, 255)},
    "dark": {"frame": (24, 26, 32), "bar": (38, 41, 49), "tab": (52, 56, 66), "omni": (28, 30, 36),
             "text": (225, 228, 235), "mut": (150, 156, 170), "cursor": (250, 250, 252), "edge": (20, 20, 24)},
}


def font(size: int) -> ImageFont.FreeTypeFont:
    for f in ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def window(theme: str) -> tuple[Image.Image, tuple[int, int]]:
    """The browser around the page, and the centre of OnlyRead's toolbar icon."""
    c = THEMES[theme]
    im = Image.new("RGB", (W, H), c["frame"])
    d = ImageDraw.Draw(im)
    for i, col in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse((22 + i * 26, 18, 36 + i * 26, 32), fill=col)
    d.rounded_rectangle((110, 8, 420, TAB_H + 8), radius=12, fill=c["bar"])
    d.rounded_rectangle((128, 22, 148, 42), radius=5, fill=c["mut"])  # the tab: a placeholder icon and title
    d.rounded_rectangle((158, 26, 300, 38), radius=6, fill=c["omni"])
    d.rectangle((0, TAB_H, W, TAB_H + BAR_H), fill=c["bar"])
    d.rounded_rectangle((120, TAB_H + 12, W - 140, TAB_H + BAR_H - 12), radius=18, fill=c["omni"])
    d.text((150, TAB_H + 20), "example.com", font=font(21), fill=c["text"])
    for i in range(3):  # back, forward, reload, as dots of the same weight
        d.ellipse((24 + i * 30, TAB_H + 26, 34 + i * 30, TAB_H + 36), outline=c["mut"], width=3)
    icon = Image.open(ROOT / "extension" / "assets" / "icon-48.png").convert("RGBA").resize((36, 36), Image.LANCZOS)
    ix, iy = W - 110, TAB_H + 12
    im.paste(icon, (ix, iy), icon)
    d.rounded_rectangle((W - 58, TAB_H + 16, W - 30, TAB_H + 44), radius=7, outline=c["mut"], width=3)  # extensions menu
    page = Image.open(SRC / f"site-{theme}.png").convert("RGB")
    page = page.resize((W, round(page.height * W / page.width)), Image.LANCZOS)
    im.paste(page.crop((0, 0, W, H - TAB_H - BAR_H)), (0, TAB_H + BAR_H))
    return im, (ix + 18, iy + 18)


def cursor(d: ImageDraw.ImageDraw, x: float, y: float, c: dict) -> None:
    s = 1.6
    pts = [(0, 0), (0, 26), (6.5, 20), (11, 30), (15, 28), (10.5, 18.5), (19, 18.5)]
    poly = [(x + px * s, y + py * s) for px, py in pts]
    d.polygon(poly, fill=c["cursor"], outline=c["edge"], width=3)


def ease(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 0.5 - 0.5 * math.cos(math.pi * t)


def frames(theme: str, box: dict) -> list[Image.Image]:
    c = THEMES[theme]
    base, icon_at = window(theme)
    before = Image.open(SRC / f"popup-before-{theme}.png").convert("RGB")
    after = Image.open(SRC / f"popup-after-{theme}.png").convert("RGB")
    scale = 520 / before.width
    pw = 520
    before = before.resize((pw, round(before.height * scale)), Image.LANCZOS)
    after = after.resize((pw, round(after.height * scale)), Image.LANCZOS)
    px, py = W - pw - 16, TAB_H + BAR_H - 6
    g = box["guard"]
    guard_at = (px + (g["x"] + g["width"] / 2) * 2 * scale, py + (g["y"] + g["height"] / 2) * 2 * scale)
    start = (W * 0.42, H * 0.62)

    def shadowed(card: Image.Image, frame: Image.Image, alpha: float) -> None:
        shadow = Image.new("RGBA", (card.width + 40, card.height + 40), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle((20, 24, card.width + 20, card.height + 24), radius=16, fill=(0, 0, 0, int(70 * alpha)))
        frame.paste(shadow, (px - 20, py - 20), shadow)
        mask = Image.new("L", card.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, card.width - 1, card.height - 1), radius=16, fill=int(255 * alpha))
        frame.paste(card, (px, py), mask)

    out: list[Image.Image] = []
    # (seconds, what): rest, move to the icon, click, popup opens, rest, move to the button, click, On, hold, close
    plan = [(0.7, "rest"), (0.9, "to-icon"), (0.25, "click-icon"), (0.3, "open"), (0.4, "show"), (0.9, "to-guard"),
            (0.25, "click-guard"), (0.25, "swap"), (1.8, "on"), (0.35, "close")]
    pos = start
    for secs, step in plan:
        n = max(1, round(secs * FPS))
        for i in range(n):
            t = (i + 1) / n
            f = base.copy()
            d = ImageDraw.Draw(f)
            card, alpha, ring = None, 1.0, None
            if step == "to-icon":
                pos = (start[0] + (icon_at[0] - start[0]) * ease(t), start[1] + (icon_at[1] - start[1]) * ease(t))
            elif step == "click-icon":
                pos, ring = icon_at, t
            elif step == "open":
                card, alpha = before, ease(t)
            elif step in ("show",):
                card = before
            elif step == "to-guard":
                card = before
                pos = (icon_at[0] + (guard_at[0] - icon_at[0]) * ease(t), icon_at[1] + (guard_at[1] - icon_at[1]) * ease(t))
            elif step == "click-guard":
                card, pos, ring = before, guard_at, t
            elif step == "swap":
                card = after  # the popup redraws at once, as the real one does
            elif step == "on":
                card = after
            elif step == "close":
                card, alpha = after, 1 - ease(t)
                pos = (guard_at[0] + (start[0] - guard_at[0]) * ease(t), guard_at[1] + (start[1] - guard_at[1]) * ease(t))
            if card is not None:
                shadowed(card, f, alpha)
            if ring is not None:
                r = 10 + 26 * ring
                d.ellipse((pos[0] - r, pos[1] - r, pos[0] + r, pos[1] + r), outline=(219, 39, 119), width=max(1, round(5 * (1 - ring))) )
            cursor(d, pos[0], pos[1], c)
            out.append(f)
    return out


def write(theme: str, box: dict) -> pathlib.Path:
    fs = frames(theme, box)
    dest = OUT / f"add-site-{theme}.webp"
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for i, f in enumerate(fs):
            p = pathlib.Path(tmp) / f"{i:04d}.png"
            f.save(p)
            paths.append(str(p))
        subprocess.run(["img2webp", "-loop", "0", "-lossy", "-q", "88", "-m", "4", "-d", str(1000 // FPS), *paths, "-o", str(dest)], check=True, capture_output=True)
    return dest


if __name__ == "__main__":
    if not shutil.which("img2webp"):
        raise SystemExit("img2webp not found (brew install webp)")
    boxes = json.loads((SRC / "boxes.json").read_text())
    for theme in ("light", "dark"):
        p = write(theme, boxes[theme])
        print(f"{p.relative_to(ROOT)}: {p.stat().st_size // 1024} KB")
