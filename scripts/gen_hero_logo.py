"""Tightly-cropped hero logo: mark 600px tall on a 624px transparent canvas
(3x of the 208pt display size), rendered from the normalized logo-mark.svg."""
import zlib, struct, subprocess, os

S = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(S)
SRC = os.path.join(ROOT, 'assets/images/logo-mark.svg')
OUT = os.path.join(ROOT, 'assets/images/logo-hero.png')

def read_png(path):
    d = open(path, 'rb').read()
    pos = 8; idat = b''
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos+4])[0]
        typ = d[pos+4:pos+8]; data = d[pos+8:pos+8+ln]; pos += 12 + ln
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', data[:10]); assert bd == 8 and ct == 6
        elif typ == b'IDAT': idat += data
    raw = zlib.decompress(idat); stride = w * 4
    out = bytearray(w * h * 4); prev = bytearray(stride); pos = 0
    for y in range(h):
        f = raw[pos]; row = bytearray(raw[pos+1:pos+1+stride]); pos += 1 + stride
        if f == 1:
            for i in range(4, stride): row[i] = (row[i] + row[i-4]) & 255
        elif f == 2:
            for i in range(stride): row[i] = (row[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                row[i] = (row[i] + ((row[i-4] if i >= 4 else 0) + prev[i]) // 2) & 255
        elif f == 4:
            for i in range(stride):
                a = row[i-4] if i >= 4 else 0; b = prev[i]; c = prev[i-4] if i >= 4 else 0
                p = a + b - c; pa = abs(p-a); pb = abs(p-b); pc = abs(p-c)
                row[i] = (row[i] + (a if (pa <= pb and pa <= pc) else (b if pb <= pc else c))) & 255
        prev = row
        out[y*stride:(y+1)*stride] = row
    return w, h, out

def write_png(path, w, h, rgba):
    raw = bytearray()
    for y in range(h):
        raw.append(0); raw += rgba[y*w*4:(y+1)*w*4]
    def chunk(t, dd):
        return struct.pack('>I', len(dd)) + t + dd + struct.pack('>I', zlib.crc32(t + dd) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))

def bbox(w, h, rgba, thresh=8):
    x0 = y0 = 10**9; x1 = y1 = -1
    for y in range(h):
        base = y * w * 4
        for x in range(w):
            if rgba[base + x*4 + 3] >= thresh:
                x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
    return x0, y0, x1, y1

def render(size):
    p = f'{S}/hero_render_{size}.png'
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), SRC, '-o', p], check=True)
    return read_png(p)

# reference: mark is 166px tall in a 264px render
MARK_H, CANVAS = 600, 624
size = round(264 * MARK_H / 166)
w, h, px = render(size)
x0, y0, x1, y1 = bbox(w, h, px)
mw, mh = x1 - x0 + 1, y1 - y0 + 1
left, top = (CANVAS - mw) // 2, (CANVAS - mh) // 2
out = bytearray(CANVAS * CANVAS * 4)
for y in range(mh):
    si = ((y0 + y) * w + x0) * 4
    di = ((top + y) * CANVAS + left) * 4
    out[di:di+mw*4] = px[si:si+mw*4]
write_png(OUT, CANVAS, CANVAS, out)
print(f'logo-hero.png: canvas={CANVAS} render={size} mark={mw}x{mh} at ({left},{top})')
