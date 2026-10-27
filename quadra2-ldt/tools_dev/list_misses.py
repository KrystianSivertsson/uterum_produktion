"""List operations whose tool axis never meets the profile contour (hypothesis A, unrotated cuts) with details.
Usage: list_misses.py <ecw> <dxf>"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")
import ecw, toolsel
from quadra import face_point, final_depth

job = ecw.read(sys.argv[1]); segs = toolsel.dxf_segments(sys.argv[2])
seen = set()
for bar in job.bars:
    for cut in bar.cuts:
        if cut.rotation:
            continue
        for w in ecw.flatten(job, cut):
            if w.wtype not in ("C", "D", "L", "R"):
                continue
            fp = face_point(w, bar)
            if fp is None:
                print("unsupported", w.side); continue
            x, y, th = fp
            d = final_depth(w)
            e = toolsel.entry_distance(x, y, th, segs, 999)
            key = (w.side, w.wtype, round(x, 2), round(y, 2), round(th), d, w.s("WComment"))
            if e >= d and key not in seen:
                seen.add(key)
                print(f"MISS CNo {cut.no} side {w.side} {w.wtype} pt=({x:.2f},{y:.2f}) th={th:.0f} depth={d} entry={e:.1f} "
                      f"WY1={w.f('WY1')} WH={w.f('WHeight')} WW1={w.f('WW1')} {w.s('WComment') or w.kv.get('_comment','')}")
