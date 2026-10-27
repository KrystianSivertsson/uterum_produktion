"""Read eluCad/NC-X ECW work files and flatten them into per-piece operation lists.

Only what the Quadra2 LDT generator needs: bars (profile, size), planes, cuts (length, end angles)
and works. Macro calls (:WORK WType "X" with WGroup n) are expanded from the file's own
:WGROUP n blocks; absolute X = call WX1 + sub WX1 (same rule as ase60-generator's writer).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class Plane:
    no: int
    name: str
    angle_x: float
    angle_z: float
    trans: tuple[float, float, float]


@dataclass
class Work:
    kv: dict

    def f(self, key: str, default: float = 0.0) -> float:
        v = self.kv.get(key)
        if v is None or v == "":
            return default
        try:
            return float(str(v).split()[0].replace(",", "."))
        except ValueError:
            return default

    def s(self, key: str, default: str = "") -> str:
        v = self.kv.get(key)
        return default if v is None else str(v).strip().strip('"')

    @property
    def wtype(self) -> str:
        return self.s("WType")

    @property
    def side(self) -> int:
        return int(self.f("WSide"))


@dataclass
class Cut:
    no: int
    description: str
    comno: str
    length: float
    angle_lh: float
    angle_rh: float
    angle_lv: float
    angle_rv: float
    rotation: int
    mirror: int
    works: list[Work] = field(default_factory=list)


@dataclass
class Bar:
    ident: str
    width: float
    height: float
    planes: dict[int, Plane] = field(default_factory=dict)
    cuts: list[Cut] = field(default_factory=list)


@dataclass
class Job:
    order: str
    wgroups: dict[int, list[Work]]
    bars: list[Bar]


_KV = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def parse(text: str) -> Job:
    wgroups: dict[int, list[Work]] = {}
    bars: list[Bar] = []
    order = ""
    block = None          # current block name
    kv: dict = {}
    cur_wg: int | None = None
    bar: Bar | None = None
    cut: Cut | None = None

    def flush():
        nonlocal kv, block, bar, cut
        if block is None:
            return
        if block == "WORK":
            w = Work(kv)
            if cur_wg is not None and cut is None:
                wgroups.setdefault(cur_wg, []).append(w)
            elif cut is not None:
                cut.works.append(w)
        elif block == "BAR":
            bar = Bar(kv.get("BIdentNo", "").strip('"'), float(kv.get("BWidth", 0)), float(kv.get("BHeight", 0)))
            bars.append(bar)
        elif block == "PLANE" and bar is not None:
            no = int(float(kv.get("WPNo", 0)))
            def num(k):
                try:
                    return float(kv.get(k, 0))
                except ValueError:
                    return 0.0
            bar.planes[no] = Plane(no, kv.get("WPName", "").strip('"'), num("WPAngleX"), num("WPAngleZ"),
                                   (num("WPTransX"), num("WPTransY"), num("WPTransZ")))
        elif block == "CUT" and bar is not None:
            def g(k, d=0.0):
                try:
                    return float(kv.get(k, d))
                except ValueError:
                    return d
            cut = Cut(int(g("CNo")), kv.get("CDescription", "").strip('"'), kv.get("CComNo", "").strip('"'),
                      g("CLength"), g("CAngleLH", 90), g("CAngleRH", 90), g("CAngleLV", 90), g("CAngleRV", 90),
                      int(g("CRotation")), int(g("CMirror")))
            bar.cuts.append(cut)
        kv = {}

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith(":"):
            name = line[1:].split()[0]
            flush()
            if name == "WGROUP":
                cur_wg = int(line.split()[1])
                block = None
                continue
            if name == "JOB":
                cur_wg = None
            if name == "BAR":
                cut = None
            if name in ("CUT",):
                pass
            block = name
            continue
        m = _KV.match(line)
        if m:
            k, v = m.group(1), m.group(2)
            if block == "JOB" and k == "order":
                order = v.strip('"')
            if block == "CUT" and k in kv and k != "CNo":
                pass
            kv[k] = v.strip('"') if not v.startswith('"') else v.strip('"')
    flush()
    # a :CUT's own block was flushed when its first :CLAMPS/:WORK started; works attach afterwards
    return Job(order, wgroups, bars)


def flatten(job: Job, cut: Cut) -> list[Work]:
    """Expand macro calls into absolute works (WX1 = call.WX1 + sub.WX1)."""
    out: list[Work] = []
    for w in cut.works:
        if w.wtype == "X":
            grp = int(w.f("WGroup", -1))
            for sub in job.wgroups.get(grp, []):
                kv = dict(sub.kv)
                kv["WX1"] = str(w.f("WX1") + sub.f("WX1"))
                kv["_macro"] = w.s("WMacro")
                kv["_comment"] = w.s("WComment")
                out.append(Work(kv))
        else:
            out.append(w)
    return out


def read(path: str) -> Job:
    with open(path, "r", encoding="cp1252", errors="replace") as f:
        return parse(f.read())
