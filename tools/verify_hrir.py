#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_hrir.py — 用纯标准库拆开 ku100_nearfield_circ360.npz, 验证方位/耳道约定。

背景: binaural_voice.py 里 PLACES = {"左耳": (90, 0.25), "右耳": (270, 0.25), ...}
      且注释写明 "方位角(逆时针, 0=前 90=左 180=后 270=右)"。
      但我们不能只信注释 —— 必须用数据本身证明:
        若 az=90 真的是"左", 则该方位上【左耳】通道能量应显著高于右耳通道。
      这条判据能唯一确定 (方位角方向, 耳道索引) 的对应关系, 搞错了整个空间感就是左右反的。

跑法: python tools/verify_hrir.py <path/to/ku100_nearfield_circ360.npz>
不依赖 numpy。
"""
import sys, os, zipfile, struct, math

# Windows 控制台默认 GBK, 中文/符号会炸; 强制 UTF-8 并降级替换
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# 与 binaural_voice.py 完全一致的距离增益表 (来自数据集官方 NF_Datasets_Gains_infos.pdf)
GAINS = [1.00, 0.33, 0.25, 0.16, 0.095]


def read_npy(fobj):
    """返回 (dtype_str, shape, flat_list_of_floats)。只支持 C-order 标量/1D/多维数值数组。"""
    magic = fobj.read(6)
    if magic != b'\x93NUMPY':
        raise SystemExit('bad npy magic')
    major = fobj.read(1)[0]
    fobj.read(1)  # minor
    if major == 1:
        hlen = struct.unpack('<H', fobj.read(2))[0]
    else:
        hlen = struct.unpack('<I', fobj.read(4))[0]
    header = fobj.read(hlen).decode('latin1')
    d = eval(header, {'__builtins__': {}}, {})  # header 是纯 dict 字面量
    descr = d['descr']
    shape = d['shape']
    if d.get('fortran_order'):
        raise SystemExit('fortran order not supported')
    fmt = {'<f4': 'f', '<f8': 'd', '<i8': 'q'}[descr]
    n = 1
    for s in shape:
        n *= s
    data = struct.unpack('<%d%s' % (n, fmt), fobj.read(n * struct.calcsize(fmt)))
    return descr, shape, list(data)


def main(path):
    z = zipfile.ZipFile(path)
    arrays = {}
    for name in z.namelist():
        with z.open(name) as f:
            arrays[name[:-4]] = read_npy(f)

    ir_shape = arrays['ir'][1]
    ir = arrays['ir'][2]
    fs = int(arrays['fs'][2][0])
    dists = arrays['dists'][2]

    print('ir shape =', ir_shape, '(距离, 方位, 耳, 抽头)')
    print('fs       =', fs)
    print('dists    =', dists)
    n_dist, n_az, n_ear, n_tap = ir_shape
    assert n_ear == 2, '期望双耳数据'

    def idx(k, a, e, n):
        return ((((k * n_az) + a) * n_ear + e) * n_tap + n)

    def energy(k, a, e):
        """该 (距离, 方位, 耳) 的 HRIR 能量 = Σ h[n]^2 (含增益前, 同一距离内比较不影响结论)"""
        return sum(ir[idx(k, a, e, n)] ** 2 for n in range(n_tap))

    print()
    print('=== 判据: 若 az=90 是"左", 则该方位 ch0(左耳) 能量 > ch1(右耳) ===')
    print('%-6s %-14s %-14s %-10s %s' % ('az', 'E(ch0)', 'E(ch1)', 'ch0/ch1', 'verdict'))
    verdicts = {}
    for az in (0, 90, 180, 270):
        e0, e1 = energy(0, az, 0), energy(0, az, 1)
        ratio = e0 / e1 if e1 > 0 else float('inf')
        # >1 表示 ch0 更响
        if az == 90:
            verdict = 'ch0=LEFT  [PASS]' if ratio > 1 else 'ch1=LEFT  [FAIL: L/R swapped!]'
            verdicts['90'] = ratio > 1
        elif az == 270:
            verdict = 'ch1=RIGHT [PASS]' if ratio < 1 else 'ch0=RIGHT [FAIL: L/R swapped!]'
            verdicts['270'] = ratio < 1
        else:
            verdict = 'front/back, both ears ~equal (expected)'
        print('%-6d %-14.5f %-14.5f %-10.3f %s' % (az, e0, e1, ratio, verdict))

    print()
    ok = verdicts.get('90') and verdicts.get('270')
    print('AZIMUTH VERDICT:',
          'PASS - azimuth is CCW (0=front,90=left,180=back,270=right), ch0=LEFT, ch1=RIGHT'
          if ok else 'FAIL - ear/azimuth mapping differs from assumption; do NOT generate the binary')

    # 额外体检
    print()
    print('=== 体检 ===')
    peak = max(abs(v) for v in ir)
    print('全库峰值          = %.6f' % peak)
    print('正峰(az=0,近场)  = %.6f' % max(ir[idx(0, 0, 0, n)] for n in range(n_tap)))

    # 最近抽头是否显著 —— 近场直达声应当很强
    print('近场首抽头 h[0]   = %.6f / %.6f (左/右)' % (ir[idx(0, 0, 0, 0)], ir[idx(0, 0, 1, 0)]))
    # 各距离的首抽头比值, 应当随距离大致按 1/r 衰减
    print()
    print('近场直达声随距离衰减 (同方位 az=90, 左耳):')
    for k, d in enumerate(dists):
        h0 = abs(ir[idx(k, 90, 0, 0)])
        print('  d=%-5sm  h[0]=%.6f  ×gain=%.6f' % (d, h0, h0 * GAINS[k]))

    # 是否存在 NaN / Inf
    bad = sum(1 for v in ir if not math.isfinite(v))
    print()
    print('NaN/Inf 数量       =', bad)

    return 0 if (ok and bad == 0) else 1


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', '_reports', 'binaural-audit', 'hrir.npz')
    sys.exit(main(src))
