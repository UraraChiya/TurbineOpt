#!/usr/bin/env python3
"""Parse the NuclearCraft: Overhauled turbine coil definitions from the
modpack CraftTweaker .zs scripts and emit js/coils.js.

Base NuclearCraft coils + connector are hard-coded from the jar defaults
(NCConfig).  The NTP addon coils are parsed from scripts/NTP/*.zs so they
stay in sync with the pack.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts", "NTP")
OUT = os.path.join(ROOT, "js", "coils.js")

# id, display name, conductivity, placement rule
coils = []


def add(cid, name, cond, rule):
    coils.append({"id": cid, "name": name, "cond": float(cond), "rule": rule})


# --- Localisation ----------------------------------------------------------
def load_lang(fname):
    path = os.path.join(ROOT, "lang", fname)
    names = {}
    if not os.path.exists(path):
        return names
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line.startswith("tile.nuclearcraft.turbine_dynamo_coil_") and line.endswith(".name=") is False and ".name=" in line:
            key, _, val = line.partition("=")
            cid = key[len("tile.nuclearcraft.turbine_dynamo_coil_"):-len(".name")]
            names[cid] = val.strip()
    return names


LANG_EN = load_lang("en_us.lang")
LANG_ZH = load_lang("zh_cn.lang")

# --- Base NuclearCraft: Overhauled coils (NCConfig defaults) ---------------
BASE_NAMES = {
    "magnesium": ("Magnesium", "\u9541"),
    "beryllium": ("Beryllium", "\u94cd"),
    "aluminum": ("Aluminum", "\u94dd"),
    "gold": ("Gold", "\u91d1"),
    "copper": ("Copper", "\u94dc"),
    "silver": ("Silver", "\u94f6"),
}
add("magnesium", "Magnesium", 0.88, "one bearing || one connector")
add("beryllium", "Beryllium", 0.90, "one magnesium coil")
add("aluminum", "Aluminum", 1.00, "two magnesium coils")
add("gold", "Gold", 1.04, "one aluminum coil")
add("copper", "Copper", 1.06, "one beryllium coil")
add("silver", "Silver", 1.12, "one gold coil && one copper coil")
CONNECTOR_RULE = "one of any coil"

ZEN = ("Magnet", "Stabilizer", "Converter", "Extractor")
types = {
    "Magnet": ("MagnetInfo", "magnet"),
    "Stabilizer": ("StabilizerInfo", "stabilizer"),
    "Converter": ("ConverterInfo", "converter"),
    "Extractor": ("ExtractorInfo", "extractor"),
}


def parse_list(kind):
    """Return [(name, cond, rule)] for the plain *Info entries of a list file."""
    fname = {
        "Magnet": "coilmagnetlist.zs",
        "Stabilizer": "coilstabilizerlist.zs",
        "Converter": "coilconverterlist.zs",
        "Extractor": "coilextractorlist.zs",
    }[kind]
    path = os.path.join(SCRIPTS, fname)
    text = open(path, encoding="utf-8").read()
    out = []
    # optional liquid argument for LiquidStabilizerInfo
    for m in re.finditer(
        kind + r"Info\('([^']+)',\s*(?:<liquid:[^>]+>,\s*)?([0-9]*\.?[0-9]+)\s*,\s*'([^']*)'\)",
        text,
    ):
        out.append((m.group(1), float(m.group(2)), m.group(3)))
    return out


def parse_registration(kind):
    """Return [(id, cond, rule)] for explicit registerTurbineCoil calls."""
    fname = {
        "Magnet": "magnetregistration.zs",
        "Stabilizer": "stabilizeregistration.zs",
        "Converter": "converterregistration.zs",
        "Extractor": "extractorregistration.zs",
    }[kind]
    path = os.path.join(SCRIPTS, fname)
    text = open(path, encoding="utf-8").read()
    out = []
    for m in re.finditer(r"registerTurbineCoil\('([^']+)',\s*([0-9]*\.?[0-9]+)\s*,\s*'([^']*)'\)", text):
        out.append((m.group(1), float(m.group(2)), m.group(3)))
    return out


for kind in ZEN:
    suffix = types[kind][1]
    for name, cond, rule in parse_list(kind):
        add(name.lower() + suffix, name, cond, rule)
    # LiquidStabilizerInfo entries are also registered with the stabilizer suffix
    if kind == "Stabilizer":
        text = open(os.path.join(SCRIPTS, "coilstabilizerlist.zs"), encoding="utf-8").read()
        for m in re.finditer(
            r"LiquidStabilizerInfo\('([^']+)',\s*<liquid:[^>]+>,\s*([0-9]*\.?[0-9]+)\s*,\s*'([^']*)'\)",
            text,
        ):
            add(m.group(1).lower() + suffix, m.group(1), float(m.group(2)), m.group(3))
    for cid, cond, rule in parse_registration(kind):
        add(cid, cid, cond, rule)

# de-duplicate ids (later explicit registrations should not clash)
seen = {}
for c in coils:
    seen[c["id"]] = c
coils = list(seen.values())

# attach localised display names from the provided lang files
for c in coils:
    cid = c["id"]
    if cid in BASE_NAMES:
        c["nameEn"], c["nameZh"] = BASE_NAMES[cid]
    else:
        c["nameEn"] = LANG_EN.get(cid, c["name"])
        c["nameZh"] = LANG_ZH.get(cid, c["nameEn"])
    c["name"] = c["nameZh"] or c["nameEn"]

# validate that every rule dependency resolves to a known coil / known object
ids = {c["id"] for c in coils}
missing = set()

def check_rule(rule):
    for part in re.split(r"&&|\|\|", rule):
        part = part.strip().lower()
        if "coil" not in part:
            continue
        # token before 'coil' is the type (or 'any')
        tok = part.replace("at least", " ").replace("exactly", " ").replace("at most", " ")
        toks = tok.split()
        if "coil" not in toks:
            continue
        i = toks.index("coil")
        t = toks[i - 1] if i > 0 else "any"
        if t != "any" and t not in ids:
            missing.add(t)

for c in coils:
    check_rule(c["rule"])
if missing:
    print("WARNING: unresolved coil references:", sorted(missing))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write("// AUTO-GENERATED by tools/parse_coils.py -- do not edit by hand.\n")
    f.write("// Base NC:O coils are hard-coded; NTP addon coils parsed from scripts/NTP/*.zs\n")
    f.write("const COIL_DEFS = ")
    json.dump(coils, f, ensure_ascii=False, indent=2)
    f.write(";\n")
    f.write("const CONNECTOR_DEF = { id: 'connector', name: '\u8fde\u63a5\u5668', nameEn: 'Connector', nameZh: '\u8fde\u63a5\u5668', cond: 0, rule: %s };\n" % json.dumps(CONNECTOR_RULE))
    f.write("if (typeof module !== 'undefined') module.exports = { COIL_DEFS, CONNECTOR_DEF };\n")
    f.write("if (typeof window !== 'undefined') { window.COIL_DEFS = COIL_DEFS; window.CONNECTOR_DEF = CONNECTOR_DEF; }\n")

print("wrote", OUT, "with", len(coils), "coils")
for c in coils[:6]:
    print("  base:", c)
print("  total ids:", len(ids))
