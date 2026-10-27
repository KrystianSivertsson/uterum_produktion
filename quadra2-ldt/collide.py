"""Tool collision check in the profile section (the plane the Quadra2 spindle turns in).

At final depth the tool is a stack of cylinders along its axis: from the tip D1 for L1, then D2 for L2 ...
up to the free length (TOOLS.TXT total - holder length), then the holder (TOOLS.TXT holder diameter/length).
In the section each part sweeps a strip: its diameter plus the figure's sideways travel (hole/slot/pocket
wider than the tool). The operation itself mills away a column (figure width, from the tip back along the axis);
a part collides when its strip reaches profile material outside that column.

Found 2026-10-14: the sash 517340A glue/nail holes Ø5 from below (31 mm of air through the open bottom channel,
then the web) are made on the SBZ151 with a long Ø5 tool; F3L's Ø12 step behind its 25 mm of Ø3 hits the
channel's hook. CAMplus' simulation does not report this.
"""
from __future__ import annotations

import math

from shapely import affinity
from shapely.geometry import LineString, Polygon
from shapely.ops import polygonize, unary_union

MIN_AREA = 0.05   # mm² of overlap that counts as a collision (below: numerical noise on touching edges)
# Holder and spindle (Krystian 2026-10-23: "muttern är 22 och 30 lång sen kommer fräsens utstick", "35x10 bakom
# muttern sen tar motorn i"): collet nut with the TOOLS.TXT holder diameter for NUT_LEN from its nose, then Ø BODY_D
# up to the TOOLS.TXT holder length (F8L 39.7 = 30 + ~10), then the spindle motor. The motor's size is not measured;
# CAMplus' own head model (C:\CAMplus\Parts\Quadra386.stp) has cylinders of Ø90/96/113 around the spindles, so the
# largest is used. It must stay out of the profile completely.
NUT_LEN = 30.0
BODY_D = 35.0
MOTOR_NOSE_LEN = 11.0   # "den är samma som hållaren 11mm sen blir den bredare" (Krystian 2026-10-23)
MOTOR_D = 113.0
MOTOR_LEN = 150.0


def section(segs, bbox, pos) -> Polygon:
    """Profile material in the positioned CAMplus frame (W/H from the rotated bbox min, as quadra.position)."""
    import quadra
    faces = list(polygonize(unary_union([LineString(s) for s in segs])))
    mat = faces[0]
    for f in faces[1:]:
        mat = mat.symmetric_difference(f)       # nested faces = chambers
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    mat = affinity.rotate(mat, pos.angle, origin=(cx, cy))
    if pos.mirror:
        mat = affinity.scale(mat, xfact=-1, yfact=1, origin=(cx, cy))
    bb = quadra.positioned_bbox(bbox, pos)
    return affinity.translate(mat, pos.off_w - bb[0], pos.off_h - bb[1])


def _strip(p0, u, a0, a1, half):
    n = (-u[1], u[0])
    return Polygon([(p0[0] + u[0] * s + n[0] * h, p0[1] + u[1] * s + n[1] * h)
                    for s, h in ((a0, -half), (a1, -half), (a1, half), (a0, half))])


def across(fig: str, params: tuple, fig_angle: float) -> float:
    """Figure width in the section plane (perpendicular to the bar)."""
    if fig == "HOLE":
        return params[0]
    L, H = params[0], params[1]
    t = math.radians(fig_angle)
    return abs(L * math.sin(t)) + abs(H * math.cos(t))


def tool_hits(tool: dict, theta: float, w: float, h: float, depth: float, width: float, mat) -> list[str]:
    """Names of the tool parts that collide, [] when free. theta = outward normal, (w, h) reference point,
    depth = final depth below it, width = figure width across (see across())."""
    th = math.radians(theta)
    u = (-math.cos(th), -math.sin(th))
    back = (-u[0], -u[1])
    tip = (w + u[0] * depth, h + u[1] * depth)
    lat = max(0.0, width / 2 - tool["d"] / 2)
    column = _strip(tip, back, -0.01, 1000.0, width / 2)
    out, s = [], 0.0
    for dia, length in tool["segs"]:
        e = min(s + length, tool["free"])
        if e > s and _strip(tip, back, s, e, dia / 2 + lat).difference(column).intersection(mat).area > MIN_AREA:
            out.append(f"Ø{dia:g}")
        s = e
        if s >= tool["free"]:
            break
    hd, hl = tool.get("holder_d", 22.0), tool.get("holder_len", 40.0)
    f0 = tool["free"]
    if _strip(tip, back, f0, f0 + NUT_LEN, hd / 2 + lat).difference(column).intersection(mat).area > MIN_AREA:
        out.append(f"mutter Ø{hd:g}")
    b1 = f0 + max(hl, NUT_LEN) + MOTOR_NOSE_LEN       # holder body + the motor's front, both Ø BODY_D
    if _strip(tip, back, f0 + NUT_LEN, b1, BODY_D / 2 + lat).difference(column).intersection(mat).area > MIN_AREA:
        out.append(f"hållare/motorns främre del (Ø{BODY_D:g})")
    m0 = b1
    if _strip(tip, back, m0, m0 + MOTOR_LEN, MOTOR_D / 2 + lat).difference(column).intersection(mat).area > MIN_AREA:
        out.append(f"motor (Ø{MOTOR_D:g})")
    return out
