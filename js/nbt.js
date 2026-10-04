// Minimal Minecraft NBT (Named Binary Tag) encoder.
//
// Only the tag kinds needed for structure files are implemented.  The encoder
// returns the raw big-endian NBT bytes; use `gzip` to wrap them for a
// structure block file (structures are stored gzipped).
(function (root) {
  'use strict';

  var T = {
    END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
    BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12
  };

  function tag(type, value) { return { type: type, value: value }; }

  var Nbt = {
    T: T,
    tag: tag,
    byte: function (v) { return tag(T.BYTE, v | 0); },
    short: function (v) { return tag(T.SHORT, v | 0); },
    int: function (v) { return tag(T.INT, v | 0); },
    long: function (v) { return tag(T.LONG, v); },
    string: function (v) { return tag(T.STRING, String(v)); },
    intArray: function (v) { return tag(T.INT_ARRAY, v); },
    // items: array of tags (all must share the same type)
    list: function (elemType, items) { return tag(T.LIST, { elemType: elemType, items: items }); },
    // entries: object mapping name -> tag (insertion order is preserved)
    compound: function (entries) { return tag(T.COMPOUND, entries); }
  };

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }

  function Writer() { this.bytes = []; }
  Writer.prototype.u8 = function (v) { this.bytes.push(v & 0xff); };
  Writer.prototype.i16 = function (v) {
    this.bytes.push((v >> 8) & 0xff, v & 0xff);
  };
  Writer.prototype.i32 = function (v) {
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };
  Writer.prototype.i64 = function (v) {
    // v may be a Number (safe up to 2^53)
    var hi = Math.floor(v / 4294967296);
    var lo = v >>> 0;
    this.i32(hi); this.i32(lo);
  };
  Writer.prototype.str = function (s) {
    var b = utf8Bytes(s);
    this.i16(b.length);
    for (var i = 0; i < b.length; i++) this.bytes.push(b[i]);
  };

  function writePayload(w, type, value) {
    var i;
    switch (type) {
      case T.BYTE: w.u8(value); break;
      case T.SHORT: w.i16(value); break;
      case T.INT: w.i32(value); break;
      case T.LONG: w.i64(value); break;
      case T.FLOAT:
        var fbuf = new ArrayBuffer(4); new DataView(fbuf).setFloat32(0, value, false);
        var f8 = new Uint8Array(fbuf); for (i = 0; i < 4; i++) w.bytes.push(f8[i]); break;
      case T.DOUBLE:
        var dbuf = new ArrayBuffer(8); new DataView(dbuf).setFloat64(0, value, false);
        var d8 = new Uint8Array(dbuf); for (i = 0; i < 8; i++) w.bytes.push(d8[i]); break;
      case T.BYTE_ARRAY:
        w.i32(value.length);
        for (i = 0; i < value.length; i++) w.u8(value[i]);
        break;
      case T.STRING: w.str(value); break;
      case T.LIST:
        w.u8(value.elemType);
        w.i32(value.items.length);
        for (i = 0; i < value.items.length; i++) writePayload(w, value.elemType, value.items[i].value);
        break;
      case T.COMPOUND:
        var keys = Object.keys(value);
        for (i = 0; i < keys.length; i++) {
          var k = keys[i], child = value[k];
          if (child == null) continue;
          w.u8(child.type);
          w.str(k);
          writePayload(w, child.type, child.value);
        }
        w.u8(T.END);
        break;
      case T.INT_ARRAY:
        w.i32(value.length);
        for (i = 0; i < value.length; i++) w.i32(value[i]);
        break;
      case T.LONG_ARRAY:
        w.i32(value.length);
        for (i = 0; i < value.length; i++) w.i64(value[i]);
        break;
      default:
        throw new Error('Unknown NBT tag type ' + type);
    }
  }

  // Serialize a named root tag.  `name` may be '' for the standard root name.
  Nbt.serialize = function (name, rootTag) {
    var w = new Writer();
    w.u8(rootTag.type);
    w.str(name || '');
    writePayload(w, rootTag.type, rootTag.value);
    return new Uint8Array(w.bytes);
  };

  // Gzip helper.  Uses the platform CompressionStream when available
  // (Chrome/Edge/Firefox/Safari all ship it now).  Returns a Promise.
  Nbt.gzip = function (u8) {
    if (typeof CompressionStream === 'undefined') {
      return Promise.reject(new Error('CompressionStream is not available in this browser; cannot create gzipped .nbt'));
    }
    var cs = new CompressionStream('gzip');
    var writer = cs.writable.getWriter();
    writer.write(u8);
    writer.close();
    return new Response(cs.readable).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Nbt;
  root.TurbineNbt = Nbt;
})(typeof window !== 'undefined' ? window : globalThis);
