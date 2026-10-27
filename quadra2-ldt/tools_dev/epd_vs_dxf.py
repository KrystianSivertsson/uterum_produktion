"""Compare each profile's contour in eluCad's Profiles.epd with the DXF in C:\\Quadra2\\CAM\\DXF\\SCHUECO:
identical, mirrored in x, mirrored in y, or rotated 180. Usage: epd_vs_dxf.py <code> [...]"""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")
import toolsel

EPD = r"C:\elusoft\eluCad 4.0\user\database\Profiles.epd"
text = open(EPD, encoding="cp1252", errors="replace").read()


def epd_points(code):
    m = re.search(r':PROFILE\s+MName\s*=\s*"%s".*?:DATA(.*?)(?=:PROFILE|\Z)' % re.escape(code), text, re.S)
    if not m:
        return None, None
    dim = re.search(r':PROFILE\s+MName\s*=\s*"%s".*?Dimension\s*=\s*([\d.]+)\s+([\d.]+)' % re.escape(code), text, re.S)
    num = r"-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?"
    pts = [(float(a), float(b)) for a, b in re.findall(r"^\s*(%s)\s+(%s)\s+0\s*$" % (num, num), m.group(1), re.M)]
    return pts, (float(dim.group(1)), float(dim.group(2))) if dim else None


for code in sys.argv[1:]:
    pts, dim = epd_points(code)
    dxf = os.path.join(r"C:\Quadra2\CAM\DXF\SCHUECO", code + ".DXF")
    if not pts or not os.path.exists(dxf):
        print(code, "saknas i EPD" if not pts else "", "saknas DXF" if not os.path.exists(dxf) else "")
        continue
    segs = toolsel.dxf_segments(dxf)
    dpts = {(round(a[0], 1), round(a[1], 1)) for s in segs for a in s}
    W, H = dim
    res = {}
    for name, f in (("identisk", lambda x, y: (x, y)), ("spegel x", lambda x, y: (W - x, y)),
                    ("spegel y", lambda x, y: (x, H - y)), ("vriden 180", lambda x, y: (W - x, H - y))):
        hits = sum(1 for x, y in pts if (round(f(x, y)[0], 1), round(f(x, y)[1], 1)) in dpts)
        res[name] = hits
    best = max(res, key=res.get)
    print(f"{code}: EPD {len(pts)} punkter, dim {dim}; matchningar {res} -> {best}")
