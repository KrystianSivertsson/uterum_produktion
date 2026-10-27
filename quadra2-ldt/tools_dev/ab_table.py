"""Per unique operation: distance from reference point to first material under hypothesis A and B.
Usage: ab_table.py <ecw> <dxf> [rotflip]   (rotflip: apply 180° back-rotation for CRotation 2 cuts)"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")
import ecw, toolsel
from quadra import face_point, final_depth

job = ecw.read(sys.argv[1]); segs = toolsel.dxf_segments(sys.argv[2])
rows = {}
for bar in job.bars:
    W, H = bar.width, bar.height
    for cut in bar.cuts:
        for w in ecw.flatten(job, cut):
            if w.wtype not in ("C", "D", "L", "R"):
                continue
            fp = face_point(w, bar)
            if fp is None:
                continue
            x, y, th = fp
            if cut.rotation == 2:
                x, y, th = W - x, H - y, th + 180
            d = final_depth(w)
            ea = toolsel.entry_distance(x, y, th, segs, 999)
            eb = toolsel.entry_distance(W - x, y, 180 - th, segs, 999)
            k = (cut.rotation, w.side, w.wtype, w.s("WComment")[:26], round(w.f("WY1"), 2), round(w.f("WHeight"), 2))
            rows.setdefault(k, [0, ea, eb, d])
            rows[k][0] += 1
print(f"{'rot':>3} {'sida':>4} typ {'kommentar':<26} {'WY1':>7} {'WH':>6}  n   A-avst  B-avst  djup")
for k, (n, ea, eb, d) in sorted(rows.items()):
    fa = "*" if abs(ea - max(k[5], 0)) < 0.3 else " "
    fb = "*" if abs(eb - max(k[5], 0)) < 0.3 else " "
    print(f"{k[0]:>3} {k[1]:>4} {k[2]:>3} {k[3]:<26} {k[4]:>7} {k[5]:>6} {n:>3} {ea:7.2f}{fa} {eb:7.2f}{fb} {d:6.2f}")
