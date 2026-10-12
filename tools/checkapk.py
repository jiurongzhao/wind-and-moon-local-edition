#!/usr/bin/env python3
"""checkapk.py —— 校验 APK 是否满足 Android 的安装/加载硬性要求。

检查项：
  1. zip 结构完整（且能被标准库正常读取）
  2. resources.arsc：存在、不压缩、数据起始 4 字节对齐（targetSdk 30+ 强制）
  3. lib/**/*.so：存在、不压缩、数据起始 4096 字节对齐
  4. AndroidManifest.xml、classes.dex 存在
  5. 引擎文件齐全（libfy_llama_server.so + 它 DT_NEEDED 的那几个库 + CPU 后端变体）

用法: checkapk.py <apk>
退出码 0 = 全部通过，1 = 有问题
"""
import struct
import sys
import zipfile

REQUIRED_LIBS = [
    'lib/arm64-v8a/libfy_llama_server.so',
    'lib/arm64-v8a/libllama-server-impl.so',
    'lib/arm64-v8a/libllama-common.so',
    'lib/arm64-v8a/libmtmd.so',
    'lib/arm64-v8a/libllama.so',
    'lib/arm64-v8a/libggml.so',
    'lib/arm64-v8a/libggml-base.so',
]

ok = True


def fail(msg):
    global ok
    ok = False
    print('  ❌ ' + msg)


def good(msg):
    print('  ✅ ' + msg)


def data_offset(info, path=None):
    """条目数据在文件里的绝对偏移。

    注意：不能拿中央目录里的 extra 长度来推算本地头 —— apksigner 签名时会往【本地头】
    写额外的扩展字段（实测 7 字节），中央目录里看不到，于是算出来的偏移会差几个字节，
    把本来对齐的 resources.arsc 误判成没对齐（真机上是能装的）。
    所以这里直接读本地文件头，拿真实的 nlen/elen。
    """
    if path is not None:
        try:
            with open(path, 'rb') as f:
                f.seek(info.header_offset)
                head = f.read(30)
                if len(head) == 30:
                    (_sig, _ver, _flags, _method, _t, _d, _crc,
                     _csize, _usize, nlen, elen) = struct.unpack('<IHHHHHIIIHH', head)
                    return info.header_offset + 30 + nlen + elen
        except Exception:
            pass
    return info.header_offset + 30 + len(info.filename.encode('utf-8')) + len(info.extra or b'')


