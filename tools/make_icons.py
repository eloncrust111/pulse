"""Generates Pulse's app icons: a white basketball with a heartbeat seam on Portland purple.

Run: python tools/make_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "icons"
S = 1024  # master size, drawn at 2x then downsampled for smooth edges
SS = S * 2


def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return img


def make(ball_scale):
    bg = gradient(SS, (64, 46, 170), (22, 15, 66)).convert("RGBA")
    # soft glow behind the ball
    glow = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cx = cy = SS // 2
    r = int(SS * 0.34 * ball_scale)
    gd.ellipse([cx - r * 1.25, cy - r * 1.25, cx + r * 1.25, cy + r * 1.25], fill=(140, 120, 255, 90))
    bg.alpha_composite(glow.filter(ImageFilter.GaussianBlur(SS * 0.06)))

    # drop shadow
    sh = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse([cx - r, cy - r + SS * 0.02, cx + r, cy + r + SS * 0.02], fill=(8, 4, 30, 140))
    bg.alpha_composite(sh.filter(ImageFilter.GaussianBlur(SS * 0.02)))

    # ball
    ball = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    bd = ImageDraw.Draw(ball)
    bd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255))
    seam = (45, 32, 128, 255)
    w = int(r * 0.075)
    # side curves + vertical seam
    k = r * 1.55
    bd.arc([cx - r - k * 0.62 - k, cy - k, cx - r - k * 0.62 + k, cy + k], -38, 38, fill=seam, width=w)
    bd.arc([cx + r + k * 0.62 - k, cy - k, cx + r + k * 0.62 + k, cy + k], 142, 218, fill=seam, width=w)
    bd.line([(cx, cy - r), (cx, cy + r)], fill=seam, width=w)
    # the horizontal seam becomes a heartbeat line (the "pulse"), with a white keyline
    beat = [(-1.05, 0), (-0.42, 0), (-0.30, -0.16), (-0.18, 0), (-0.10, 0), (0.02, 0.30), (0.16, -0.62),
            (0.28, 0.16), (0.36, 0), (0.48, 0), (0.58, -0.13), (0.68, 0), (1.05, 0)]
    pts = [(cx + x * r, cy + y * r) for x, y in beat]
    bd.line(pts, fill=(255, 255, 255, 255), width=int(w * 3.2), joint="curve")
    bd.line(pts, fill=(83, 64, 201, 255), width=int(w * 1.6), joint="curve")
    for p in pts[1:-1]:  # round the corners
        rr = w * 0.8
        bd.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], fill=(83, 64, 201, 255))
    # clip seams to the ball
    mask = Image.new("L", (SS, SS), 0)
    ImageDraw.Draw(mask).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    ball.putalpha(Image.composite(ball.getchannel("A"), Image.new("L", (SS, SS), 0), mask))
    bg.alpha_composite(ball)
    return bg.convert("RGB").resize((S, S), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    std = make(1.0)
    maskable = make(0.78)  # keeps the ball inside Android's safe zone
    for size, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png"), (32, "favicon-32.png")]:
        std.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
    maskable.resize((512, 512), Image.LANCZOS).save(OUT / "icon-maskable-512.png", optimize=True)
    std.save(OUT / "icon-1024.png", optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
