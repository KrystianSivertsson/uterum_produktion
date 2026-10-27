"""Tool model and selection for the Quadra2 (machine TOOLS.TXT format, 4 lines per tool):
    * NAME TYPE COOLANT          (TYPE 0 mill, 1 drill, 2 countersink)
    RPM REMOVAL DOWN
    D1 D2 D3 SHANK HOLDER_D
    L1 L2 L3 HOLDER_LEN TOTAL
Reach model: from the tip the tool is D1 for L1, then D2 for L2 (stepped tools), then the shank; the holder
(Ø ~22) never enters a feature, so the protrusion below it is TOTAL - HOLDER_LEN.
An operation needs: reach inside the feature (all diameters <= feature width) >= depth from first contact
with the profile contour, and protrusion >= depth below the profile's outer envelope.
"""
from __future__ import annotations

import math

# Krystian 2026-10-14 (tool_plan2.py, all ASE60 + ASS32 with the collision check): F5 short and stiff for shallow
# Ø5 holes/5 mm slots, the long Ø5 drill P5L only where reach is needed (sash glue/nail holes from below),
# F3L for Ø3-4.5, F8L for everything larger. P5L = DIN 338 Ø5 at 40 mm stick-out (TOOLS.TXT entry added
# locally; the machine's tool table needs the same name and data).
DEFAULT_SET = ("F3L", "F5", "F8L", "P5L")


def read_tools(path=r"C:\Quadra2\CAM\TOOLS.TXT") -> dict:
    lines = [l.strip() for l in open(path, encoding="cp1252", errors="replace")]
    tools = {}
    for i, l in enumerate(lines):
        if l.startswith("*") and i + 3 < len(lines):
            p = l[1:].split()
            try:
                d = [float(x) for x in lines[i + 2].split()]
                L = [float(x) for x in lines[i + 3].split()]
            except ValueError:
                continue
            shank = d[3] if d[3] > 0 else (d[1] if d[1] > 0 else d[0])
            segs = [(d[0], L[0])] + ([(d[1], L[1])] if d[1] > 0 else []) + [(shank, 1e9)]
            tools[p[0]] = {"name": p[0], "type": int(p[1]), "d": d[0], "l1": L[0], "total": L[4],
                           "free": L[4] - L[3], "segs": segs,
                           "holder_d": d[4] if len(d) > 4 and d[4] > 0 else 22.0, "holder_len": L[3]}
    return tools


def narrow_reach(tool, width):
    reach = 0.0
    for dia, length in tool["segs"]:
        if dia > width + 1e-6:
            break
        reach += length
    return reach


def feasible(tool, kind, size, r, mat, env) -> bool:
    if min(narrow_reach(tool, size), tool["free"]) + 1e-6 < mat or tool["free"] + 1e-6 < env:
        return False
    if kind == "HOLE":
        if tool["type"] == 1:
            return abs(tool["d"] - size) <= 0.15
        return tool["type"] == 0 and tool["d"] <= size + 1e-6
    if tool["type"] != 0:
        return False
    if kind == "SLOT":
        return tool["d"] <= size + 1e-6
    return tool["d"] <= size + 1e-6 and (not r or tool["d"] / 2 <= r + 1e-6)


