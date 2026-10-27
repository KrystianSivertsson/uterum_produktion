"""Brute-force section transforms for each unique op: base A/B x rot180 x mirrorH. Prints surface distances.
Usage: combos.py <ecw> <dxf>"""
import itertools, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")
import ecw, toolsel
from quadra import face_point, final_depth

job = ecw.read(sys.argv[1]); segs = toolsel.dxf_segments(sys.argv[2])
ops = {}
for bar in job.bars:
    for cut in bar.cuts:
        for w in ecw.flatten(job, cut):
            if w.wtype in ("C", "D", "L", "R") and face_point(w, bar):
                ops.setdefault((cut.rotation, cut.mirror, w.side, w.wtype, round(w.f("WY1"), 2), round(w.f("WHeight"), 2)), (w, bar))
for (base, rot, mir) in itertools.product("AB", (0, 1), (0, 1)):
    cells = []
    for k, (w, bar) in sorted(ops.items()):
        W, H = bar.width, bar.height
        x, y, th = face_point(w, bar)
        if base == "B":
            x, th = W - x, 180 - th
        if rot:
            x, y, th = W - x, H - y, th + 180
        if mir:
            y, th = H - y, -th
        e = toolsel.entry_distance(x, y, th, segs, 999)
        d = final_depth(w)
        tag = "=" if abs(e - max(k[5], 0)) < 0.3 else ("hit" if e < d else "MISS")
        cells.append(f"s{k[2]}{k[3]}:{e:6.2f}{tag}")
    print(f"{base} rot180={rot} mirH={mir}:  " + "  ".join(cells))
