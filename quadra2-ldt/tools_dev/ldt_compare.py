"""Compare two LDT files (e.g. generated vs. CAMplus re-saved): header fields, record count, and every byte range
that differs inside records (reported as doubles where possible), ignoring known volatile bytes.
Usage: ldt_compare.py <a.ldt> <b.ldt>"""
import re, struct, sys, zipfile
sys.stdout.reconfigure(encoding="utf-8")

FIG = re.compile(rb"(KEY HOLE|RECTANGLE|SLOTP|SLOT|HOLE)\x00")
VOLATILE_REC = [(-20, -16), (1152, 1156), (1204, 1208)]   # record id, reference object ids (relative to figure name)


def inner(p):
    raw = open(p, "rb").read()
    if raw[:2] != b"PK":
        return raw, {}
    z = zipfile.ZipFile(p)
    name = [n for n in z.namelist() if n.lower().endswith(".ldt")][0]
    return z.read(name), {n: z.read(n) for n in z.namelist() if n != name and not n.lower().endswith(".dxf")}


def recs(b):
    return [(m.start(), m.group(1).decode()) for m in FIG.finditer(b)]


a, za = inner(sys.argv[1]); b, zb = inner(sys.argv[2])
print(f"size {len(a)} vs {len(b)}; nObj {struct.unpack_from('<I', a, 0x5A)[0]} vs {struct.unpack_from('<I', b, 0x5A)[0]}")
H = {"len": (0x14C, "d"), "bbminW": (0x158, "d"), "bbminH": (0x160, "d"), "bbmaxW": (0x168, "d"), "bbmaxH": (0x170, "d"),
     "pos": (0x184, "d"), "offW": (0x18C, "d"), "offH": (0x194, "d"), "mirror": (0x19C, "h"), "angles": (0x19E, "4h")}
for k, (o, f) in H.items():
    va, vb = struct.unpack_from("<" + f, a, o), struct.unpack_from("<" + f, b, o)
    print(f"  header {k:<7} {va} {'==' if va == vb else '!='} {vb}")
ra, rb = recs(a), recs(b)
print(f"records {len(ra)} vs {len(rb)}")
for i, ((fa, na), (fb, nb)) in enumerate(zip(ra, rb)):
    A, B = a[fa - 20:fa - 20 + 3858], b[fb - 20:fb - 20 + 3858]
    diffs = []
    j = 0
    while j < 3858:
        if A[j] != B[j]:
            k = j
            while k < 3858 and A[k] != B[k]:
                k += 1
            rel = j - 20
            if not any(lo <= rel < hi for lo, hi in VOLATILE_REC):
                o = rel - ((rel - 0) % 2)
                vals = []
                for oo in range(rel - 7, rel + 1):
                    if 0 <= oo + 20 <= 3850:
                        x, y = struct.unpack_from("<d", A, oo + 20)[0], struct.unpack_from("<d", B, oo + 20)[0]
                        if abs(x) < 1e7 and abs(y) < 1e7 and (abs(x) > 1e-12 or abs(y) > 1e-12):
                            vals.append(f"d+{oo}:{x:.6g}->{y:.6g}")
                diffs.append(f"+{rel}..+{k - 20} {' '.join(vals[:2])}")
            j = k
        else:
            j += 1
    print(f"  rec {i} {na}/{nb}: {'identical' if not diffs else str(len(diffs)) + ' diffs'}")
    for d in diffs[:12]:
        print("     ", d)
for n in sorted(set(za) | set(zb)):
    same = za.get(n) == zb.get(n)
    print(f"  zip {n}: {'same' if same else 'DIFFERS'}")
    if not same and n.lower().endswith((".txt", ".ini")):
        print("    gen:", (za.get(n) or b"").decode("cp1252", "replace").replace("\r\n", " | ")[:300])
        print("    cam:", (zb.get(n) or b"").decode("cp1252", "replace").replace("\r\n", " | ")[:300])
