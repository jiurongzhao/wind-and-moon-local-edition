#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
genicons.py —— 生成图标的 PNG 位图（mdpi~xxxhdpi）。

为什么要自己写：Termux 里没有 PIL / ImageMagick，而 Android 24~25 不认矢量启动图标，
必须有 PNG 兜底。所以这里手写一个最小 PNG 编码器 + 2x 超采样抗锯齿。

图形与 res/drawable/ic_launcher_foreground.xml 保持一致：
深紫圆角底 + 一轮弯月 + 三颗星（全部自绘，无第三方素材，上架不用管图标许可）。

用法: python3 tools/genicons.py
"""
import os
import struct
import zlib

# ---------- 调色 ----------
BG_TOP = (0x22, 0x1A, 0x3D)      # 背景渐变：上
BG_BOTTOM = (0x12, 0x0E, 0x22)   # 背景渐变：下
MOON = (0xF2, 0xEC, 0xFF)
STAR_A = (0x8E, 0x7B, 0xFF)
STAR_B = (0x5A, 0xD1, 0xC8)

SIZES = {
    'mdpi': 48,
    'hdpi': 72,
    'xhdpi': 96,
    'xxhdpi': 144,
    'xxxhdpi': 192,
}

SS = 3          # 超采样倍数


def blend(dst, src, a):
    return tuple(int(round(dst[i] * (1 - a) + src[i] * a)) for i in range(3))


def inside_round_rect(x, y, w, h, r):
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def in_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size, round_icon):
    """返回 (w, h, RGBA bytes)"""
    n = size * SS
    w = h = n
    px = [[(0, 0, 0, 0)] * w for _ in range(h)]

    radius = n * 0.5 if round_icon else n * 0.22

    # 主体在画布里的相对坐标（和矢量前景一致：108 画布 → 归一化）
    def u(v):
        return v / 108.0 * n

    moon_cx, moon_cy, moon_r = u(52), u(56), u(21)
    cut_cx, cut_cy, cut_r = u(62), u(48), u(19)
    stars = [
        (u(77.4), u(72), u(3.4), STAR_A),
        (u(31.4), u(30), u(2.4), STAR_B),
        (u(80), u(34), u(2.0), MOON),
    ]

    for y in range(h):
        ty = y / (h - 1.0)
        base = tuple(int(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * ty)) for i in range(3))
        for x in range(w):
            if not inside_round_rect(x + 0.5, y + 0.5, w, h, radius):
                continue
            col = base
            # 弯月：大圆内、且不在挖掉的小圆里
            if in_circle(x + 0.5, y + 0.5, moon_cx, moon_cy, moon_r) and \
               not in_circle(x + 0.5, y + 0.5, cut_cx, cut_cy, cut_r):
                col = MOON
            # 星星（后画覆盖前画）
            for sx, sy, sr, sc in stars:
                if in_circle(x + 0.5, y + 0.5, sx, sy, sr):
                    col = sc
            px[y][x] = (col[0], col[1], col[2], 255)

    # 降采样回目标尺寸（盒式滤波）
    out = bytearray()
    rows = []
    for oy in range(size):
        row = bytearray()
        for ox in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                for dx in range(SS):
                    p = px[oy * SS + dy][ox * SS + dx]
                    r += p[0]; g += p[1]; b += p[2]; a += p[3]
            k = SS * SS
            row += bytes((r // k, g // k, b // k, a // k))
        rows.append(bytes(row))
    for row in rows:
        out += b'\x00' + row            # filter type 0
    return size, size, bytes(out)


def write_png(path, w, h, raw):
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)   # 8bit RGBA
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + \
        chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    made = []
    for dens, size in SIZES.items():
        d = os.path.join(root, 'app', 'res', 'mipmap-' + dens)
        os.makedirs(d, exist_ok=True)
        for name, rnd in (('ic_launcher.png', False), ('ic_launcher_round.png', True)):
            w, h, raw = render(size, rnd)
            p = os.path.join(d, name)
            write_png(p, w, h, raw)
            made.append(os.path.relpath(p, root))
    print('已生成 %d 个图标：' % len(made))
    for m in made:
        print('  ' + m)


if __name__ == '__main__':
    main()
