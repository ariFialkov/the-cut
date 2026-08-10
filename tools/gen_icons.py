#!/usr/bin/env python3
"""Generate the PWA icons (flag on a green) without any image libraries."""

import os
import struct
import zlib


def png_bytes(size, pixels):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    raw = b""
    for y in range(size):
        raw += b"\x00" + bytes(v for x in range(size) for v in pixels(x, y))
    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    out += chunk(b"IDAT", zlib.compress(raw, 9))
    out += chunk(b"IEND", b"")
    return out


BG = (12, 21, 18)
GREEN = (53, 224, 124)
POLE = (242, 246, 243)
FLAG = (255, 90, 78)


def make(size, maskable=False):
    s = size
    pad = 0.12 if maskable else 0.0

    def px(x, y):
        u = x / s
        v = y / s
        # background
        r, g, b = BG
        # rounded-square backdrop for non-maskable too (looks fine everywhere)
        # green mound at the bottom
        mound = 0.78 - 0.06 * (2 * (u - 0.5)) ** 2
        if v > mound + pad * 0.3:
            r, g, b = (24, 94, 52)
        # flag pole
        px_x = 0.42
        pw = max(1.5 / s, 0.018)
        if abs(u - px_x) < pw and (0.16 + pad) < v < (0.80 + pad * 0.2):
            r, g, b = POLE
        # flag triangle (pointing right)
        fx0, fy0 = px_x + pw, 0.16 + pad
        fh = 0.20
        fw = 0.30 * (1 - pad)
        if fx0 <= u <= fx0 + fw:
            k = 1 - (u - fx0) / fw
            if fy0 + (1 - k) * fh * 0.5 <= v <= fy0 + fh - (1 - k) * fh * 0.5:
                r, g, b = FLAG
        # ball
        bx, by, br = 0.62, 0.84 - pad * 0.2, 0.05
        if (u - bx) ** 2 + (v - by) ** 2 < br**2:
            r, g, b = POLE
        # accent ring
        d2 = (u - 0.5) ** 2 + (v - 0.5) ** 2
        ring = 0.47 - pad * 0.5
        if not maskable and ring**2 < d2 < (ring + 0.02) ** 2:
            r, g, b = GREEN
        return (r, g, b)

    return png_bytes(s, px)


out = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "icon-192.png"), "wb") as f:
    f.write(make(192))
with open(os.path.join(out, "icon-512.png"), "wb") as f:
    f.write(make(512))
with open(os.path.join(out, "icon-maskable-512.png"), "wb") as f:
    f.write(make(512, maskable=True))
print("icons written")
