"""Write CAMplus 4.0/2 (.ldt, inner format version 0x68) files.

Layout (reverse-engineered from CAMplus-saved files, see README.md):
  zip: QUADRA2.MACHINE, <SERIE>.SERIE, <name>.ldt (binary below), <code>.dxf, tools.txt, dprofile.ini,
       encumbrance.txt, LDT.ini
  binary: 512-byte header | nObj x 34-byte reference objects | n x 3858-byte machining records
Records are built from CAMplus-saved template records (templates/*.bin) and patched field by field.
"""
from __future__ import annotations

import io
import math
import os
import struct
import zipfile

from quadra import Op, Piece, Position, positioned_bbox

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "templates")

REC_SIZE = 3858
OBJ_SIZE = 34
HDR_SIZE = 512
FIG_OFF = 20                      # figure name offset inside a record
FIG_TYPE = {"HOLE": 1, "RECTANGLE": 2, "SLOT": 3, "KEY HOLE": 4}

# record field offsets relative to the figure name (FIG_OFF)
R_THETA, R_X = 80, 94
R_COS1, R_NSIN, R_SIN, R_COS2 = 340, 348, 554, 562
R_ZS, R_ZE, R_REL = 522, 678, 730
R_P1, R_P2, R_P3 = 854, 862, 870
R_WREF, R_W, R_HREF, R_H = 1152, 1156, 1204, 1208
R_TOOLCNT, R_TOOLNAME, R_TOOLLEN, R_TOOLDIA = 2028, 2030, 2110, 2118
TOOLNAME_LEN = 20
R_FIGANGLE = 844                  # ALPHALAV, in-plane rotation of the figure (double)
R_EMPTY = 738                     # path: 0 = profiling, 1 = emptying (byte)

# Tool data from C:\Quadra2\CAM\TOOLS.TXT: name -> (diameter, total length)
def read_tools(path=r"C:\Quadra2\CAM\TOOLS.TXT") -> dict:
    tools, lines = {}, [l.strip() for l in open(path, encoding="cp1252", errors="replace")]
    i = 0
    while i < len(lines):
        if lines[i].startswith("*"):
            name = lines[i][1:].split()[0]
            dia = float(lines[i + 2].split()[0]); total = float(lines[i + 3].split()[4])
            tools[name] = (dia, total)
            i += 4
        else:
            i += 1
    return tools


def _load(name):
    with open(os.path.join(TPL, name), "rb") as f:
        return f.read()


def _put_d(b: bytearray, off: int, v: float):
    struct.pack_into("<d", b, off, float(v))


def _put_str(b: bytearray, off: int, s: str, n: int):
    raw = s.encode("cp1252", "replace")[: n - 1]
    b[off:off + n] = raw + b"\x00" * (n - len(raw))


def dxf_bbox(path: str) -> tuple[float, float, float, float]:
    xs, ys = [], []
    lines = [l.strip() for l in open(path, encoding="cp1252", errors="replace")]
    in_ent = False
    for i in range(0, len(lines) - 1, 2):
        c, v = lines[i], lines[i + 1]
        if c == "2" and v == "ENTITIES":
            in_ent = True
        if c == "0" and v == "ENDSEC":
            in_ent = False
        if in_ent and c in ("10", "11"):
            xs.append(float(v))
        if in_ent and c in ("20", "21"):
            ys.append(float(v))
    return min(xs), min(ys), max(xs), max(ys)


def build_record(op: Op, rec_id: int, wref: int, href: int, tools: dict) -> bytes:
    rec = bytearray(_load(f"rec_{op.fig.replace(' ', '_')}.bin"))
    assert len(rec) == REC_SIZE, op.fig
    struct.pack_into("<IHH", rec, 0, rec_id, FIG_TYPE[op.fig], 1)
    f = FIG_OFF
    th = op.theta % 360
    t = math.radians(th)
    c, s = math.cos(t), math.sin(t)
    c, s = (0.0 if abs(c) < 1e-15 else c), (0.0 if abs(s) < 1e-15 else s)   # CAMplus writes +0.0, never -0.0
    ns = -s if s != 0.0 else 0.0
    _put_d(rec, f + R_THETA, th)
    _put_d(rec, f + R_X, op.x)
    _put_d(rec, f + R_COS1, c); _put_d(rec, f + R_NSIN, ns); _put_d(rec, f + R_SIN, s); _put_d(rec, f + R_COS2, c)
    _put_d(rec, f + R_ZS, op.zs); _put_d(rec, f + R_ZE, op.ze)
    p = list(op.params) + [0.0] * (3 - len(op.params))
    _put_d(rec, f + R_P1, p[0]); _put_d(rec, f + R_P2, p[1]); _put_d(rec, f + R_P3, p[2])
    _put_d(rec, f + R_FIGANGLE, op.fig_angle)
    rec[f + R_EMPTY] = 1 if op.emptying else 0
    struct.pack_into("<I", rec, f + R_WREF, wref); _put_d(rec, f + R_W, op.w)
    struct.pack_into("<I", rec, f + R_HREF, href); _put_d(rec, f + R_H, op.h)
    dia, total = tools[op.tool]
    struct.pack_into("<H", rec, f + R_TOOLCNT, 1)
    _put_str(rec, f + R_TOOLNAME, op.tool, TOOLNAME_LEN)
    _put_d(rec, f + R_TOOLLEN, total); _put_d(rec, f + R_TOOLDIA, dia)
    return bytes(rec)