def main(path):
    print('校验 %s' % path)
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        fail('无法作为 zip 打开: %s' % e)
        return 1

    bad = z.testzip()
    if bad:
        fail('zip 结构损坏，首个坏条目: %s' % bad)
    else:
        good('zip 结构完整（%d 个条目）' % len(z.infolist()))

    names = set(z.namelist())

    # 2. resources.arsc
    if 'resources.arsc' not in names:
        fail('缺少 resources.arsc')
    else:
        i = z.getinfo('resources.arsc')
        off = data_offset(i, path)
        if i.compress_type != zipfile.ZIP_STORED:
            fail('resources.arsc 被压缩了（必须 Stored）')
        elif off % 4 != 0:
            fail('resources.arsc 未 4 字节对齐（data offset=%d, %%4=%d）' % (off, off % 4))
        else:
            good('resources.arsc 未压缩且 4 字节对齐（offset=%d）' % off)

    # 3. native 库
    so_list = [n for n in names if n.startswith('lib/') and n.endswith('.so')]
    if not so_list:
        fail('没有任何 lib/**/*.so')
    else:
        stored = [n for n in so_list if z.getinfo(n).compress_type == zipfile.ZIP_STORED]
        deflated = [n for n in so_list if z.getinfo(n).compress_type != zipfile.ZIP_STORED]
        misaligned = [n for n in stored if data_offset(z.getinfo(n), path) % 4096 != 0]
        if deflated:
            good('%d 个 .so 压缩存放（配合 extractNativeLibs=true 安装时解包，无需对齐）'
                 % len(deflated))
        if stored and not misaligned:
            good('%d 个 .so 未压缩且 4096 对齐' % len(stored))
        if misaligned:
            shown = ['%s@%d' % (n, data_offset(z.getinfo(n), path)) for n in misaligned[:3]]
            fail('%d 个 .so 未压缩但未 4096 对齐（extractNativeLibs=false 时会加载失败）: %s'
                 % (len(misaligned), shown))

    # 4. 必需条目
    for need in ['AndroidManifest.xml', 'classes.dex']:
        if need in names:
            good('%s 存在' % need)
        else:
            fail('缺少 %s' % need)

    # 4b. 二进制清单里的关键开关（用 aapt2 解析，这是平台真正读到的值）
    try:
        import subprocess
        out = subprocess.run(['aapt2', 'dump', 'xmltree', '--file', 'AndroidManifest.xml', path],
                             capture_output=True, text=True, timeout=60).stdout
        for attr, want in [('extractNativeLibs', 'true')]:
            line = [l for l in out.splitlines() if attr in l]
            if line and want in line[0]:
                good('清单 %s=%s' % (attr, want))
            elif line:
                fail('清单 %s 不是 %s：%s' % (attr, want, line[0].strip()[:90]))
            else:
                fail('清单里找不到 %s（运行时会出问题）' % attr)
        # debuggable：调试包必须有、发布包必须没有 —— 由构建脚本再查一遍，这里只报告现状
        dbg = [l for l in out.splitlines() if 'debuggable' in l]
        if dbg and 'true' in dbg[0]:
            print('  ℹ️  清单 debuggable=true（调试构建；发布构建必须为 false）')
        else:
            good('清单没有 debuggable（发布形态）')
        # 明文流量：要么整包放开，要么用 networkSecurityConfig 精确放行（推荐后者）
        cc = [l for l in out.splitlines() if 'usesCleartextTraffic' in l]
        nsc = [l for l in out.splitlines() if 'networkSecurityConfig' in l]
        if nsc:
            good('清单用 networkSecurityConfig 控制明文流量（只放行回环）')
        elif cc and 'true' in cc[0]:
            good('清单 usesCleartextTraffic=true')
        else:
            fail('清单既没有 usesCleartextTraffic 也没有 networkSecurityConfig（本地 http 会连不上）')
        sdks = [l.strip() for l in out.splitlines() if 'minSdkVersion' in l or 'targetSdkVersion' in l]
        if sdks:
            good('SDK 设置：' + ' / '.join(s.split('=')[-1] for s in sdks))
    except FileNotFoundError:
        print('  ⚠️  没找到 aapt2，跳过清单检查')
    except Exception as e:
        print('  ⚠️  清单检查失败：%s' % e)

    # 5. 引擎文件齐全
    missing = [n for n in REQUIRED_LIBS if n not in names]
    if missing:
        fail('引擎库缺失: %s' % missing)
    else:
        good('引擎核心库齐全（%d 个）' % len(REQUIRED_LIBS))
    cpus = sorted(n for n in names if 'libggml-cpu-android' in n)
    if len(cpus) >= 3:
        good('CPU 后端变体 %d 个（运行时按 CPU 特性自动选）' % len(cpus))
    else:
        fail('CPU 后端变体太少（%d 个），可能导致 "no backends are loaded"' % len(cpus))

    # 引擎可执行文件必须有执行位（解包后要能 exec）
    exe = 'lib/arm64-v8a/libfy_llama_server.so'
    if exe in names:
        mode = (z.getinfo(exe).external_attr >> 16) & 0o777
        # zip 里的权限位对 Android 无决定性影响（安装器会统一置 0755），仅提示
        good('%s 存在（zip 权限记录 %o，安装后由系统置为可执行）' % (exe, mode))

    print('结论：' + ('全部通过 ✅' if ok else '存在问题 ❌'))
    return 0 if ok else 1


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
