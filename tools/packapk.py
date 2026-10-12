#!/usr/bin/env python3
"""packapk.py —— 把 aapt2 产出的 APK 与 dex / native 库重新打包，并做 zipalign 对齐。

为什么要自己写：Termux 里没有 zipalign 包，而 Android 对 APK 有硬性对齐要求：
  * resources.arsc → 必须【不压缩】且数据起始 4 字节对齐（targetSdk 30+ 强制）
  * lib/**/*.so    → 只有「不压缩存放 + extractNativeLibs=false（从 APK 直接 mmap）」
                     时才要求 4096 对齐。本项目清单里是 extractNativeLibs="true"，
                     库在安装时会被解包到 nativeLibraryDir 再加载，所以这里
                     【默认压缩存放】：体积小一半，而且不依赖任何对齐（更稳）。
                     另外 apksigner 签名时会重写 zip、把 STORED 的 .so 挪动 8 字节，
                     4096 对齐根本保不住 —— 压缩存放顺便绕开了这个坑。
                     需要不压缩时加 --store-native。

对齐做法：在条目本地头之前插入若干 0 字节的间隙（阅读器按中央目录定位条目，
条目之间留空隙是合法的，这正是 zipalign 的经典做法）。

用法:
  packapk.py [--store-native] <base.apk> <out.apk> <arcname=文件路径> ...
例:
  packapk.py build/apk/base.apk build/apk/aligned.apk classes.dex \
      lib/arm64-v8a/libfy_llama_server.so=~/2/fy/native/libfy_llama_server.so
"""
import os
import struct
import sys
import zipfile
import zlib

ALIGN_ARSC = 4
ALIGN_SO = 4096

STORE_NATIVE = False


def dos_time(dt):
    """(Y,M,D,h,m,s) -> (dostime, dosdate)；非法时间回退到 1980-01-01。"""
    try:
        y, mo, d, h, mi, s = (dt + (0, 0, 0))[:6]
        if y < 1980:
            raise ValueError
        return ((h << 11) | (mi << 5) | (s // 2), ((y - 1980) << 9) | (mo << 5) | d)
    except Exception:
        return (0, (1 << 5) | 1)  # 1980-01-01 00:00:00


def deflate(data):
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return c.compress(data) + c.flush()


def is_so(name):
    return name.startswith('lib/') and name.endswith('.so')


def method_for(name, orig_method):
    if name == 'resources.arsc':
        return 0                      # 必须不压缩
    if is_so(name):
        return 0 if STORE_NATIVE else 8
    return 8 if orig_method == zipfile.ZIP_DEFLATED else 0


def align_for(name):
    if name == 'resources.arsc':
        return ALIGN_ARSC
    if is_so(name) and STORE_NATIVE:
        return ALIGN_SO
    return 1


def collect(base, extras):
    entries = []
    with zipfile.ZipFile(base) as z:
        for i in z.infolist():
            if i.is_dir():
                continue
            name = i.filename
            entries.append({'name': name, 'data': z.read(name),
                            'method': method_for(name, i.compress_type),
                            'dt': i.date_time})

    have = {e['name'] for e in entries}
    for arcname, path in extras:
        if arcname in have:
            entries = [e for e in entries if e['name'] != arcname]
        with open(path, 'rb') as f:
            data = f.read()
        entries.append({'name': arcname, 'data': data,
                        'method': method_for(arcname, zipfile.ZIP_DEFLATED),
                        'dt': (1980, 1, 1, 0, 0, 0)})
    return entries


def write_apk(entries, out):
    central = []
    pos = 0
    with open(out, 'wb') as f:
        for e in entries:
            nb = e['name'].encode('utf-8')
            method = e['method']
            comp = e['data'] if method == 0 else deflate(e['data'])
            crc = zlib.crc32(e['data']) & 0xFFFFFFFF
            dostime, dosdate = dos_time(e['dt'])
            align = align_for(e['name'])

            if align > 1:
                gap = (-(pos + 30 + len(nb))) % align
                if gap:
                    f.write(b'\0' * gap)
                    pos += gap

            offset = pos
            f.write(struct.pack('<IHHHHHIIIHH', 0x04034B50, 20, 0, method,
                                dostime, dosdate, crc, len(comp), len(e['data']),
                                len(nb), 0))
            f.write(nb)
            f.write(comp)
            pos += 30 + len(nb) + len(comp)
            central.append((nb, method, dostime, dosdate, crc, len(comp), len(e['data']), offset))

        cd_start = pos
        for nb, method, dostime, dosdate, crc, csize, usize, offset in central:
            f.write(struct.pack('<IHHHHHHIIIHHHHHII', 0x02014B50, 20, 20, 0, method,
                                dostime, dosdate, crc, csize, usize,
                                len(nb), 0, 0, 0, 0, 0, offset))
            f.write(nb)
            pos += 46 + len(nb)
        cd_size = pos - cd_start
        f.write(struct.pack('<IHHHHIIH', 0x06054B50, 0, 0, len(central), len(central),
                            cd_size, cd_start, 0))


def main():
    global STORE_NATIVE
    argv = list(sys.argv[1:])
    if '--store-native' in argv:
        argv.remove('--store-native')
        STORE_NATIVE = True
    if len(argv) < 2:
        print(__doc__)
        return 2
    base, out = argv[0], argv[1]
    extras = []
    for a in argv[2:]:
        if '=' in a:
            arc, path = a.split('=', 1)
        else:
            arc, path = ('classes.dex' if a.endswith('.dex') else 'lib/arm64-v8a/' + os.path.basename(a)), a
        extras.append((arc, os.path.expanduser(path)))

    entries = collect(base, extras)
    write_apk(entries, out)
    print('已打包 %d 个条目 -> %s (%.1f MB, native=%s)'
          % (len(entries), out, os.path.getsize(out) / 1e6,
             '未压缩' if STORE_NATIVE else '压缩'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
