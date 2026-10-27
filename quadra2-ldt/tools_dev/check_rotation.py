"""For cuts with CRotation != 0: test whether ops land on material with no back-rotation vs. 180° back-rotation.
Usage: check_rotation.py <ecw> <dxf>"""
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")
import ecw, toolsel
from quadra import face_point, final_depth

job = ecw.read(sys.argv[1]); segs = toolsel.dxf_segments(sys.argv[2])


def crossings(p, q):
    n = 0
    for (x1, y1), (x2, y2) in segs:
        (x3, y3), (x4, y4) = p, q
        d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if abs(d) < 1e-12:
            continue
        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d
        u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d
        if 0 <= t <= 1 and 0 <= u <= 1:
            n += 1
    return n


for bar in job.bars:
    W, H = bar.width, bar.height
    for cut in bar.cuts:
        res = {"none": [0, 0], "rot180": [0, 0], "mirrorW": [0, 0]}
        for w in ecw.flatten(job, cut):
            if w.wtype not in ("C", "D", "L", "R"):
                continue
            fp = face_point(w, bar)
            if fp is None:
                continue
            x, y, th = fp
            d = final_depth(w)
            for hyp in res:
                if hyp == "none":
                    px, py, t = x, y, th
                elif hyp == "rot180":
                    px, py, t = W - x, H - y, th + 180
                else:
                    px, py, t = W - x, y, 180 - th
                nx, ny = -math.cos(math.radians(t)), -math.sin(math.radians(t))
                c = crossings((px, py), (px + nx * d, py + ny * d))
                res[hyp][0] += 1
                res[hyp][1] += 1 if c > 0 else 0
        print(f"CNo {cut.no} rot={cut.rotation} mir={cut.mirror} {cut.description[:40]:<40} "
              + "  ".join(f"{k}: {v[1]}/{v[0]} träffar" for k, v in res.items()))
