"""Regenerates favicon/PWA icons from .qa/assets/cv-heart-icon-flat.png."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / ".qa/assets/cv-heart-icon-flat.png"
OUT = ROOT / "public/icons"
OUT.mkdir(exist_ok=True)


def rounded_mask(size, radius_ratio=0.20, ss=4):
    big = size * ss
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=int(big * radius_ratio), fill=255
    )
    return mask.resize((size, size), Image.LANCZOS)


def resized(size, with_mask):
    im = master.resize((size, size), Image.LANCZOS)
    if with_mask:
        im.putalpha(rounded_mask(size))
    return im


master = Image.open(SRC).convert("RGBA")

# Tab icons keep transparent corners so they sit cleanly on any browser chrome.
for size in (16, 32, 48):
    resized(size, True).save(OUT / f"favicon-{size}.png", optimize=True)

resized(256, True).save(
    ROOT / "public/favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)]
)

# Home-screen / installed icons stay full-bleed: the OS applies its own mask.
for size, name in ((180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")):
    resized(size, False).save(OUT / name, optimize=True)

# Contact sheet for eyeballing small sizes (not shipped).
sheet = Image.new("RGB", (16 * 6 + 32 * 3 + 48 * 2 + 80, 48), "#eef0f4")
x = 10
for size in (16, 32, 48):
    icon = resized(size, True)
    for scale in (1, 2, 3):
        big = icon.resize((size * scale, size * scale), Image.NEAREST)
        if big.height <= 48:
            sheet.paste(big, (x, 24 - big.height // 2), big)
            x += big.width + 8
sheet.save(ROOT / ".qa/screens/icons_contact_sheet.png")

for p in sorted(OUT.iterdir()):
    print(p.name, p.stat().st_size, "bytes")
