"""Which 4 Quadra2 tools cover the most operations — with the generator's real geometry (eluCad face mapping,
CRotation/CMirror) and the section collision check (collide.py). Replaces tool_plan.py (old face model, no
collisions). Usage: python tool_plan2.py <ecw> [<ecw> ...] [--combo F3L,F4,F6,F8L] [--top 10]"""
import itertools, os, sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding="utf-8")
import collide, ecw, ldtwriter, toolsel
from quadra import RECT_R_MARGIN, Position, face_point, final_depth, position

DXF_DIR = r"C:\Quadra2\CAM\DXF\SCHUECO"


def requirements(path, tools, pos=Position()):
    """[(key, ok_tool_names)] per operation; key describes the unique requirement."""
    job = ecw.read(path)
    out = []
    for bar in job.bars:
        dxf = os.path.join(DXF_DIR, f"{bar.ident}.DXF")
        if not os.path.exists(dxf):
            continue
        bbox = ldtwriter.dxf_bbox(dxf); segs = toolsel.dxf_segments(dxf); sect = collide.section(segs, bbox, pos)
        cache = {}
        for cut in bar.cuts:
            for w in ecw.flatten(job, cut):
                t = w.wtype
                if t not in ("C", "D", "L", "R"):
                    continue
                fp = face_point(w, bar, cut.rotation, cut.mirror)
                if fp is None:
                    continue
                xd, yd, thd = fp
                wp, hp, th = position(xd, yd, thd, bbox, pos)
                depth = final_depth(w)
                mat = max(0.5, depth - toolsel.entry_distance(xd, yd, thd, segs, max(0.0, w.f("WHeight"))))
                env = max(0.5, depth - toolsel.envelope_entry(xd, yd, thd, bbox))
                lab = (w.s("WComment") or w.kv.get("_comment", ""))[:28]
                if t in ("C", "D"):
                    kind, size, r, fig, params, ang = "HOLE", w.f("WW1"), None, "HOLE", (w.f("WW1"),), 0.0
                elif t == "L":
                    kind, size, r, fig, params, ang = "SLOT", w.f("WW2"), None, "SLOT", (w.f("WW1"), w.f("WW2")), w.f("WAngle")
                else:
                    L, H, r = w.f("WW1"), w.f("WW2"), w.f("WW3")
                    if r >= min(L, H) / 2 - RECT_R_MARGIN / 2:
                        r = round(min(L, H) / 2 - RECT_R_MARGIN, 3)
                    kind, size, fig, params, ang = "RECTANGLE", min(L, H), "RECTANGLE", (L, H), w.f("WAngle")
                width = collide.across(fig, params, ang)
                key = (bar.ident, kind, round(size, 2), r, round(th), round(wp, 1), round(hp, 1), round(depth, 1),
                       round(width, 1), lab)
                if key not in cache:
                    cache[key] = frozenset(n for n, tl in tools.items() if tl["type"] in (0, 1)
                                           and toolsel.feasible(tl, kind, size, r, mat, 0.0)   # holder may enter open space; collision decides
                                           and not collide.tool_hits(tl, th, wp, hp, depth, width, sect))
                out.append((key, cache[key]))
    return out


def main():
    args = sys.argv[1:]
    combos, top, fixed, extra = [], 10, [], []
    while "--combo" in args:
        i = args.index("--combo"); combos.append(tuple(args[i + 1].split(","))); del args[i:i + 2]
    if "--top" in args:
        i = args.index("--top"); top = int(args[i + 1]); del args[i:i + 2]
    while "--fixed" in args:   # tool that must be in every set
        i = args.index("--fixed"); fixed.append(args[i + 1]); del args[i:i + 2]
    while "--extra" in args:   # virtual tool NAME:type:D:L1:total[:holderD:holderLen], e.g. P5L:1:5:52:86
        i = args.index("--extra"); extra.append(args[i + 1].split(":")); del args[i:i + 2]
    tools = toolsel.read_tools()
    for e in extra:
        name, typ, d, l1, total = e[0], int(e[1]), float(e[2]), float(e[3]), float(e[4])
        hd, hl = (float(e[5]), float(e[6])) if len(e) > 6 else (23.0, 35.0)   # as P4.75 in TOOLS.TXT
        tools[name] = dict(name=name, type=typ, d=d, l1=l1, total=total, free=total - hl,
                           segs=[(d, l1), (d, 1e9)], holder_d=hd, holder_len=hl)
    reqs = []
    for p in args:
        reqs += requirements(p, tools)
    uniq = Counter(k for k, _ in reqs)
    oks = dict(reqs)
    print(f"{len(reqs)} bearbetningar ur {len(args)} ECW, {len(uniq)} unika krav")
    for k, n in sorted(uniq.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2])):
        if len(oks[k]) <= 3:
            print(f"  få verktyg: {k[0]} {k[1]:<9} {k[2]:>5} r={k[3] or '-'} B{k[4] - 90:+4d} W{k[5]} H{k[6]} djup {k[7]}  x{n:<4} {k[9]:<28} -> {', '.join(sorted(oks[k])) or 'INGET'}")

    def score(combo):
        cov = sum(n for k, n in uniq.items() if oks[k] & set(combo))
        return cov

    for c in combos:
        miss = {k: n for k, n in uniq.items() if not (oks[k] & set(c))}
        print(f"\nUppsättning {', '.join(c)}: klarar {score(c)} av {len(reqs)}")
        for k, n in sorted(miss.items()):
            print(f"   saknas x{n:<4} {k[0]} {k[1]:<9} {k[2]:>5} B{k[4] - 90:+4d} W{k[5]} H{k[6]} djup {k[7]}  {k[9]:<28} (klaras av: {', '.join(sorted(oks[k])) or 'inget'})")
    names = sorted(n for n, t in tools.items() if t["type"] in (0, 1) and n not in fixed)
    tot = Counter()
    for k, n in uniq.items():
        tot["hål" if k[1] == "HOLE" else "fräs"] += n
    def by_kind(c):
        got = Counter()
        for k, n in uniq.items():
            if oks[k] & set(c):
                got["hål" if k[1] == "HOLE" else "fräs"] += n
        return got
    best = sorted(((score(tuple(fixed) + c), by_kind(tuple(fixed) + c)["fräs"], -sum(tools[x]["total"] for x in c), tuple(fixed) + c)
                   for c in itertools.combinations(names, 4 - len(fixed))), reverse=True)
    print(f"\nBästa fyrverktygsuppsättningar (av {len(reqs)}: {tot['hål']} hål, {tot['fräs']} fräsningar = spår/fickor)"
          + (f", låst: {', '.join(fixed)}" if fixed else "") + ":")
    for cov, _, _, c in best[:top]:
        miss = Counter()
        for k, n in uniq.items():
            if not (oks[k] & set(c)):
                miss[(k[0], k[1], k[2], k[9])] += n
        g = by_kind(c)
        print(f"  {cov:4d}  (hål {g['hål']}, fräs {g['fräs']})  {', '.join(c):<30} saknas: {dict(miss) if miss else '-'}")


if __name__ == "__main__":
    main()
