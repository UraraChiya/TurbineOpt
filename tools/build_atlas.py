#!/usr/bin/env python3
"""Build a merged texture atlas for the turbine coil optimiser.

Base NuclearCraft: Overhauled coil textures live inside the mod jar; the NTP
addon coil textures live in ``resources/textures/blocks/``.  The exact texture
for each coil block is taken from its blockstate JSON.  All coil textures plus
the other turbine part textures are tiled into one 16x16-cell PNG and the
matching JS index is emitted to ``js/atlas.js``.

No third-party imaging library (Pillow/ImageMagick) is required: a compact PNG
decoder/encoder built on ``zlib`` is included below.
"""
import json
import os
import re
import struct
import zipfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COILS_JS = os.path.join(ROOT, "js", "coils.js")
OUT_PNG = os.path.join(ROOT, "assets", "coil-atlas.png")
OUT_JS = os.path.join(ROOT, "js", "atlas.js")
RES = os.path.join(ROOT, "resources")
BLOCKS = os.path.join(RES, "textures", "blocks")
BLOCKSTATES = os.path.join(RES, "blockstates")
TILE = 16
COLS = 16

# Base NC:O coil ids: textures come from the jar's dynamo_coil folder.
BASE_IDS = {"magnesium", "beryllium", "aluminum", "gold", "copper", "silver"}

# Other parts rendered by the UI (key -> path relative to textures/blocks).
PARTS = [
    ("__connector", "turbine/coil_connector.png"),
    ("__casing", "turbine/casing/wall.png"),
    ("__glass", "turbine/glass.png"),
    ("__bearing", "turbine/rotor_bearing.png"),
    ("__reserved", "turbine/controller_front_off.png"),
]


