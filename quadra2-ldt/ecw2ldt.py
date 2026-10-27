"""ECW (eluCad/NC-X, as written by ase60-generator) -> CAMplus LDT programs for the Emmegi Quadra2.

One LDT per physical piece ([A]/[B] flip passes of the same piece are merged). Usage:
  python ecw2ldt.py <file.ecw> [--out DIR] [--series SCHUECO] [--dxf-dir C:\\Quadra2\\CAM\\DXF]
                    [--pos 0] [--mirror 0] [--cuts 101,103]
Writes <out>/<order>_<CNo[-CNo]>_<profile>.ldt plus <out>/rapport.txt (all ops + warnings).
"""
from __future__ import annotations

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import ecw  # noqa: E402
import ldtwriter  # noqa: E402
import quadra  # noqa: E402
import toolsel  # noqa: E402
from quadra import Position, build_piece  # noqa: E402


# Profiles that are not run in the Quadra2 (Krystian 2026-10-23): the glazing bar used as outer cover (460640F,
# "ytterlock") and the cover on the frame (490240H, "innerlock"/täcklock). Only frame + sash go to the Quadra.
NOT_QUADRA = {"460640F": "glaslist/ytterlock", "490240H": "täcklock/innerlock"}


def section_asymmetry(segs, bbox) -> float:
    """Largest distance (mm) between the DXF contour and its mirror image across the vertical centre line."""
    from shapely import affinity
    from shapely.geometry import LineString
    from shapely.ops import unary_union
    g = unary_union([LineString(s) for s in segs])
    return g.hausdorff_distance(affinity.scale(g, xfact=-1, yfact=1, origin=((bbox[0] + bbox[2]) / 2, 0)))


def safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", s).strip("_")[:40] or "job"


def piece_groups(bar: ecw.Bar, merge: bool) -> list[list[ecw.Cut]]:
    """Cuts that are one physical piece. ase60-generator splits a piece that needs both sides into
    "[A: standardläge]" + "[B: 180 flipp]" (CRotation 2) because the SBZ151 cannot reach underneath;
    the Quadra2 turns its spindle around the bar, so both passes become one program."""
    groups: dict[tuple, list[ecw.Cut]] = {}
    for cut in bar.cuts:
        key = (cut.description.split("[")[0].strip(), round(cut.length, 2)) if merge else (cut.no,)
        groups.setdefault(key, []).append(cut)
    return list(groups.values())


