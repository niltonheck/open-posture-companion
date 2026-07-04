"""Regenerate the Expo icon set from the normalized logo-mark.svg.

Each old asset was measured (mark bbox + bg): all marks are centered, so we
render the SVG at the exact scale that reproduces each mark height, crop to
the mark's alpha bbox, and composite it centered. No resampling.
"""
import zlib, struct, subprocess, os

SRC = '/Volumes/WD_BLACK_SN850X_1TB/code/pessoal/open-posture-companion/assets/images/logo-mark.svg'
OUT = '/Volumes/WD_BLACK_SN850X_1TB/code/pessoal/open-posture-companion/assets/images'
S = os.path.dirname(os.path.abspath(__file__))

def read_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    pos = 8; idat = b''; w = h = ct = bd = None
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos+4])[0]
        typ = d[pos+4:pos+8]; data = d[pos+8:pos+8+ln]; pos += 12 + ln
        if typ == b'IHDR': w, h, bd, ct = struct.unpack('>IIBB', data[:10])
        elif typ == b'IDAT': idat += data
        elif typ == b'IEND': break
    assert bd == 8 and ct in (2, 6), f'unsupported png {bd} {ct}'
    nb = 4 if ct == 6 else 3
    raw = zlib.decompress(idat)
    stride = w * nb
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        f = raw[pos]; row = bytearray(raw[pos+1:pos+1+stride]); pos += 1 + stride
        if f == 1:
            for i in range(nb, stride): row[i] = (row[i] + row[i-nb]) & 255
        elif f == 2:
            for i in range(stride): row[i] = (row[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                row[i] = (row[i] + ((row[i-nb] if i >= nb else 0) + prev[i]) // 2) & 255
        elif f == 4:
            for i in range(stride):
                a = row[i-nb] if i >= nb else 0; b = prev[i]; c = prev[i-nb] if i >= nb else 0
                p = a + b - c; pa = abs(p-a); pb = abs(p-b); pc = abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                row[i] = (row[i] + pr) & 255
        prev = row
        for x in range(w):
            i = x * nb; j = (y * w + x) * 4
            out[j:j+3] = row[i:i+3]
            out[j+3] = row[i+3] if nb == 4 else 255
    return w, h, out

def write_png(path, w, h, rgba):
    raw = bytearray()
    for y in range(h):
        raw.append(0); raw += rgba[y*w*4:(y+1)*w*4]
    def chunk(t, dd):
        return struct.pack('>I', len(dd)) + t + dd + struct.pack('>I', zlib.crc32(t + dd) & 0xffffffff)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)

def bbox(w, h, rgba, thresh=8):
    x0 = y0 = 10**9; x1 = y1 = -1
    for y in range(h):
        base = y * w * 4
        for x in range(w):
            if rgba[base + x*4 + 3] >= thresh:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return x0, y0, x1, y1

def render(size):
    p = f'{S}/render_{size}.png'
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), SRC, '-o', p], check=True)
    return read_png(p)

# Reference render: mark height in px per canvas px
rw, rh, rpx = render(264)
rb = bbox(rw, rh, rpx)
ref_mark_h = rb[3] - rb[1] + 1
print(f'reference 264: bbox={rb} mark_h={ref_mark_h}')

BG = (0xFF, 0xFD, 0xF8)  # cardSoftCream

def make(name, canvas, mark_h, background=None, white=False):
    size = round(264 * mark_h / ref_mark_h)
    w, h, px = render(size)
    x0, y0, x1, y1 = bbox(w, h, px)
    mw, mh = x1 - x0 + 1, y1 - y0 + 1
    left, top = (canvas - mw) // 2, (canvas - mh) // 2
    out = bytearray(canvas * canvas * 4)
    if background:
        r, g, b = background
        for i in range(0, len(out), 4):
            out[i], out[i+1], out[i+2], out[i+3] = r, g, b, 255
    for y in range(mh):
        srow = ((y0 + y) * w + x0) * 4
        drow = ((top + y) * canvas + left) * 4
        for x in range(mw):
            si = srow + x*4; di = drow + x*4
            a = px[si+3]
            if a == 0: continue
            if white:
                fr = fg = fb = 255
            else:
                fr, fg, fb = px[si], px[si+1], px[si+2]
            if background:
                ia = 255 - a
                out[di]   = (fr * a + out[di]   * ia + 127) // 255
                out[di+1] = (fg * a + out[di+1] * ia + 127) // 255
                out[di+2] = (fb * a + out[di+2] * ia + 127) // 255
            else:
                out[di], out[di+1], out[di+2], out[di+3] = fr, fg, fb, a
    write_png(f'{OUT}/{name}', canvas, canvas, out)
    print(f'{name}: canvas={canvas} render={size} mark={mw}x{mh} at ({left},{top})')

make('icon.png', 1024, 639, background=BG)
make('splash-icon.png', 1024, 639)
make('android-icon-foreground.png', 1024, 593)
make('android-icon-monochrome.png', 1024, 593, white=True)
make('favicon.png', 48, 30, background=BG)
print('done')