# --- PNG decoder -----------------------------------------------------------
def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def decode_png(data):
    """Decode a non-interlaced PNG to (width, height, rows) with rows of RGBA."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos = 8
    idat = []
    palette = None
    trns = None
    width = height = bitdepth = colortype = None
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            width, height, bitdepth, colortype, _comp, _filt, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            assert interlace == 0, "interlaced PNG unsupported"
        elif typ == b"PLTE":
            palette = [tuple(chunk[i:i + 3]) for i in range(0, len(chunk), 3)]
        elif typ == b"tRNS":
            trns = chunk
        elif typ == b"IDAT":
            idat.append(chunk)
        elif typ == b"IEND":
            break
    raw = zlib.decompress(b"".join(idat))
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colortype]
    bpp = max(1, (channels * bitdepth) // 8)
    stride = (width * channels * bitdepth + 7) // 8

    # Un-filter scanlines in place.
    lines = []
    prev = bytearray(stride)
    p = 0
    for _y in range(height):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                c = prev[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(a, prev[i], c)) & 0xFF
        lines.append(line)
        prev = line

    maxv = (1 << bitdepth) - 1

    def samples(line):
        if bitdepth == 8:
            return list(line[:width * channels])
        if bitdepth == 16:
            return [line[i] << 8 | line[i + 1] for i in range(0, width * channels * 2, 2)]
        per = 8 // bitdepth
        mask = maxv
        vals = []
        for i in range(width * channels):
            shift = 8 - bitdepth * (i % per + 1)
            vals.append((line[i // per] >> shift) & mask)
        return vals

    rows = []
    for y in range(height):
        vals = samples(lines[y])
        row = []
        for x in range(width):
            base = x * channels
            if colortype == 0:  # grayscale
                g = vals[base]
                if bitdepth < 8:
                    g = g * 255 // maxv
                row.append((g, g, g, 255))
            elif colortype == 2:  # RGB
                if bitdepth == 16:
                    r, g, b = (v >> 8 for v in vals[base:base + 3])
                else:
                    r, g, b = vals[base:base + 3]
                row.append((r, g, b, 255))
            elif colortype == 3:  # palette
                idx = vals[base]
                r, g, b = palette[idx]
                a = 255
                if trns is not None and idx < len(trns):
                    a = trns[idx]
                row.append((r, g, b, a))
            elif colortype == 4:  # grayscale + alpha
                if bitdepth == 16:
                    g, a = vals[base] >> 8, vals[base + 1] >> 8
                else:
                    g, a = vals[base], vals[base + 1]
                row.append((g, g, g, a))
            else:  # RGBA (6)
                if bitdepth == 16:
                    r, g, b, a = (v >> 8 for v in vals[base:base + 4])
                else:
                    r, g, b, a = vals[base:base + 4]
                row.append((r, g, b, a))
        rows.append(row)
    return width, height, rows


# --- PNG encoder -----------------------------------------------------------
def _chunk(typ, data):
    return (struct.pack(">I", len(data)) + typ + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))


def encode_png_rgba(width, height, rows):
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter: none
        for px in row:
            raw += bytes(px)
    return (b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + _chunk(b"IEND", b""))


# --- texture lookup --------------------------------------------------------
def load_sources():
    jar_path = None
    for name in sorted(os.listdir(ROOT)):
        if name.startswith("nuclearcraft-") and name.endswith(".jar"):
            jar_path = os.path.join(ROOT, name)
            break
    jar_tex = {}
    if jar_path:
        with zipfile.ZipFile(jar_path) as zf:
            for n in zf.namelist():
                prefix = "assets/nuclearcraft/textures/blocks/"
                if n.startswith(prefix) and n.endswith(".png"):
                    jar_tex[n[len(prefix):]] = zf.read(n)
    addon_tex = {}
    if os.path.isdir(BLOCKS):
        for n in os.listdir(BLOCKS):
            if n.endswith(".png"):
                addon_tex[n] = None
    return jar_tex, addon_tex


def coil_ids():
    text = open(COILS_JS, encoding="utf-8").read()
    return re.findall(r'"id"\s*:\s*"([^"]+)"', text)


def coil_texture(cid):
    """Return the texture path relative to textures/blocks/ for a coil id."""
    if cid in BASE_IDS:
        return "turbine/dynamo_coil/%s.png" % cid
    state = os.path.join(BLOCKSTATES, "turbine_dynamo_coil_%s.json" % cid)
    if not os.path.exists(state):
        return None
    try:
        data = json.load(open(state, encoding="utf-8"))
    except (ValueError, OSError):
        return None
    tex = (data.get("defaults", {}).get("textures", {}) or {}).get("all")
    if not tex:
        return None
    rel = tex.replace("nuclearcraft:", "").lstrip("/")
    if rel.startswith("blocks/"):
        rel = rel[len("blocks/"):]
    if not rel.endswith(".png"):
        rel += ".png"
    return rel


def read_tile(rel, jar_tex, addon_tex):
    """Return a 16x16 RGBA tile (list of rows) for a textures/blocks path."""
    data = None
    if rel in addon_tex:
        path = os.path.join(BLOCKS, rel)
        if os.path.exists(path):
            data = open(path, "rb").read()
    if data is None and rel in jar_tex:
        data = jar_tex[rel]
    if data is None:
        return None
    w, h, rows = decode_png(data)
    if w < TILE or h < TILE:
        return None
    # Crop the top-left frame (animated textures stack frames vertically).
    return [row[:TILE] for row in rows[:TILE]]


def placeholder():
    return [[((255, 0, 255, 255) if (x // 4 + y // 4) % 2 else (0, 0, 0, 255))
             for x in range(TILE)] for y in range(TILE)]


def main():
    jar_tex, addon_tex = load_sources()
    ids = coil_ids()

    tiles = []   # (key, tile rows)
    warned = []
    for cid in ids:
        rel = coil_texture(cid)
        tile = read_tile(rel, jar_tex, addon_tex) if rel else None
        if tile is None:
            warned.append("%s (%s)" % (cid, rel))
            tile = placeholder()
        tiles.append((cid, tile))
    for key, rel in PARTS:
        tile = read_tile(rel, jar_tex, addon_tex)
        if tile is None:
            warned.append("%s (%s)" % (key, rel))
            tile = placeholder()
        tiles.append((key, tile))

    rows_count = (len(tiles) + COLS - 1) // COLS
    width, height = COLS * TILE, rows_count * TILE
    atlas = [[(0, 0, 0, 0)] * width for _ in range(height)]
    index = {}
    for i, (key, tile) in enumerate(tiles):
        tx, ty = (i % COLS) * TILE, (i // COLS) * TILE
        index[key] = i
        for y in range(TILE):
            atlas[ty + y][tx:tx + TILE] = tile[y]

    os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
    with open(OUT_PNG, "wb") as f:
        f.write(encode_png_rgba(width, height, atlas))

    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("// AUTO-GENERATED by tools/build_atlas.py -- do not edit by hand.\n")
        f.write("// Merged turbine part texture atlas (16x16 cells).\n")
        f.write("const COIL_ATLAS = ")
        json.dump({"url": "assets/coil-atlas.png", "tile": TILE, "cols": COLS,
                   "rows": rows_count, "index": index}, f, ensure_ascii=False, indent=2)
        f.write(";\n")
        f.write("if (typeof module !== 'undefined') module.exports = { COIL_ATLAS };\n")
        f.write("if (typeof window !== 'undefined') window.COIL_ATLAS = COIL_ATLAS;\n")

    print("wrote %s (%dx%d, %d tiles)" % (OUT_PNG, width, height, len(tiles)))
    print("wrote %s" % OUT_JS)
    if warned:
        print("WARNING: placeholder used for:")
        for w in warned:
            print("  ", w)
    else:
        print("all %d textures resolved" % len(tiles))


if __name__ == "__main__":
    main()
