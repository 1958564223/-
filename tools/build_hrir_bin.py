#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_hrir_bin.py — 把 binaural-voice 的 KU100 近场 HRIR (.npz) 转成浏览器可直接 fetch 的二进制。

为什么要转:
    .npz 是 numpy 的 zip 容器, 浏览器没有 numpy 解析不了; 而且原始 1.76MB 全量
    对 PWA 首屏太重。这里做一次性离线转换, 产物是纯 int16 + 定长头, 运行时零依赖。

裁剪策略 (只裁方位, 不裁距离/抽头):
    方位 360 -> 72 (每 5° 取一个)。近场 HRIR 只有 128 抽头(≈2.7ms),
    沿方位变化极平滑, 相邻 5° 线性插值的误差远小于听阈;
    而【距离】和【抽头长度】直接决定"贴耳低频抬升"和远近自然衰减, 一律全保留。
    想更细就把 AZ_STEP 改成 2 或 1 重跑, 代价是体积线性上涨(5°→180KB, 1°→1.76MB)。

必须复刻的两件事 (少任一条听感就明显不对):
    1) 距离增益 GAINS —— SOFA 各距离各自做过归一化, 不乘回去远近就没有音量差
    2) 全局 int16 归一化 —— 只改整体尺度, 不改相对关系, 无损

用法:
    python tools/build_hrir_bin.py <hrir.npz> <out.bin>
输出头结构 (全部小端):
    0   4  magic        "KU1F"
    4   2  version      1
    6   2  headerSize   头部长度 (payload 起点)
    8   4  sampleRate   HRIR 原生采样率
    12  2  nDist
    14  2  nAz
    16  2  nEar
    18  2  taps
    20  2  azStepMilliDeg
    22  2  payloadFormat 1 = int16 LE
    24  4  payloadBytes
    28  4  payloadChecksum FNV-1a 32bit
    32 16  reserved (0)
    48  8*nDist  float64 distances
    ..  8*nDist  float64 gains (已烘焙进 payload, 此处仅作溯源留档)
    = headerSize
    payload: int16[nDist][nAz][nEar][taps]
