"""Collision check in the profile section: for every machining, the stepped tool + holder at final depth.
A tool part collides when its swept footprint (diameter + the figure's sideways travel) reaches profile material
outside the column that the operation itself mills away. The spindle nose beyond the holder is not modelled;
its clearance (holder end -> nearest material along the axis) is reported instead.
Usage: collision.py <ecw> [--name kindrot] [--png DIR] [--cuts 103,104]"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union, polygonize
from shapely import affinity
import ecw, ldtwriter, toolsel
from quadra import Position, build_piece
from ecw2ldt import piece_groups

ap = argparse.ArgumentParser()
ap.add_argument("ecw"); ap.add_argument("--png", default=""); ap.add_argument("--cuts", default="")
ap.add_argument("--tools-txt", default=r"C:\Quadra2\CAM\TOOLS.TXT"); ap.add_argument("--dxf-dir", default=r"C:\Quadra2\CAM\DXF\SCHUECO")
a = ap.parse_args()

# holder diameter/length straight from TOOLS.TXT (line 3 field 5, line 4 field 4)
holder = {}
lines = [l.strip() for l in open(a.tools_txt, encoding="cp1252", errors="replace")]
for i, l in enumerate(lines):
    if l.startswith("*") and i + 3 < len(lines):
        try:
            d = [float(x) for x in lines[i + 2].split()]; L = [float(x) for x in lines[i + 3].split()]
            holder[l[1:].split()[0]] = (d[4], L[3])
        except (ValueError, IndexError):
            pass
tools = toolsel.read_tools(a.tools_txt)
job = ecw.read(a.ecw)
only = {int(x) for x in a.cuts.split(",") if x.strip()}
pos = Position()


def section(dxf):
    faces = list(polygonize(unary_union([LineString(s) for s in toolsel.dxf_segments(dxf)])))
    mat = faces[0]
    for f in faces[1:]:
        mat = mat.symmetric_difference(f)
    return mat


def strip(p0, u, a0, a1, half):
    """Rectangle along unit axis u from p0 + a0*u to p0 + a1*u, half-width `half`."""
    n = (-u[1], u[0])
    pts = [(p0[0] + u[0] * s + n[0] * h, p0[1] + u[1] * s + n[1] * h) for s, h in ((a0, -half), (a1, -half), (a1, half), (a0, half))]
    return Polygon(pts)


def across(op):
    if op.fig == "HOLE":
        return op.params[0]
    L, H = op.params[0], op.params[1]
    t = math.radians(op.fig_angle)
    return abs(L * math.sin(t)) + abs(H * math.cos(t))


results = []
for bar in job.bars:
    dxf = os.path.join(a.dxf_dir, f"{bar.ident}.DXF")
    bbox = ldtwriter.dxf_bbox(dxf)
    mat = affinity.translate(section(dxf), -bbox[0], -bbox[1])      # position 0: W/H from the bbox min
    segs = toolsel.dxf_segments(dxf)
    seen = {}
    for cuts in piece_groups(bar, True):
        cuts = [c for c in cuts if not only or c.no in only]
        if not cuts:
            continue
        name = "-".join(str(c.no) for c in cuts)
        for c in cuts:
            piece = build_piece(job, bar, c, bbox, pos, segs, tools)
            for op in piece.ops:
                th = math.radians(op.theta)
                u = (-math.cos(th), -math.sin(th))                  # into the material
                depth = -op.ze
                tip = (op.w + u[0] * depth, op.h + u[1] * depth)
                back = (-u[0], -u[1])                               # from the tip towards the spindle
                acr = across(op)
                t = tools[op.tool]
                lat = max(0.0, acr / 2 - t["d"] / 2)
                column = strip(tip, back, -0.01, 500, acr / 2)
                parts, s = [], 0.0
                for dia, length in t["segs"]:
                    e = min(s + length, t["free"])
                    if e > s:
                        parts.append((f"Ø{dia:g}", strip(tip, back, s, e, dia / 2 + lat)))
                    s = e
                    if s >= t["free"]:
                        break
                hd, hl = holder.get(op.tool, (22.0, 40.0))
                parts.append((f"hållare Ø{hd:g}", strip(tip, back, t["free"], t["free"] + hl, hd / 2 + lat)))
                hits = []
                for pname, poly in parts:
                    inter = poly.difference(column).intersection(mat)
                    if inter.area > 0.05:
                        hits.append(f"{pname} {inter.area:.1f} mm²")
                # clearance of the spindle nose: from holder end back along the axis to the profile's far side
                nose = (tip[0] + back[0] * (t["free"] + hl), tip[1] + back[1] * (t["free"] + hl))
                key = (round(op.theta), round(op.w, 1), round(op.h, 1), round(depth, 1), op.fig, op.params, op.tool)
                if key in seen:
                    seen[key]["pieces"].add(name); seen[key]["n"] += 1
                    continue
                d_nose = mat.distance(LineString([nose, (nose[0] + back[0] * 0.001, nose[1] + back[1] * 0.001)]))
                seen[key] = dict(piece=name, pieces={name}, op=op, hits=hits, n=1, parts=parts, column=column, tip=tip,
                                 nose=nose, nose_clear=d_nose, mat=mat, prof=bar.ident)
    results += list(seen.values())

def hits_with(op, tname, mat):
    """Collision list for op if it were made with tool tname (any tool in TOOLS.TXT)."""
    th = math.radians(op.theta); u = (-math.cos(th), -math.sin(th)); back = (-u[0], -u[1])
    depth = -op.ze; tip = (op.w + u[0] * depth, op.h + u[1] * depth); acr = across(op)
    t = tools[tname]; lat = max(0.0, acr / 2 - t["d"] / 2)
    column = strip(tip, back, -0.01, 500, acr / 2)
    out, s = [], 0.0
    for dia, length in t["segs"]:
        e = min(s + length, t["free"])
        if e > s:
            g = strip(tip, back, s, e, dia / 2 + lat).difference(column).intersection(mat)
            if g.area > 0.05:
                out.append(f"Ø{dia:g}")
        s = e
        if s >= t["free"]:
            break
    hd, hl = holder.get(tname, (22.0, 40.0))
    g = strip(tip, back, t["free"], t["free"] + hl, hd / 2 + lat).difference(column).intersection(mat)
    if g.area > 0.05:
        out.append("hållare")
    return out


for r in results:
    op = r["op"]
    status = "KROCK: " + ", ".join(r["hits"]) if r["hits"] else "ok"
    print(f"{r['prof']} {op.fig:<9} B{op.b:+5.0f} W{op.w:6.1f} H{op.h:6.1f} djup {-op.ze:5.1f} {str(op.params):<18} {op.tool:<4} "
          f"x{r['n']:<3} spindelnos {r['nose_clear']:5.1f} mm från godset  {status}   ({op.source.split(' ', 6)[-1][:30]})")
    if r["hits"]:
        kind, size = op.fig, (op.params[0] if op.fig == "HOLE" else min(op.params[0], op.params[1]))
        alts = []
        for tn, tv in sorted(tools.items(), key=lambda kv: kv[1]["d"]):
            fits = (abs(tv["d"] - size) <= 0.6) if tv["type"] == 1 else (tv["type"] == 0 and tv["d"] <= size + 1e-6)
            if kind == "HOLE" and tv["type"] == 1 and abs(tv["d"] - size) > 0.6:
                continue
            if tv["type"] == 2 or not fits:
                continue
            h = hits_with(op, tn, r["mat"])
            alts.append(f"{tn}(Ø{tv['d']:g}{' borr' if tv['type'] == 1 else ''}): {'OK' if not h else 'krock ' + '+'.join(h)}")
        print("      alternativ:", " | ".join(alts))

if a.png:
    from PIL import Image, ImageDraw
    os.makedirs(a.png, exist_ok=True)
    S, M = 6, 140                                                  # px per mm, margin mm
    for i, r in enumerate(results):
        mat = r["mat"]; b = mat.bounds
        W, H = int((b[2] - b[0] + 2 * M) * S), int((b[3] - b[1] + 2 * M) * S)
        img = Image.new("RGB", (W, H), "white"); dr = ImageDraw.Draw(img)
        tr = lambda x, y: ((x - b[0] + M) * S, H - (y - b[1] + M) * S)
        def poly(g, fill, outline):
            for p in getattr(g, "geoms", [g]):
                if p.is_empty or p.geom_type != "Polygon":
                    continue
                dr.polygon([tr(*c) for c in p.exterior.coords], fill=fill, outline=outline)
                for hole in p.interiors:
                    dr.polygon([tr(*c) for c in hole.coords], fill="white", outline=outline)
        poly(mat, (200, 200, 200), (60, 60, 60))
        poly(r["column"].intersection(mat), (120, 170, 255), (0, 0, 200))
        for pname, p in r["parts"]:
            hit = p.difference(r["column"]).intersection(mat)
            dr.polygon([tr(*c) for c in p.exterior.coords], outline=(0, 120, 0) if "håll" not in pname else (150, 90, 0))
            poly(hit, (255, 0, 0), (200, 0, 0))
        op = r["op"]
        dr.text((10, 10), f"{r['prof']} {op.fig} {op.params} B{op.b:+.0f} W{op.w:.1f} H{op.h:.1f} djup {-op.ze:.1f} {op.tool}  "
                f"{'KROCK' if r['hits'] else 'ok'}", fill="black")
        img.save(os.path.join(a.png, f"{i:02d}_{'KROCK' if r['hits'] else 'ok'}_{op.fig}_B{op.b:+.0f}.png"))
