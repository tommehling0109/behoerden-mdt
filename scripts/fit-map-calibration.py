"""Kalibrierung der Kachelkarte (Satellit) anhand der Postal-Karte (public/img/map.webp, deren Postal-Daten exakt passen): Wasser/Land-Masken ausrichten.
Aufruf: python scripts/fit-map-calibration.py public/img/map.webp  (benötigt Pillow und Internet für die Kacheln)
Ergebnis: Werte für map.calib_scale / map.calib_x / map.calib_y."""
import io, os, sys, urllib.request
from PIL import Image, ImageChops

Z = 3
N = 2 ** Z
TS = 256 * N
CACHE = os.path.join(os.environ.get('TEMP', '.'), 'atlas_z3.png')
if os.path.exists(CACHE):
    atlas = Image.open(CACHE).convert('RGB')
else:
    atlas = Image.new('RGB', (TS, TS))
    for x in range(N):
        for y in range(N):
            url = f'https://viruxe.github.io/gtav-map-tiles/satelite/{Z}/{x}-{y}.webp'
            data = urllib.request.urlopen(url, timeout=30).read()
            atlas.paste(Image.open(io.BytesIO(data)).convert('RGB'), (x * 256, y * 256))
    atlas.save(CACHE)
print('Atlas', atlas.size)

img = Image.open(sys.argv[1]).convert('RGB')
IW, IH = img.size
print('Bild', img.size)

def water(im):
    r, g, b = im.split()
    a = ImageChops.subtract(b, r).point(lambda v: 255 if v > 18 else 0)
    c = ImageChops.subtract(g, b).point(lambda v: 255 if v <= 4 else 0)
    return ImageChops.darker(a, c)

amask, imask = water(atlas), water(img)

def best_fit(res, s_list, ox_range, oy_range):
    """res = Verkleinerungsfaktor des Bildes; Atlas wird passend skaliert (Bildpixel-Einheiten / res)."""
    iw, ih = IW // res, IH // res
    im = imask.resize((iw, ih), Image.NEAREST)
    best = (10 ** 12, None)
    pad = 80
    for s in s_list:
        k = 1.0 / (res * s)  # Atlas z3 px -> Bildpixel/res
        size = int(TS * k)
        am = amask.resize((size, size), Image.NEAREST)
        big = Image.new('L', (size + 2 * pad, size + 2 * pad), 0)
        big.paste(am, (pad, pad))
        for oy in oy_range:
            for ox in ox_range:
                crop = big.crop((ox + pad, oy + pad, ox + pad + iw, oy + pad + ih))
                mism = ImageChops.difference(crop, im).histogram()[255]
                if mism < best[0]:
                    best = (mism, (s, ox, oy))
        # (Fortschritt)
    return best, iw * ih

s0 = (0.6465 / 0.1485) / 4
tx0 = (3914.5 - 613 * (0.6465 / 0.1485)) / 4
ty0 = (5566.5 - 1246.2 * (0.6465 / 0.1485)) / 4
res = 8
# grob: Offsets in Einheiten Bildpixel/res:  ox = t / (res * s)
ox0, oy0 = tx0 / (res * s0), ty0 / (res * s0)
(b, p), n = best_fit(res, [s0 + d * 0.005 for d in range(-20, 21)], range(int(ox0) - 40, int(ox0) + 41), range(max(-70, int(oy0) - 40), int(oy0) + 41))
print('grob', b / n, p)
s1, ox1, oy1 = p
res = 4
ox1, oy1 = ox1 * 2, oy1 * 2
(b, p), n = best_fit(res, [s1 + d * 0.002 for d in range(-6, 7)], range(ox1 - 5, ox1 + 6), range(oy1 - 5, oy1 + 6))
print('mittel', b / n, p)
s2, ox2, oy2 = p
res = 2
ox2, oy2 = ox2 * 2, oy2 * 2
(b, p), n = best_fit(res, [s2 + d * 0.0007 for d in range(-4, 5)], range(ox2 - 4, ox2 + 5), range(oy2 - 4, oy2 + 5))
print('fein', b / n, p)
s, ox, oy = p
t_x, t_y = ox * res * s, oy * res * s
S, X, Y = 0.1485, 613.0, 1246.2
f = 4  # Zoom 5 = 4 x Zoom 3
print(f'NEU calib_scale={f * s * S:.4f} calib_x={f * (s * X + t_x):.1f} calib_y={f * (s * Y + t_y):.1f}   (alt 0.6465 / 3914.5 / 5566.5)')
