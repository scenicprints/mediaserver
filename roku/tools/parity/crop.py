# crop.py name x y w h [scale]  (CSS px) -> out/<name>-crop.png, web on top, roku below
import sys
from PIL import Image
n, x, y, w, h = sys.argv[1], *map(float, sys.argv[2:6])
sc = float(sys.argv[6]) if len(sys.argv) > 6 else 1
a = Image.open(f'out/{n}.web.png').convert('RGB'); b = Image.open(f'out/{n}.roku.png').convert('RGB')
box = tuple(int(v * 2) for v in (x, y, x + w, y + h))
ca, cb = a.crop(box), b.crop(box)
W, H = ca.size
out = Image.new('RGB', (W, H * 2 + 4), (255, 0, 255))
out.paste(ca, (0, 0)); out.paste(cb, (0, H + 4))
if sc != 1: out = out.resize((int(out.width * sc), int(out.height * sc)), Image.LANCZOS)
out.save(f'out/{n}-crop.png')
