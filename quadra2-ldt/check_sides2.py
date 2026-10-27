"""Decide ECW-front orientation in the DXF: for every drill/slot/rect, cast the tool axis from the start point
to full depth and count wall crossings under hypothesis A (front at DXF x=0) and B (front at DXF x=W).
A wrong hypothesis shows operations that cut only air (0 crossings)."""
import math, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ecw
from check_sides import dxf_segments

sys.stdout.reconfigure(encoding="utf-8")


def final_depth(w):
    tab = w.s("WDepthTab")
    tiers = [t.split() for t in tab.split(",") if t.strip()]
    vals = [float(t[0]) for t in tiers if t]
    return max(vals) if vals else w.f("WDepth")


def frame(side, y, h, W, H):
    """Start point (ev, ew) and inward normal in SBZ frame (EV front0->backW, EW top0->bottom -H)."""
    if side == 1:
        return (y, h), (0, -1)
    if side == 2:
        return (-h, y), (1, 0)
    if side == 3:
        return (h + W, -y), (-1, 0)
    if side == 6:
        return (-y, -h - H), (0, 1)
    return None, None


def crossings(p, q, segs):
    n = 0
    for a, b in segs:
        (x1, y1), (x2, y2) = a, b
        (x3, y3), (x4, y4) = p, q
        d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if abs(d) < 1e-12:
            continue
        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d
        u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d
        if 0 <= t <= 1 and 0 <= u <= 1:
            n += 1
    return n


job = ecw.read(sys.argv[1])
segs = dxf_segments(sys.argv[2])
res = {"A": [], "B": []}
for bar in job.bars:
    W, H = bar.width, bar.height
    for cut in bar.cuts:
        for w in ecw.flatten(job, cut):
            if w.wtype not in ("C", "D", "L", "R"):
                continue
            st, nrm = frame(w.side, w.f("WY1"), w.f("WHeight"), W, H)
            if nrm is None:
                continue
            ev, ew = st
            d = final_depth(w)
            for hyp in ("A", "B"):
                x0 = ev if hyp == "A" else W - ev
                nx = nrm[0] if hyp == "A" else -nrm[0]
                p = (x0, ew + H); q = (x0 + nx * d, ew + H + nrm[1] * d)
                res[hyp].append((w.side, w.wtype, round(p[0], 1), round(p[1], 1), d, crossings(p, q, segs), w.s("WComment") or w.kv.get("_comment", "")))
for hyp, rows in res.items():
    air = [r for r in rows if r[5] == 0]
    print(f"hyp {hyp}: {len(rows)} ops, {len(air)} cut only air")
    seen = set()
    for r in rows:
        k = r[:5]
        if k in seen:
            continue
        seen.add(k)
        print(f"   side {r[0]} {r[1]} start=({r[2]},{r[3]}) depth={r[4]} crossings={r[5]}  {r[6][:40]}")
