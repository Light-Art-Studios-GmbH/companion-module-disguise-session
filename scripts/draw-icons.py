"""Draws the button icons (white glyphs on transparent background) into scripts/icons/*.png.
Run: python3 scripts/draw-icons.py && npm run icons"""
from PIL import Image, ImageDraw
import os, math

S = 96          # output size
SS = 4          # supersampling
W = S * SS
OUT = os.path.join(os.path.dirname(__file__), 'icons')
os.makedirs(OUT, exist_ok=True)
WHITE = (255, 255, 255, 255)

def canvas():
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)

def save(im, name):
    im = im.resize((S, S), Image.LANCZOS)
    im.save(os.path.join(OUT, name + '.png'))

def tri(d, x0, x1, cy, h, right=True):
    """Filled triangle between x0..x1 (points right when right=True)."""
    if right:
        d.polygon([(x0, cy - h / 2), (x1, cy), (x0, cy + h / 2)], fill=WHITE)
    else:
        d.polygon([(x1, cy - h / 2), (x0, cy), (x1, cy + h / 2)], fill=WHITE)

def bar(d, x, cy, h, w):
    d.rectangle([x, cy - h / 2, x + w, cy + h / 2], fill=WHITE)

u = W / 96.0   # one "design pixel" (96 grid)
cy = W / 2

# play
im, d = canvas(); tri(d, 30*u, 72*u, cy, 48*u); save(im, 'play')
# stop
im, d = canvas(); d.rounded_rectangle([28*u, 28*u, 68*u, 68*u], radius=4*u, fill=WHITE); save(im, 'stop')
# play to end of section: triangle + thick bar
im, d = canvas(); tri(d, 22*u, 58*u, cy, 44*u); bar(d, 64*u, cy, 44*u, 10*u); save(im, 'play_section')
# loop: circular arrow
im, d = canvas()
d.arc([26*u, 26*u, 70*u, 70*u], start=300, end=240, fill=WHITE, width=int(8*u))
# arrow head at the gap end (angle 240deg measured PIL-style: 0 = 3 o'clock, clockwise)
a = math.radians(240); r = 22*u; cx = 48*u
px, py = cx + r*math.cos(a), cy + r*math.sin(a)
d.polygon([(px-10*u, py-6*u), (px+8*u, py-4*u), (px-4*u, py+12*u)], fill=WHITE)
save(im, 'loop')
# previous section: bar + triangle left
im, d = canvas(); bar(d, 24*u, cy, 44*u, 8*u); tri(d, 36*u, 74*u, cy, 44*u, right=False); save(im, 'prev_section')
# next section: triangle right + bar
im, d = canvas(); tri(d, 22*u, 60*u, cy, 44*u); bar(d, 64*u, cy, 44*u, 8*u); save(im, 'next_section')
# previous track: bar + two triangles left
im, d = canvas(); bar(d, 16*u, cy, 40*u, 7*u); tri(d, 26*u, 54*u, cy, 40*u, right=False); tri(d, 54*u, 82*u, cy, 40*u, right=False); save(im, 'prev_track')
# next track: two triangles right + bar
im, d = canvas(); tri(d, 14*u, 42*u, cy, 40*u); tri(d, 42*u, 70*u, cy, 40*u); bar(d, 73*u, cy, 40*u, 7*u); save(im, 'next_track')
# return to start: bar + triangle left + baseline
im, d = canvas(); bar(d, 24*u, cy-4*u, 36*u, 8*u); tri(d, 36*u, 72*u, cy-4*u, 36*u, right=False); d.rectangle([24*u, 64*u, 72*u, 71*u], fill=WHITE); save(im, 'return_to_start')
print('icons written to', OUT)
