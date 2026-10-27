"""Map flattened ECW operations to CAMplus (Quadra2) machinings.

Coordinate model (all verified, see README.md):
  * ECW face frames follow ase60-generator's verified SBZ kinematics (server/auf/kinematics.ts):
    EV runs front (0) -> back (BWidth), EW runs top (0) -> bottom (-BHeight).
  * The profile DXF (= eluCad Profiles.epd contour, identical coordinates) has x = BWidth - EV,
    y = EW + BHeight: eluCad's profile view puts the NC-X origin at the top-RIGHT corner with Y to the left
    (checked in eluCad 2026-10-14; the earlier x = EV gave mirrored programs). CRotation 2 / CMirror 1 cuts are
    drawn rotated 180° / mirrored, see face_point().
  * CAMplus stores W/H and the plane angle in the *positioned* frame: the DXF rotated CCW by the
    profile position angle about the DXF bounding-box centre (DPROFILE.INI / LDT header 0x184).
  * Plane angle theta = direction of the outward face normal in the (W, H) plane, degrees
    (0 = +W, 90 = +H/top). CAMplus' ribbon B = theta - 90.
  * W/H is the start reference point (ECW WHeight already applied); Z start/end are relative to it
    along the normal: Zs = +SAFE_START, Ze = -final depth (deepest WDepthTab tier).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import collide
import ecw
import toolsel

SAFE_START = 3.0      # CAMplus default Z start above the reference point
RELEASE = 10.0        # CAMplus default release height
RECT_R_MARGIN = 0.1   # corner radius kept this far below half the short side (see build_piece)


@dataclass
class Position:
    angle: float = 0.0     # CAMplus profile position (DPROFILE.INI), degrees CCW; 0 = flat (correct mitre for frames)
    mirror: int = 0
    off_w: float = 0.0
    off_h: float = 0.0
    flip_ops: bool = False  # mirror the machinings across the DXF's vertical centre line (symmetric profiles only)


@dataclass
class Op:
    fig: str               # HOLE | SLOT | RECTANGLE
    theta: float           # outward normal angle in positioned frame, [0, 360)
    w: float
    h: float
    x: float
    zs: float
    ze: float
    params: tuple          # HOLE (D,) ; SLOT (L, H) ; RECTANGLE (L, H, r)
    fig_angle: float       # in-plane rotation of the figure, degrees
    emptying: bool
    tool: str
    source: str            # human readable origin (for reports)

    @property
    def b(self) -> float:
        b = self.theta - 90.0
        while b > 180:
            b -= 360
        while b <= -180:
            b += 360
        return b

    def x_extent(self) -> tuple[float, float]:
        """X range occupied along the bar (for encumbrance.txt / clamp avoidance)."""
        if self.fig == "HOLE":
            r = self.params[0] / 2
            return self.x - r, self.x + r
        L, H = self.params[0], self.params[1]
        a = math.radians(self.fig_angle)
        half = abs(L / 2 * math.cos(a)) + abs(H / 2 * math.sin(a))
        return self.x - half, self.x + half


@dataclass
class Piece:
    cut_no: int
    name: str
    profile: str
    length: float
    angle_left: float
    angle_right: float
    ops: list[Op] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def final_depth(w: ecw.Work) -> float:
    tiers = [t.split() for t in w.s("WDepthTab").split(",") if t.strip()]
    vals = [float(t[0]) for t in tiers if t]
    d = max(vals) if vals else 0.0
    return d if d > 0 else w.f("WDepth")


def face_point(w: ecw.Work, bar: ecw.Bar, rotation: int = 0, mirror: int = 0) -> tuple[float, float, float] | None:
    """(x_dxf, y_dxf, theta_dxf) of the reference point and outward normal, or None if unsupported.

    Verified against eluCad's own profile view (2026-10-14): the NC-X origin sits at the profile's top-RIGHT
    corner with Y pointing LEFT, so DXF x = BWidth - EV, y = BHeight + EW. eluCad draws the profile transformed
    by the cut's clamping orientation (CRotation 2 = rotated 180°, CMirror 1 = mirrored left-right; both seen in
    the profile view), and the works are relative to that drawing, so the transform is undone here.
    """
    p = _machine_point(w, bar)
    if p is None:
        return None
    W, H = bar.width, bar.height
    ev, ew_h, th_a = p
    x, y, th = W - ev, ew_h, (180.0 - th_a) % 360            # eluCad view (origin top-right, Y to the left)
    rot = rotation % 4
    mir = bool(mirror) or rotation >= 4
    if rot == 2:
        x, y, th = W - x, H - y, (th + 180.0) % 360
    elif rot in (1, 3):
        return None   # 90/270° clamping not verified
    if mir:
        x, th = W - x, (180.0 - th) % 360
    return x, y, th


def _machine_point(w: ecw.Work, bar: ecw.Bar) -> tuple[float, float, float] | None:
    """(EV, EW + BHeight, normal angle) in the SBZ machine frame (EV front 0 -> back BWidth)."""
    W, H = bar.width, bar.height
    s, y, h = w.side, w.f("WY1"), w.f("WHeight")
    if s == 1:
        ev, ew, th = y, h, 90.0
    elif s == 2:
        ev, ew, th = -h, y, 180.0
    elif s == 3:
        ev, ew, th = h + W, -y, 0.0
    elif s == 6:
        ev, ew, th = -y, -h - H, 270.0
    elif s >= 7:
        plane = bar.planes.get(s - 7)
        if plane is None:
            return None
        if plane.angle_z:
            return None  # planes tilted about the vertical axis (saw/end planes) are not modelled
        # NC-X: zero point moved to (WPTransX along the bar, WPTransY across, WPTransZ vertical) in the top-face
        # frame, then rotated about the bar axis by WPAngleX (SBZ kinematics: A = -WPAngleX).
        a = -plane.angle_x
        ra = math.radians(a)
        ev = plane.trans[1] + y * math.cos(ra) - h * math.sin(ra)
        ew = plane.trans[2] + y * math.sin(ra) + h * math.cos(ra)
        th = 90.0 + a
    else:
        return None
    return ev, ew + H, th % 360


def _rotate(x: float, y: float, theta: float, bbox: tuple, pos: Position) -> tuple[float, float, float]:
    """DXF frame -> rotated frame (rotation about the bbox centre, then mirror, then offsets)."""
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    a = math.radians(pos.angle)
    ca, sa = round(math.cos(a), 12), round(math.sin(a), 12)
    dx, dy = x - cx, y - cy
    xw, yh = cx + dx * ca - dy * sa, cy + dx * sa + dy * ca
    th = (theta + pos.angle) % 360
    if pos.mirror:
        xw = 2 * cx - xw
        th = (180 - th) % 360
    return xw + pos.off_w, yh + pos.off_h, th


def keep_min(bbox: tuple, angle: float, mirror: int = 0) -> Position:
    """Position whose DPROFILE offsets keep the rotated profile's bbox min corner at the DXF bbox min, as CAMplus
    writes them itself: Daniel's RAMPROFI (DXF 45 x 52.7) at 270 has offsets 3.859/-3.859 = DXF min - rotated min,
    and the LDT header bbox is then (0, 0, W, H). Without them CAMplus draws a rotated profile shifted against the
    machinings (2026-10-23: 487850A at 270 had every machining 46 mm beside the profile)."""
    rb = positioned_bbox(bbox, Position(angle=angle, mirror=mirror))
    return Position(angle=angle, mirror=mirror, off_w=round(bbox[0] - rb[0], 6), off_h=round(bbox[1] - rb[1], 6))


def positioned_bbox(bbox: tuple, pos: Position) -> tuple[float, float, float, float]:
    """Rotated bbox as stored in the LDT header (0x158..0x170)."""
    pts = [_rotate(px, py, 0, bbox, pos)[:2] for px in (bbox[0], bbox[2]) for py in (bbox[1], bbox[3])]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def position(x: float, y: float, theta: float, bbox: tuple, pos: Position) -> tuple[float, float, float]:
    """DXF frame -> CAMplus W/H as entered and stored: rotated point relative to the rotated bbox's min corner
    (the profile sits on the table at H = 0 against the fence at W = 0). Verified: CAMplus rejects holes
    below H = 0 ("Complete cuts programming not allowed!")."""
    xw, yh, th = _rotate(x, y, theta, bbox, pos)
    bb = positioned_bbox(bbox, pos)
    return xw - bb[0], yh - bb[1], th


def build_piece(job: ecw.Job, bar: ecw.Bar, cut: ecw.Cut, bbox: tuple, pos: Position,
                segs: list, tools: dict, allowed=toolsel.DEFAULT_SET) -> Piece:
    flipped = cut.rotation % 4 == 2
    # end angles are given for the clamped orientation; a 180° flip about the bar axis swaps the long side
    al, ar = (180.0 - cut.angle_lh, 180.0 - cut.angle_rh) if flipped else (cut.angle_lh, cut.angle_rh)
    piece = Piece(cut.no, cut.description, bar.ident, cut.length, al, ar)
    if abs(cut.angle_lv - 90) > 1e-6 or abs(cut.angle_rv - 90) > 1e-6:
        piece.warnings.append(f"CNo {cut.no}: vertikal kapvinkel LV/RV {cut.angle_lv}/{cut.angle_rv} stöds inte (bara svängning)")
    if cut.rotation % 4 in (1, 3):
        piece.warnings.append(f"CNo {cut.no}: CRotation {cut.rotation} (90/270°) är inte verifierad - bearbetningar hoppas över")
    sect = collide.section(segs, bbox, pos)    # profile material for the tool collision check
    for w in ecw.flatten(job, cut):
        t = w.wtype
        label = w.s("WComment") or w.kv.get("_comment", "")
        if t == "S":
            continue  # saw cuts: the Quadra2 cuts the piece itself from length + end angles
        if t not in ("C", "D", "L", "R"):
            piece.warnings.append(f"CNo {cut.no}: WType {t} ({label}) stöds inte, hoppas över")
            continue
        fp = face_point(w, bar, cut.rotation, cut.mirror)
        if fp is None:
            piece.warnings.append(f"CNo {cut.no}: WSide {w.side} ({label}) stöds inte, hoppas över")
            continue
        if t in ("L", "R") and (cut.rotation or cut.mirror) and abs(w.f("WAngle")) % 90 > 1e-6:
            piece.warnings.append(f"CNo {cut.no}: figurvinkel {w.f('WAngle')} på vriden/speglad bit är inte verifierad ({label})")
        xd, yd, thd = fp
        if pos.flip_ops:
            # 2026-10-23: eluCad's clamp view of the frame 487850A (Kindrot cut 103) shows the 45° drainage V T1/T2 on
            # the chamfer opposite to where mapping B puts it (the sash's S1 drainage needs mapping B). The frame
            # section is symmetric within 0.02 mm, so mirroring the machinings gives eluCad's arrangement exactly.
            xd, thd = bbox[0] + bbox[2] - xd, (180.0 - thd) % 360
        wp, hp, th = position(xd, yd, thd, bbox, pos)
        depth = final_depth(w)
        mat = max(0.5, depth - toolsel.entry_distance(xd, yd, thd, segs, max(0.0, w.f("WHeight"))))
        env = max(0.5, depth - toolsel.envelope_entry(xd, yd, thd, bbox))
        x_abs = w.f("WX1") + (bar.planes[w.side - 7].trans[0] if w.side >= 7 and (w.side - 7) in bar.planes else 0.0)
        def crash(fig, params, angle):
            width = collide.across(fig, params, angle)
            return lambda tl: collide.tool_hits(tl, th, wp, hp, depth, width, sect)
        common = dict(theta=th, w=round(wp, 4), h=round(hp, 4), x=round(x_abs, 4), zs=SAFE_START,
                      ze=-round(depth, 4), source=f"WType {t} WSide {w.side} X{w.f('WX1'):g} {label}")
        if t in ("C", "D"):
            d = w.f("WW1")
            tool, warn = toolsel.choose(tools, allowed, "HOLE", d, None, mat, env, crash("HOLE", (d,), 0.0))
            op = Op("HOLE", params=(d,), fig_angle=0.0, emptying=False, tool=tool or "", **common)
        elif t == "L":
            L, Wd = w.f("WW1"), w.f("WW2")
            tool, warn = toolsel.choose(tools, allowed, "SLOT", Wd, None, mat, env, crash("SLOT", (L, Wd), w.f("WAngle")))
            op = Op("SLOT", params=(L, Wd), fig_angle=w.f("WAngle"), emptying=False, tool=tool or "", **common)
        else:
            L, Hh, r = w.f("WW1"), w.f("WW2"), w.f("WW3")
            if r >= min(L, Hh) / 2 - RECT_R_MARGIN / 2:
                # CAMplus' 3D kernel (TKG3d.dll) crashes on open when the short side equals 2r (verified 2026-10-14
                # with 460640F 8x20 r4; r 3.9 opens, simulates and compiles). The corners then differ by 0.1 mm
                # only (a smaller tool is chosen, since the tool radius must fit the corners).
                r_new = round(min(L, Hh) / 2 - RECT_R_MARGIN, 3)
                piece.warnings.append(f"CNo {cut.no}: RECTANGLE {L:g}x{Hh:g} radie {r:g} -> {r_new:g} "
                                      f"(CAMplus kraschar när kortsidan = 2 x radien; 0,1 mm skillnad i hörnen) ({label})")
                r = r_new
            tool, warn = toolsel.choose(tools, allowed, "RECTANGLE", min(L, Hh), r, mat, env, crash("RECTANGLE", (L, Hh), w.f("WAngle")))
            op = Op("RECTANGLE", params=(L, Hh, r), fig_angle=w.f("WAngle"), emptying=bool(int(w.f("WBroach"))),
                    tool=tool or "", **common)
        if warn:
            piece.warnings.append(f"CNo {cut.no}: {op.fig} {op.params} ({label}): {warn} - HOPPAS ÖVER")
            continue
        piece.ops.append(op)
    return piece
