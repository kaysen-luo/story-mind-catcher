#!/usr/bin/env python3
"""Generate placeholder PWA icons for MVS-013 (T3).
Produces 192/512 regular + 512 maskable PNG in public/icons/.
T4 will replace with proper designed icons.
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
os.makedirs(OUT, exist_ok=True)

BG = (20, 20, 28)          # #14141c
FG = (74, 158, 255)        # #4a9eff

# Try a few fonts likely present on macOS
FONT_CANDIDATES = [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
]

def get_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def draw_icon(size, char='书', scale=0.55):
    img = Image.new('RGBA', (size, size), BG + (255,))
    draw = ImageDraw.Draw(img)
    font_size = int(size * scale)
    font = get_font(font_size)
    # Center text
    bbox = draw.textbbox((0, 0), char, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1]
    draw.text((x, y), char, font=font, fill=FG + (255,))
    return img

# regular icons (edge-to-edge char)
for s in (192, 512):
    p = os.path.join(OUT, f'icon-{s}.png')
    draw_icon(s, scale=0.60).save(p, 'PNG')
    print('wrote', p, os.path.getsize(p), 'bytes')

# maskable: shrink content to ~70% (safe zone is inner 80%)
p = os.path.join(OUT, 'icon-512-maskable.png')
draw_icon(512, scale=0.42).save(p, 'PNG')
print('wrote', p, os.path.getsize(p), 'bytes')

# also apple-touch-icon (180)
p = os.path.join(OUT, 'apple-touch-icon.png')
draw_icon(180, scale=0.60).save(p, 'PNG')
print('wrote', p, os.path.getsize(p), 'bytes')
