"""Test rotation sign for free-plane ops (first unrotated cut with WSide 7 ops). Usage: plane_sign.py <ecw> <dxf>"""
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")
import ecw, toolsel
from quadra import final_depth

j = ecw.read(sys.argv[1]); segs = toolsel.dxf_segments(sys.argv[2])
done = set()
for bar in j.bars:
    W, H = bar.width, bar.height
    for cut in bar.cuts:
        if cut.rotation:
            continue
        for w in ecw.flatten(j, cut):
            if w.side < 7 or w.wtype not in ("C", "D", "L", "R"):
                continue
            pl = bar.planes.get(w.side - 7)
            y, h, d = w.f("WY1"), w.f("WHeight"), final_depth(w)
            key = (round(y, 2), round(h, 2), pl.angle_x)
            if key in done:
                continue
            done.add(key)
            print(f"plane {pl.angle_x} trans {pl.trans} WY1 {y} WH {h} depth {d} ({w.s('WComment')})")
            for sign in (-1, 1):
                a = sign * pl.angle_x
                ra = math.radians(a)
                ev = pl.trans[1] + y * math.cos(ra) - h * math.sin(ra)
                ew = pl.trans[2] + y * math.sin(ra) + h * math.cos(ra)
                th = 90 + a
                for base in "AB":
                    x, t = (ev, th) if base == "A" else (W - ev, 180 - th)
                    e = toolsel.entry_distance(x, ew + H, t, segs, 999)
                    print(f"   A={a:+.0f} {base}: punkt ({x:.2f},{ew + H:.2f}) normal {t:.0f} avstand {e:.2f} {'traff' if e < d else 'MISS'}")
