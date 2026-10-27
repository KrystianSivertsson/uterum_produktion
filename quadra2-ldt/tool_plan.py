"""Which 4 Quadra2 tools cover the most operations in a set of ECW files?

Tool table: machine's real TOOLS.TXT (copied by Drill into OUTPUT.DEB). Per tool: type (0 mill, 1 drill,
2 countersink), D1, cutting length L1. An op is feasible with a tool when:
  hole   : mill D1 <= D (exact = plunge, smaller = interpolation); drill only if |D1 - D| <= 0.15
  slot   : mill D1 <= width
  rect   : mill D1 <= min(L, H) and D1/2 <= corner radius (if r > 0)
  depth  : L1 >= depth into material (final depth - WHeight offset, min 0.5)
Usage: python tool_plan.py <tools.txt or OUTPUT.DEB> <ecw> [<ecw> ...]
"""
import itertools, math, os, sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ecw
from quadra import final_depth

sys.stdout.reconfigure(encoding="utf-8")


def read_tools(path):
    lines = [l.strip() for l in open(path, encoding="cp1252", errors="replace")]
    tools = {}
    for i, l in enumerate(lines):
        if l.startswith("* ") and i + 3 < len(lines):
            p = l[1:].split()
            try:
                d = [float(x) for x in lines[i + 2].split()]
                L = [float(x) for x in lines[i + 3].split()]
            except ValueError:
                continue
            total = L[4] if len(L) > 4 else 0
            # Tool profile from the tip: D1 for L1, then D2 for L2 (stepped tools), then the shank up to the holder.
            # free = protrusion below the holder (holder Ø ~22 never enters a feature).
            shank = d[3] if d[3] > 0 else (d[1] if d[1] > 0 else d[0])
            segs = [(d[0], L[0])] + ([(d[1], L[1])] if d[1] > 0 else []) + [(shank, 1e9)]
            tools[p[0]] = {"type": int(p[1]), "d": d[0], "l1": L[0], "total": total, "free": total - L[3], "segs": segs,
                           "row": f"Ø{d[0]:g}x{L[0]:g}" + (f"+Ø{d[1]:g}x{L[1]:g}" if d[1] > 0 else "") + f" skaft Ø{shank:g} utstick {total - L[3]:.1f}"}
    return tools


def entry_distance(w, bar, segs):
    """Distance from the ECW reference point to where the tool axis first enters the profile contour."""
    from quadra import face_point
    fp = face_point(w, bar)
    if fp is None or not segs:
        return max(0.0, w.f("WHeight"))
    x, y, th = fp
    nx, ny = -math.cos(math.radians(th)), -math.sin(math.radians(th))   # inward direction
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
    return max(0.0, best if best is not None else w.f("WHeight"))


def envelope_entry(w, bar):
    """Distance from the reference point to the profile's bounding box along the tool axis."""
    from quadra import face_point
    fp = face_point(w, bar)
    if fp is None:
        return max(0.0, w.f("WHeight"))
    x, y, th = fp
    nx, ny = -math.cos(math.radians(th)), -math.sin(math.radians(th))
    ts = []
    for lo, hi, p, n in ((0, bar.width, x, nx), (0, bar.height, y, ny)):
        if abs(n) < 1e-12:
            if not (lo - 1e-6 <= p <= hi + 1e-6):
                return 0.0
            ts.append((-1e9, 1e9))
        else:
            a, b = (lo - p) / n, (hi - p) / n
            ts.append((min(a, b), max(a, b)))
    t_in = max(ts[0][0], ts[1][0])
    return max(0.0, t_in)


def requirements(path, dxf_dir=r"C:\Quadra2\CAM\DXF\SCHUECO"):
    from check_sides import dxf_segments
    job = ecw.read(path)
    reqs = []
    for bar in job.bars:
        dxf = os.path.join(dxf_dir, f"{bar.ident}.DXF")
        segs = dxf_segments(dxf) if os.path.exists(dxf) else []
        for cut in bar.cuts:
            for w in ecw.flatten(job, cut):
                t = w.wtype
                if t not in ("C", "D", "L", "R"):
                    continue
                fd = final_depth(w)
                mat = max(0.5, fd - entry_distance(w, bar, segs))          # depth inside material (needs L1)
                env = max(0.5, fd - envelope_entry(w, bar))                 # depth below outer envelope (needs free length)
                lab = (w.s("WComment") or w.kv.get("_comment", ""))[:28]
                if t in ("C", "D"):
                    reqs.append(("hål", w.f("WW1"), None, (mat, env), bar.ident, lab))
                elif t == "L":
                    reqs.append(("spår", w.f("WW2"), None, (mat, env), bar.ident, lab))
                else:
                    reqs.append(("rekt", min(w.f("WW1"), w.f("WW2")), w.f("WW3"), (mat, env), bar.ident, lab))
    return reqs


