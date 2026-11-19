"""Быстрая проверка собранных иконок: размеры, прозрачные углы, узнаваемость рисунка."""
import struct
import zlib
import pathlib


def load_png(path):
    d = pathlib.Path(path).read_bytes()
    assert d[:8] == b"\x89PNG\r\n\x1a\n", f"{path}: не PNG"
    pos, idat, w, h = 8, b"", 0, 0
    while pos < len(d):
        ln, tag = struct.unpack(">I4s", d[pos:pos + 8])
        body = d[pos + 8:pos + 8 + ln]
        if tag == b"IHDR":
            w, h = struct.unpack(">II", body[:8])
        elif tag == b"IDAT":
            idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * 4
    prev = bytearray(stride)
    out = bytearray()
    y = 0
    for _ in range(h):
        ft = raw[y]
        y += 1
        line = bytearray(raw[y:y + stride])
        y += stride
        for i in range(stride):
            a = line[i - 4] if i >= 4 else 0
            b = prev[i]
            c = prev[i - 4] if i >= 4 else 0
            if ft == 1:
                line[i] = (line[i] + a) & 255
            elif ft == 2:
                line[i] = (line[i] + b) & 255
            elif ft == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif ft == 4:
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        prev = line
        out += line
    return w, h, out


for name in ("32x32.png", "128x128.png", "128x128@2x.png", "icon.png"):
    w, h, buf = load_png("icons/" + name)

    def at(x, y):
        i = (y * w + x) * 4
        return tuple(buf[i:i + 4])

    lights = sum(1 for i in range(3, len(buf), 4) if buf[i] > 200)
    print(f"{name}: {w}x{h}, угол={at(0, 0)}, центр={at(w // 2, h // 2)}, "
          f"светлых пикселов={lights} ({100 * lights / (w * h):.1f}%)")

ico = pathlib.Path("icons/icon.ico").read_bytes()
cnt = struct.unpack("<H", ico[4:6])[0]
sizes = [(ico[6 + i * 16] or 256) for i in range(cnt)]
offsets_ok = all(struct.unpack("<I", ico[6 + i * 16 + 12:6 + i * 16 + 16])[0] > 0 for i in range(cnt))
print(f"icon.ico: записей={cnt}, размеры={sizes}, смещения заполнены={offsets_ok}")
