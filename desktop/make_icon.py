"""Рисует иконки программы без сторонних библиотек: icons/icon.ico и PNG для Linux.

Картинка намеренно нейтральная: тёмный скруглённый квадрат, корпус клавиатуры и
три ряда клавиш — на 16 пикселах читается как «клавиатурная утилита», чужой знак
не используется. Рисуем в сетке 32 единицы и берём несколько отсчётов на пиксел
(см. samples()), поэтому один и тот же код даёт и 16, и 512 пикселов.
"""

import struct
import sys
import zlib
from pathlib import Path

GRID = 32

BG = (24, 28, 38, 255)
TILE = (43, 98, 217, 255)
KEY = (231, 233, 238, 255)
ACCENT = (74, 222, 128, 255)
CLEAR = (0, 0, 0, 0)

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
PNG_FILES = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512}


def inside_rounded(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    if (x < x0 + r or x > x1 - r) and (y < y0 + r or y > y1 - r):
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    return True


def pixel(x, y):
    """Цвет точки в координатах сетки 32x32."""
    if not inside_rounded(x, y, 0.5, 0.5, 31.5, 31.5, 7):
        return CLEAR
    color = TILE
    if inside_rounded(x, y, 5, 11, 27, 23, 3):
        color = BG
        for row, yy in enumerate((13, 16, 19.5)):
            for col in range(4 - row // 2):
                xx = 7 + col * 5 + row
                if xx <= x <= xx + 3.5 and yy <= y <= yy + 2:
                    color = KEY if row < 2 else ACCENT
    return color


def samples(size: int) -> int:
    """Мелкие картинки считаем плотно, крупные — быстрее: отсчётов на пиксел по оси."""
    return 4 if size <= 64 else (2 if size <= 256 else 1)


def render_rgba(size: int) -> bytes:
    """Пикселы RGBA построчно сверху вниз с усреднением по нарисованным точкам."""
    out = bytearray()
    step = GRID / size
    ss = samples(size)
    for py in range(size):
        for px in range(size):
            rs = gs = bs = 0
            covered = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) * step
                    y = (py + (sy + 0.5) / ss) * step
                    r, g, b, a = pixel(x, y)
                    if a:
                        rs += r
                        gs += g
                        bs += b
                        covered += 1
            if covered == 0:
                out += bytes((0, 0, 0, 0))
            elif covered == ss * ss:
                n = ss * ss
                out += bytes((rs // n, gs // n, bs // n, 255))
            else:
                # частичное покрытие: цвет средний, альфа — доля нарисованных точек
                out += bytes((rs // covered, gs // covered, bs // covered, covered * 255 // (ss * ss)))
    return bytes(out)


def build_png(path: Path, size: int) -> None:
    raw = render_rgba(size)
    rows = b"".join(b"\x00" + raw[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def ico_entry(size: int) -> tuple[bytes, bytes]:
    """32-битный BMP-вход .ico: BGRA снизу вверх + пустая AND-маска (всё непрозрачное)."""
    raw = render_rgba(size)
    pixels = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            r, g, b, a = raw[(y * size + x) * 4:(y * size + x) * 4 + 4]
            pixels += bytes((b, g, r, a))
    # AND-маска: строки выравниваются по 4 байта, у нас всё прозрачное помечено в BGRA
    row_bytes = ((size + 31) // 32) * 4
    and_mask = bytes(row_bytes * size)
    bmp = struct.pack(
        "<IiiHHIIiiII",
        40,
        size,
        size * 2,
        1,
        32,
        0,
        len(pixels) + len(and_mask),
        0,
        0,
        0,
        0,
    ) + bytes(pixels) + and_mask
    header = struct.pack(
        "<BBBBHHII",
        size % 256,
        size % 256,
        0,
        0,
        1,
        32,
        len(bmp),
        0,  # смещение допишем позже
    )
    return header, bmp


def build_ico(path: Path, sizes=ICO_SIZES) -> None:
    entries = [ico_entry(s) for s in sizes]
    offset = 6 + 16 * len(entries)
    blob = struct.pack("<HHH", 0, 1, len(entries))
    data = b""
    for header, bmp in entries:
        w, h, colors, res, planes, bpp, length, _ = struct.unpack("<BBBBHHII", header)
        blob += struct.pack("<BBBBHHII", w, h, colors, res, planes, bpp, length, offset)
        data += bmp
        offset += len(bmp)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob + data)


def main() -> None:
    icons = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "icons"
    build_ico(icons / "icon.ico")
    print(f"{icons / 'icon.ico'}: {len(ICO_SIZES)} размеров, {(icons / 'icon.ico').stat().st_size} байт")
    for name, size in PNG_FILES.items():
        build_png(icons / name, size)
        print(f"{icons / name}: {size}x{size}, {(icons / name).stat().st_size} байт")


if __name__ == "__main__":
    main()
