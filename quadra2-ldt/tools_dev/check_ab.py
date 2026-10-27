"""Hypothesis A (ECW front = DXF x 0) vs B (front = DXF x W) for unrotated cuts: material hits and the distance
from the reference point to the first contour crossing (should be ~WHeight when the mapping is right).
Usage: check_ab.py <ecw> <dxf>"""
import math, os, sys, statistics
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")
import ecw, toolsel
from quadra import face_point, final_depth

job = ecw.read(sys.argv[1]); segs = toolsel.dxf_segments(sys.argv[2])
stats = {"A": [], "B": []}
for bar in job.bars:
    W, H = bar.width, bar.height
    for cut in bar.cuts:
        if cut.rotation:
            continue
        for w in ecw.flatten(job, cut):
            if w.wtype not in ("C", "D", "L", "R"):
                continue
            fp = face_point(w, bar)
            if fp is None:
                continue
            x, y, th = fp
            d = final_depth(w)
            for hyp in ("A", "B"):
                px, t = (x, th) if hyp == "A" else (W - x, 180 - th)
                e = toolsel.entry_distance(px, y, t, segs, 999)
                hit = e < d
                stats[hyp].append((hit, e, w.side, round(w.f("WHeight"), 2), (w.s("WComment") or w.kv.get("_comment", ""))[:30]))
for hyp, rows in stats.items():
    hits = sum(1 for r in rows if r[0])
    ents = [r[1] for r in rows if r[0]]
    print(f"hyp {hyp}: {hits}/{len(rows)} träffar, avstånd till gods median {statistics.median(ents) if ents else float('nan'):.2f}")
    bad = {}
    for r in rows:
        if not r[0] or abs(r[1] - max(r[3], 0)) > 1.0:
            bad.setdefault((r[2], r[4], r[3]), []).append(round(r[1], 1))
    for k, v in list(bad.items())[:8]:
        print(f"    avvikande: sida {k[0]} {k[1]:<30} WHeight {k[2]}: avstånd {sorted(set(v))[:4]}")