def short_desc(desc: str, order: str) -> str:
    """Piece description without the customer name and the pass tag (the LDT field holds 39 chars)."""
    d = desc.split("[")[0]
    cust = order.replace("_", " ").strip()
    if cust and d.lower().startswith(cust.lower()):
        d = d[len(cust):]
    return " ".join(d.split())


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ecw")
    ap.add_argument("--out", default=None)
    ap.add_argument("--series", default="SCHUECO")
    ap.add_argument("--dxf-dir", default=r"C:\Quadra2\CAM\DXF")
    ap.add_argument("--pos", type=float, default=0.0, help="profile position angle (CAMplus DPROFILE); 0 = lying flat as on the SBZ151 (verified: gives the correct frame mitre)")
    ap.add_argument("--mirror", type=int, default=0)
    ap.add_argument("--cuts", default="", help="comma separated CNo filter")
    ap.add_argument("--tools", default=",".join(toolsel.DEFAULT_SET), help="the 4 tools mounted in the rotary base")
    ap.add_argument("--tools-txt", default=r"C:\Quadra2\CAM\TOOLS.TXT")
    ap.add_argument("--no-merge", action="store_true", help="one LDT per :CUT (do not merge [A]/[B] passes)")
    ap.add_argument("--name", default="", help="file name prefix instead of the ECW order (AKTIVERA writes the first "
                                                "parti label, e.g. framsida_1, as order)")
    ap.add_argument("--all-profiles", action="store_true", help="also make programs for profiles in NOT_QUADRA")
    ap.add_argument("--flip-ops", action="store_true", help="mirror the machinings across the profile's vertical centre "
                                                            "line, as eluCad shows the frame 487850A (symmetric "
                                                            "profiles only)")
    a = ap.parse_args(argv)

    tools = toolsel.read_tools(a.tools_txt)
    allowed = tuple(t.strip() for t in a.tools.split(",") if t.strip())
    missing = [t for t in allowed if t not in tools]
    if missing:
        raise SystemExit(f"Verktyg saknas i {a.tools_txt}: {missing}")
    job = ecw.read(a.ecw)
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.ecw)), "quadra2_" + safe(job.order))
    os.makedirs(out, exist_ok=True)
    pos = Position(angle=a.pos, mirror=a.mirror)
    only = {int(x) for x in a.cuts.split(",") if x.strip()}
    report = [f"ECW: {a.ecw}", f"Order: {job.order}", f"Profilläge: {pos.angle:g}° spegling {pos.mirror}"
              + ("  bearbetningarna speglade som i eluCad (--flip-ops)" if a.flip_ops else ""),
              f"Verktyg i maskinen: {', '.join(allowed)}", ""]
    n_files = 0
    skipped = set()
    for bar in job.bars:
        if bar.ident in NOT_QUADRA and not a.all_profiles:
            if bar.ident not in skipped:
                report.append(f"-- {bar.ident} ({NOT_QUADRA[bar.ident]}) körs inte i Quadra2 - inga program (--all-profiles tvingar)")
                skipped.add(bar.ident)
            continue
        dxf = os.path.join(a.dxf_dir, a.series, f"{bar.ident}.DXF")
        if not os.path.exists(dxf):
            report.append(f"!! {bar.ident}: DXF saknas ({dxf}) - stången hoppas över")
            continue
        bbox = ldtwriter.dxf_bbox(dxf)
        segs = toolsel.dxf_segments(dxf)
        pos = quadra.keep_min(bbox, a.pos, a.mirror)    # DPROFILE offsets per profile, as CAMplus sets them
        if a.flip_ops:
            asym = section_asymmetry(segs, bbox)
            if asym > 0.1:
                raise SystemExit(f"--flip-ops: {bar.ident} är inte symmetrisk ({asym:.2f} mm) - spegling skulle flytta "
                                 f"bearbetningarna bort från profilen")
            pos.flip_ops = True
        for cuts in piece_groups(bar, not a.no_merge):
            cuts = [c for c in cuts if not only or c.no in only]
            if not cuts:
                continue
            parts = [build_piece(job, bar, c, bbox, pos, segs, tools, allowed) for c in cuts]
            piece = parts[0]
            for p in parts[1:]:
                if (abs(p.angle_left - piece.angle_left) > 1e-6 or abs(p.angle_right - piece.angle_right) > 1e-6
                        or abs(p.length - piece.length) > 1e-6):
                    piece.warnings.append(f"CNo {p.cut_no}: längd/vinklar {p.length:g} {p.angle_left:g}/{p.angle_right:g} "
                                          f"skiljer sig från CNo {piece.cut_no} - kontrollera sammanslagningen")
                piece.ops.extend(p.ops)
                piece.warnings.extend(p.warnings)
            cnos = "-".join(str(c.no) for c in cuts)
            name = f"{safe(a.name or job.order)}_{cnos}_{bar.ident}"
            path = os.path.join(out, name + ".ldt")
            desc = f"{cnos} {short_desc(cuts[0].description, job.order)}"[:39]
            ldtwriter.write_ldt(path, piece, a.series, dxf, pos, desc, tools_txt=a.tools_txt)
            n_files += 1
            passes = "  +  ".join(f"CNo {c.no} {c.description} (vridning {c.rotation}, spegling {c.mirror})" for c in cuts)
            report.append(f"== {name}.ldt  L={piece.length:g}  vinklar {piece.angle_left:g}/{piece.angle_right:g}  "
                          f"{len(piece.ops)} bearbetningar")
            report.append(f"   från {passes}")
            for i, op in enumerate(piece.ops, 1):
                report.append(f"   #{i:<3} {op.fig:<9} B={op.b:+7.1f}  X={op.x:8.2f}  W={op.w:8.2f}  H={op.h:8.2f}  "
                              f"Ze={op.ze:7.2f}  {op.params}  vinkel {op.fig_angle:g}  {op.tool}"
                              f"{'  urfräsning' if op.emptying else ''}   <- {op.source}")
            for w in piece.warnings:
                report.append(f"   !! {w}")
    report.append("")
    report.append(f"{n_files} LDT-filer skrivna till {out}")
    with open(os.path.join(out, "rapport.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(report) + "\n")
    print("\n".join(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