def choose(tools: dict, allowed, kind, size, r, mat, env, collides=None):
    """Best allowed tool or (None, reason). collides(tool) -> list of colliding parts (collide.tool_hits);
    a tool that collides with the profile section is never chosen."""
    # With the section collision check the holder may go into open space inside the profile's outline (e.g. the
    # sash's open bottom channel, Krystian 2026-10-22 "hållaren kan gå fritt"), so the old envelope rule
    # (protrusion >= depth below the bounding box) only applies without it.
    if collides:
        env = 0.0
    ok = lambda t: feasible(t, kind, size, r, mat, env) and not (collides and collides(t))
    cands = [tools[n] for n in allowed if n in tools and ok(tools[n])]
    if not cands:
        others = [n for n, t in tools.items() if ok(t)]
        crash = [f"{n} krockar ({'+'.join(collides(tools[n]))})" for n in allowed
                 if n in tools and collides and feasible(tools[n], kind, size, r, mat, env) and collides(tools[n])]
        why = "; ".join(crash) if crash else f"inget av {','.join(allowed)} räcker (djup {mat:.1f}/{env:.1f} mm)"
        return None, f"{why}; klaras utan krock av: {', '.join(others) or 'inget verktyg i TOOLS.TXT'}"
    if kind == "HOLE":
        exact = [t for t in cands if abs(t["d"] - size) <= 0.15]
        if exact:
            # a drill before a mill of the same diameter (Krystian 2026-10-22: Ø5 holes with the drill, the F5
            # mill for the 5 mm slots), then the shortest tool
            return min(exact, key=lambda t: (t["type"] != 1, t["total"]))["name"], None
    return max(cands, key=lambda t: (t["d"], -t["total"]))["name"], None


def entry_distance(x, y, th, segs, fallback):
    """Distance from (x, y) along the inward normal (opposite to th) to the first contour crossing."""
    nx, ny = -math.cos(math.radians(th)), -math.sin(math.radians(th))
    best = None
    for (x1, y1), (x2, y2) in segs:
        dx, dy = x2 - x1, y2 - y1
        den = nx * dy - ny * dx
        if abs(den) < 1e-12:
            continue
        t = ((x1 - x) * dy - (y1 - y) * dx) / den
        u = ((x1 - x) * ny - (y1 - y) * nx) / den
        if t >= -1e-6 and -1e-9 <= u <= 1 + 1e-9:
            best = t if best is None else min(best, t)
    return max(0.0, best if best is not None else fallback)


def envelope_entry(x, y, th, bbox):
    nx, ny = -math.cos(math.radians(th)), -math.sin(math.radians(th))
    ts = []
    for lo, hi, p, n in ((bbox[0], bbox[2], x, nx), (bbox[1], bbox[3], y, ny)):
        if abs(n) < 1e-12:
            if not (lo - 1e-6 <= p <= hi + 1e-6):
                return 0.0
            ts.append(-1e9)
        else:
            ts.append(min((lo - p) / n, (hi - p) / n))
    return max(0.0, max(ts))


def dxf_segments(path):
    """Straight segments of all POLYLINE/LWPOLYLINE/LINE entities (arcs as chords)."""
    L = [l.strip() for l in open(path, encoding="cp1252", errors="replace")]
    segs, cur, kind = [], [], None
    def flush():
        if kind in ("POLYLINE", "LWPOLYLINE") and len(cur) > 1:
            segs.extend(zip(cur, cur[1:] + cur[:1]))
        elif kind == "LINE" and len(cur) == 2:
            segs.append((cur[0], cur[1]))
    i = 0
    while i < len(L) - 1:
        c, v = L[i], L[i + 1]
        if c == "0":
            if v in ("POLYLINE", "LWPOLYLINE", "LINE"):
                flush(); kind, cur = v, []
                if v == "LINE":
                    cur = [[0.0, 0.0], [0.0, 0.0]]
            elif v == "VERTEX":
                cur.append([0.0, 0.0])
            elif v in ("SEQEND", "ENDSEC") or (kind == "LINE" and v != "LINE"):
                flush(); kind, cur = (None if v != "VERTEX" else kind), []
        elif kind == "LWPOLYLINE" and c == "10":
            cur.append([float(v), 0.0])
        elif kind == "LWPOLYLINE" and c == "20" and cur:
            cur[-1][1] = float(v)
        elif kind == "POLYLINE" and cur and c in ("10", "20"):
            cur[-1][0 if c == "10" else 1] = float(v)
        elif kind == "LINE" and c in ("10", "20", "11", "21"):
            cur[0 if c in ("10", "20") else 1][0 if c in ("10", "11") else 1] = float(v)
        i += 2
    flush()
    return [(tuple(a), tuple(b)) for a, b in segs]
