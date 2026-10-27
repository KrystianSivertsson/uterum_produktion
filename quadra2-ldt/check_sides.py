"""Diagnostic: flatten an ECW and test, for each named-side operation, whether its section point lands on the
profile outline (DXF) under hypothesis A (ECW front = W 0) and B (mirrored, front = W max)."""
import math, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ecw

sys.stdout.reconfigure(encoding="utf-8")


def dxf_segments(path):
    L = [l.strip() for l in open(path, encoding="cp1252", errors="replace")]
    segs, cur, poly = [], [], False
    for i in range(0, len(L) - 1, 2):
        c, v = L[i], L[i + 1]
        if c == "0":
            if v == "POLYLINE":
                poly, cur = True, []
            elif v == "SEQEND":
                if len(cur) > 1:
                    segs += list(zip(cur, cur[1:] + cur[:1]))
                poly = False
            elif v == "VERTEX":
                cur.append([0.0, 0.0])
            elif v == "LINE":
                cur = [[0.0, 0.0], [0.0, 0.0]]; segs.append(cur); poly = False
        if c in ("10", "11", "20", "21") and cur:
            idx = 0 if c in ("10", "20") else 1
            tgt = cur[-1] if poly else cur[idx]
            tgt[0 if c in ("10", "11") else 1] = float(v)
    return [s for s in segs if isinstance(s, tuple) or len(s) == 2]


def dist(p, segs):
    best = 1e9
    for a, b in segs:
        ax, ay = a; bx, by = b
        dx, dy = bx - ax, by - ay
        t = 0 if dx == dy == 0 else max(0, min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy))
    return best


def point(side, y, h, W, H):
    # SBZ machine frame (ase60 kinematics.ts): EV across (front 0 .. back W), EW vertical (top 0 .. bottom -H)
    if side == 1:
        ev, ew = y, h
    elif side == 2:
        ev, ew = -h, y
    elif side == 3:
        ev, ew = h + W, -y
    elif side == 6:
        ev, ew = -y, -h - H
    else:
        return None
    return ev, ew + H


def main():
  job = ecw.read(sys.argv[1])
  segs = dxf_segments(sys.argv[2])
  stats = {}
  for bar in job.bars:
    for cut in bar.cuts:
        for w in ecw.flatten(job, cut):
            if w.wtype not in ("C", "D", "L", "R"):
                continue
            p = point(w.side, w.f("WY1"), w.f("WHeight"), bar.width, bar.height)
            if p is None:
                continue
            a = dist(p, segs)
            b = dist((bar.width - p[0], p[1]), segs)
            key = (w.side, w.wtype)
            stats.setdefault(key, []).append((round(a, 2), round(b, 2), round(p[0], 1), round(p[1], 1), w.f("WHeight")))
  for k, v in sorted(stats.items()):
    ma = sum(x[0] for x in v) / len(v); mb = sum(x[1] for x in v) / len(v)
    print(f"side {k[0]} type {k[1]}: n={len(v)} mean dist A={ma:.2f} B={mb:.2f}  examples(W,H,h)={[(x[2], x[3], x[4]) for x in v[:4]]}")


if __name__ == "__main__":
    main()