def narrow_reach(tool, width):
    """How deep the tool can enter a feature of the given width before a wider section reaches it."""
    reach = 0.0
    for dia, length in tool["segs"]:
        if dia > width + 1e-6:
            break
        reach += length
    return reach


def ok(tool, req):
    kind, size, r, (mat, env) = req[:4]
    if min(narrow_reach(tool, size), tool["free"]) + 1e-6 < mat or tool["free"] + 1e-6 < env:
        return False
    if kind == "hål":
        if tool["type"] == 1:
            return abs(tool["d"] - size) <= 0.15
        return tool["type"] == 0 and tool["d"] <= size + 1e-6
    if tool["type"] != 0:
        return False
    if kind == "spår":
        return tool["d"] <= size + 1e-6
    return tool["d"] <= size + 1e-6 and (not r or tool["d"] / 2 <= r + 1e-6)



def dfmt(d):
    return f"{d[0]:.1f}/{d[1]:.1f}"


def rkey(r):
    return (r[0], round(r[1], 2), r[2], (round(r[3][0], 1), round(r[3][1], 1)), r[4], r[5])


def report_combo(tools, reqs, combo):
    cov = [r for r in reqs if any(ok(tools[c], r) for c in combo)]
    miss = Counter(rkey(r) for r in reqs if not any(ok(tools[c], r) for c in combo))
    print(f"\nUppsättning {', '.join(combo)}: klarar {len(cov)} av {len(reqs)}")
    for k, n in sorted(miss.items(), key=lambda kv: (kv[0][4], kv[0][0], kv[0][1])):
        need = [name for name, t in tools.items() if ok(t, k[:4])]
        print(f"   saknas x{n:<4} {k[4]:<8} {k[0]:<4} {k[1]:>5} r={k[2] or '-'} djup gods/kontur {dfmt(k[3]):>11}  {k[5]:<28} (klaras av: {', '.join(need) or 'inget'})")


def main():
    args = sys.argv[1:]
    combos, top = [], 8
    while "--combo" in args:
        i = args.index("--combo"); combos.append(args[i + 1].split(",")); del args[i:i + 2]
    tools = read_tools(args[0])
    reqs = []
    for p in args[1:]:
        reqs += requirements(p)
    uniq = Counter(rkey(r) for r in reqs)
    print(f"{len(reqs)} bearbetningar, {len(uniq)} unika krav  (djup = i godset / under ytterkonturen)")
    for k, n in sorted(uniq.items(), key=lambda kv: (kv[0][4], kv[0][0], kv[0][1])):
        cands = [name for name, t in tools.items() if ok(t, k[:4])]
        print(f"  {k[4]:<8} {k[0]:<4} {k[1]:>6} r={k[2] or '-':<4} djup {dfmt(k[3]):>11}  x{n:<4} {k[5]:<28} -> {', '.join(cands) or 'INGET'}")
    for c in combos:
        report_combo(tools, reqs, c)
    names = [n for n, t in tools.items() if t["type"] in (0, 1)]
    best = []
    for combo in itertools.combinations(names, 4):
        cov = sum(1 for r in reqs if any(ok(tools[c], r) for c in combo))
        exact = sum(1 for r in reqs if r[0] == "hål" and any(abs(tools[c]["d"] - r[1]) < 0.15 and ok(tools[c], r) for c in combo))
        best.append((cov, exact, -sum(tools[c]["total"] for c in combo), combo))
    best.sort(reverse=True)
    print(f"\nBästa kombinationer (av {len(reqs)}):")
    for cov, exact, negl, combo in best[:top]:
        miss = Counter((r[4], r[0], r[1]) for r in reqs if not any(ok(tools[c], r) for c in combo))
        print(f"  {cov:4d}  exakta hål {exact:4d}  {', '.join(combo):<26} saknas: {dict(miss) if miss else '-'}")


if __name__ == "__main__":
    main()