def build_inner(piece: Piece, series: str, desc: str, bbox_dxf: tuple, pos: Position, tools: dict) -> bytes:
    hdr = bytearray(_load("header.bin"))
    assert len(hdr) == HDR_SIZE
    _put_str(hdr, 0x0A, desc, 40)
    _put_str(hdr, 0x32, series, 20)
    _put_str(hdr, 0x46, piece.profile, 20)
    struct.pack_into("<I", hdr, 0x5A, 2)                 # reference objects
    struct.pack_into("<H", hdr, 0x5E, len(piece.ops))    # machining count (CAMplus reads only this many)
    _put_d(hdr, 0x14C, piece.length)
    bb = positioned_bbox(bbox_dxf, pos)
    bb = (0.0, 0.0, bb[2] - bb[0], bb[3] - bb[1])         # CAMplus stores it from (0, 0), see quadra.keep_min
    for off, v in zip((0x158, 0x160, 0x168, 0x170), bb):
        _put_d(hdr, off, 0.0 if abs(v) < 1e-4 else round(v, 6))
    _put_d(hdr, 0x184, pos.angle); _put_d(hdr, 0x18C, pos.off_w); _put_d(hdr, 0x194, pos.off_h)
    struct.pack_into("<h", hdr, 0x19C, pos.mirror)
    # End angles: CAMplus "1 - Angle generated on the vertical face" (Sx, Dx, operator side view) and
    # "2 - Angle generated on the horizontal face" (Sx2, Dx2, top view), in the positioned frame. The ECW mitre runs
    # across the profile's DXF y (BHeight), which is vertical when the profile lies (position 0/180) and horizontal
    # when it stands (90/270). Krystian 2026-10-23: the Quadra2 saw makes 45° one way only, so the profiles stand
    # as in eluCad's clamp view (position 270) and the mitre goes in the horizontal-face pair.
    lr = (round(piece.angle_left * 100), round(piece.angle_right * 100))
    standing = round(pos.angle) % 180 == 90
    struct.pack_into("<4h", hdr, 0x19E, *((9000, 9000) + lr if standing else lr + (9000, 9000)))
    hdr[0x1A8:0x200] = b"\x00" * (0x200 - 0x1A8)  # UTF-16 path of the last save, not needed
    obj = _load("object.bin")
    wref, href = 0x10, 0x11
    objs = b"".join(struct.pack("<I", oid) + obj[4:] for oid in (wref, href))
    recs = b"".join(build_record(op, 0x20 + i, wref, href, tools) for i, op in enumerate(piece.ops))
    return bytes(hdr) + objs + recs


MERGE_GAP = 20.0   # mm: CAMplus merges nearby zones (observed: 16 mm gaps merged); never leave a clamp-sized sliver


def encumbrance(piece: Piece) -> str:
    ranges = sorted(op.x_extent() for op in piece.ops)
    merged = []
    for lo, hi in ranges:
        if merged and lo <= merged[-1][1] + MERGE_GAP:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    out = ["[ENCUMBRANCES]", f"NUM={len(merged)}"]
    for i, (lo, hi) in enumerate(merged, 1):
        out += [f"[ENC_{i}]", "TYPE=0", "REF_NAME=", "REFERENCE=1", f"XMIN={lo:.6f}", f"XMAX={hi:.6f}"]
    return "\r\n".join(out) + "\r\n"


def ldt_ini(piece: Piece, series: str) -> str:
    counts = {}
    for op in piece.ops:
        counts[op.tool] = counts.get(op.tool, 0) + 1
    out = ["[ATTACHMENTS]", "NUMBER=0", "[CONFIGURATION]", "NAME=Quadra2", "[TOOLS]"]
    out += [f"{k}={v}" for k, v in counts.items()]
    out += ["[DXF]", "USE=NATIVE_CODE", f"SERIE={series}", f"CODE={piece.profile}"]
    return "\r\n".join(out) + "\r\n"


def dprofile_ini(series: str, code: str, pos: Position, base=r"C:\Quadra2\CAM\DPROFILE.INI") -> str:
    """The machine's DPROFILE.INI with this profile's position set (other entries kept)."""
    sections, cur = {}, None
    if os.path.exists(base):
        for line in open(base, encoding="cp1252", errors="replace"):
            line = line.strip()
            if line.startswith("["):
                cur = line[1:-1]; sections.setdefault(cur, {})
            elif "=" in line and cur:
                k, v = line.split("=", 1); sections[cur][k] = v
    sections.setdefault(series, {})[code] = f"{pos.angle:g} {pos.mirror} {pos.off_w:g} {pos.off_h:g}"
    out = []
    for sec, kv in sections.items():
        out.append(f"[{sec}]")
        out += [f"{k}={v}" for k, v in kv.items()]
    return "\r\n".join(out) + "\r\n"


def write_ldt(path: str, piece: Piece, series: str, dxf_path: str, pos: Position, desc: str,
              tools_txt=r"C:\Quadra2\CAM\TOOLS.TXT") -> None:
    tools = read_tools(tools_txt)
    bbox = dxf_bbox(dxf_path)
    inner = build_inner(piece, series, desc, bbox, pos, tools)
    name = os.path.splitext(os.path.basename(path))[0]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("QUADRA2.MACHINE", "Quadra2")
        z.writestr(f"{series}.SERIE", series)
        z.writestr(f"{name}.ldt", inner)
        z.write(dxf_path, f"{piece.profile}.dxf")
        z.write(tools_txt, "tools.txt")
        z.writestr("dprofile.ini", dprofile_ini(series, piece.profile, pos))
        z.writestr("encumbrance.txt", encumbrance(piece))
        z.writestr("LDT.ini", ldt_ini(piece, series))