"""
import sys, os, zipfile, struct

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

AZ_STEP = 5                      # 方位步长(度)
GAINS = [1.00, 0.33, 0.25, 0.16, 0.095]   # 与 binaural_voice.py 完全一致
MAGIC = b'KU1F'
VERSION = 1
PAYLOAD_FORMAT = 1               # int16 LE


def read_npy(fobj):
    if fobj.read(6) != b'\x93NUMPY':
        raise SystemExit('bad npy magic')
    major = fobj.read(1)[0]
    fobj.read(1)
    hlen = struct.unpack('<H', fobj.read(2))[0] if major == 1 else struct.unpack('<I', fobj.read(4))[0]
    d = eval(fobj.read(hlen).decode('latin1'), {'__builtins__': {}}, {})
    descr, shape = d['descr'], d['shape']
    if d.get('fortran_order'):
        raise SystemExit('fortran order unsupported')
    fmt = {'<f4': 'f', '<f8': 'd', '<i8': 'q'}[descr]
    n = 1
    for s in shape:
        n *= s
    data = struct.unpack('<%d%s' % (n, fmt), fobj.read(n * struct.calcsize(fmt)))
    return shape, list(data)


def fnv1a32(buf):
    h = 0x811C9DC5
    for b in buf:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def main(src, dst):
    z = zipfile.ZipFile(src)
    arrays = {}
    for name in z.namelist():
        with z.open(name) as f:
            arrays[name[:-4]] = read_npy(f)

    shape, ir = arrays['ir'][0], arrays['ir'][1]
    fs = int(arrays['fs'][1][0])
    dists = arrays['dists'][1]
    n_dist, n_az, n_ear, n_tap = shape
    print('source  : %s' % src)
    print('ir shape: %s  (距离, 方位, 耳, 抽头)' % (shape,))
    print('fs      : %d' % fs)

    assert n_dist == len(GAINS), '距离档数与增益表不匹配: %d vs %d' % (n_dist, len(GAINS))
    assert n_ear == 2, '期望双耳'
    assert n_az % AZ_STEP == 0, '方位数 %d 不能被步长 %d 整除' % (n_az, AZ_STEP)

    # 耳道/方位约定: 用数据本身验证, 不靠注释
    def energy(a, e):
        base = (a * n_ear + e) * n_tap
        return sum(v * v for v in ir[base:base + n_tap])
    r_left = energy(90, 0) / energy(90, 1)
    r_right = energy(270, 0) / energy(270, 1)
    assert r_left > 1.0, 'az=90 应当是左侧且 ch0 为左耳, 实测 ch0/ch1=%.3f' % r_left
    assert r_right < 1.0, 'az=270 应当是右侧, 实测 ch0/ch1=%.3f' % r_right
    print('verify  : az=90  ch0/ch1=%.1f (ch0=左耳)  az=270  ch0/ch1=%.4f (ch1=右耳)  [OK]'
          % (r_left, r_right))

    # ---- 裁方位 + 乘增益 ----
    out_az = n_az // AZ_STEP
    az_pick = [a * AZ_STEP for a in range(out_az)]

    staged = []           # float 暂存, 便于做全局峰值归一化
    peak = 0.0
    for k in range(n_dist):
        g = GAINS[k]
        for a in az_pick:
            for e in range(n_ear):
                base = (a * n_ear + e) * n_tap
                row = [ir[base + n] * g for n in range(n_tap)]
                peak = max(peak, max(abs(v) for v in row))
                staged.append(row)

    assert peak > 0, '全零数据'
    scale = 32767.0 / peak
    print('gain    : GAINS=%s' % GAINS)
    print('norm    : 峰值 %.6f -> int16 满量程 (scale=%.4f, 仅整体尺度, 相对关系不变)' % (peak, scale))

    # ---- 打包 ----
    payload = bytearray()
    for row in staged:
        for v in row:
            q = int(round(v * scale))
            if q > 32767: q = 32767
            elif q < -32768: q = -32768
            payload += struct.pack('<h', q)
    payload = bytes(payload)

    header_size = 48 + 16 * n_dist
    header = bytearray()
    header += MAGIC
    header += struct.pack('<H', VERSION)
    header += struct.pack('<H', header_size)
    header += struct.pack('<I', fs)
    header += struct.pack('<H', n_dist)
    header += struct.pack('<H', out_az)
    header += struct.pack('<H', n_ear)
    header += struct.pack('<H', n_tap)
    header += struct.pack('<H', AZ_STEP * 1000)
    header += struct.pack('<H', PAYLOAD_FORMAT)
    header += struct.pack('<I', len(payload))
    header += struct.pack('<I', fnv1a32(payload))
    header += b'\x00' * 16
    assert len(header) == 48, len(header)
    header += struct.pack('<%dd' % n_dist, *dists)
    header += struct.pack('<%dd' % n_dist, *GAINS)
    assert len(header) == header_size, (len(header), header_size)

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, 'wb') as f:
        f.write(bytes(header))
        f.write(payload)

    total = len(header) + len(payload)
    print('output  : %s' % dst)
    print('size    : %d bytes (%.1f KB)  header=%d payload=%d' % (total, total / 1024, header_size, len(payload)))
    print('layout  : [%d 距离 %d 方位 x %d 耳 x %d 抽头] int16, 方位步长 %d°' % (n_dist, out_az, n_ear, n_tap, AZ_STEP))
    print('checksum: FNV-1a32 = 0x%08X' % fnv1a32(payload))


if __name__ == '__main__':
    base = os.path.dirname(os.path.abspath(__file__))
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(base, '..', '_reports', 'binaural-audit', 'hrir.npz')
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(base, '..', 'assets', 'audio', 'hrir-ku100-nf.bin')
    main(src, dst)
