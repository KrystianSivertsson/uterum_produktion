"""Extract per-figure template records from a CAMplus-saved LDT and locate the figure-angle / emptying fields.
Usage: tpl_extract.py <TPL.ldt> <templates_dir>
Expects the TPL7 layout: 0 HOLE, 1 HOLE, 2 SLOT(ang0), 3 SLOT(ang0), 4 RECT(ang90, emptying), 5 RECT(ang0), 6 SLOT(ang90)
"""
import re, struct, sys, zipfile, os
sys.stdout.reconfigure(encoding="utf-8")

src, out = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(src)
b = z.read([n for n in z.namelist() if n.lower().endswith(".ldt")][0])
FIG = re.compile(rb"(KEY HOLE|RECTANGLE|SLOTP|SLOT|HOLE)\x00")
figs = [m.start() for m in FIG.finditer(b)]
recs = [b[f - 20:f - 20 + 3858] for f in figs]
print("records:", len(recs), [b[f:f + 10].split(b"\x00")[0].decode() for f in figs])
nobj = struct.unpack_from("<I", b, 0x5A)[0]
print("nObj", nobj, "first record at", hex(figs[0] - 20), "expected", hex(512 + 34 * nobj))


def diff(a, c, label, skip=()):
    print(f"--- {label}")
    i = 0
    while i < len(a):
        if a[i] != c[i]:
            j = i
            while j < len(a) and a[j] != c[j]:
                j += 1
            rel = i - 20
            if not any(lo <= rel < hi for lo, hi in skip):
                vals = []
                for o in range(max(0, i - 7), min(j, len(a) - 8)):
                    va, vc = struct.unpack_from("<d", a, o)[0], struct.unpack_from("<d", c, o)[0]
                    if (abs(va) < 1e6 and abs(vc) < 1e6 and (va != vc) and (abs(va) > 1e-9 or abs(vc) > 1e-9)
                            and abs(va * 100 - round(va * 100)) < 1e-6 and abs(vc * 100 - round(vc * 100)) < 1e-6):
                        vals.append(f"d@+{o - 20}:{va:g}->{vc:g}")
                print(f"  +{rel}..+{j - 20}: {a[i:j].hex(' ')} -> {c[i:j].hex(' ')}  {' '.join(vals[:3])}")
            i = j
        else:
            i += 1


known = [(94, 102), (1152, 1160), (1204, 1212), (-20, -16)]   # X, refs, id
diff(recs[3], recs[6], "SLOT ang0 vs SLOT ang90 (X differs too)", known)
diff(recs[5], recs[4], "RECT ang0 profiling vs RECT ang90 emptying (X differs too)", known)
os.makedirs(out, exist_ok=True)
for name, idx in (("HOLE", 0), ("SLOT", 3), ("RECTANGLE", 5)):
    with open(os.path.join(out, f"rec_{name}.bin"), "wb") as f:
        f.write(recs[idx])
    print("wrote", name, "from record", idx)
with open(os.path.join(out, "header.bin"), "wb") as f:
    f.write(b[:512])
with open(os.path.join(out, "object.bin"), "wb") as f:
    f.write(b[512:512 + 34])
print("wrote header.bin, object.bin")
