// Coil colours and short Chinese labels for the preview.
//
// Colours are chosen to roughly match the material a coil is named after
// (iron grey, gold, copper, lapis blue, ...).  Unmapped materials fall back to
// a deterministic, well-spread hue so every type stays distinguishable.
(function (root) {
  'use strict';

  var BASE_IDS = { magnesium: '镁', beryllium: '铍', aluminum: '铝', gold: '金', copper: '铜', silver: '银' };

  // material id -> colour.  Longest keys are matched first by the token
  // fallback, so compound names can appear here too.
  var COLORS = {
    magnesium: '#cfd4d8', beryllium: '#bfe6e6', aluminum: '#c9ced6', aluminium: '#c9ced6',
    gold: '#e0b93a', copper: '#c06a30', silver: '#c9cfd4',
    iron: '#8f969c', lithium: '#d7dbe6', constantan: '#a9756e', manganese: '#b06fa8',
    bronze: '#cd7f32', lead: '#5d6673', nickel: '#b6bfae', steel: '#7f8c9b',
    tin: '#c6ccc6', ferroboron: '#6b6f77', siliconcarbide: '#454c57', invar: '#708090',
    potassium: '#bdaed6', chromium: '#d6dde4', tungsten: '#5b5f66', zinc: '#93a7b3',
    neodymium: '#a9b8cf', osmium: '#7d8b99', iridium: '#ced6dd', samarium: '#a8a4b0',
    base: '#9099a0', nak: '#9fb0c0', antihydrogen: '#c98fd8',
    bricknether: '#8b3a2f', obsidian: '#2e2440', slimeball: '#6fbf4f', boron: '#6f6f6f',
    manganesedioxide: '#4a4a52', manganeseoxide: '#3f5a4a', zircaloy: '#a7b0b8',
    boronarsenide: '#5a5a66', boronnitride: '#dcdcdc', hardcarbon: '#33353a',
    hslasteel: '#86909a', lithiummanganesedioxide: '#6a4a6a', magnesiumdiboride: '#8a8f96',
    tough: '#4f5b66', extremealloy: '#3d4650', sicsiccmc: '#4a4a4a', sodium: '#d6d6a8',
    bariumoxide: '#e6e6d8', caesium137: '#d0b840', thermoconducting: '#8a8f96',
    zirconiummolybdenum: '#9aa3ab', nichrome: '#b0a0a0', niobium: '#a8a29a',
    titanium: '#b0b4b8', tungstencarbide: '#4f545c', bariumnitrate: '#e0e0e0',
    iodine: '#4a3a6a', corium: '#4a6a3a', liquidhelium: '#a8d8e8', liquidnitrogen: '#8fb8d8',
    cryotheum: '#6fd0e0', antideuterium: '#d0a8e0',
    lapis: '#2a4bb0', diamond: '#3fd8cf', emerald: '#2ecc71', prismarine: '#3f9e8a',
    arsenic: '#8a8a72', carobbiite: '#8a7f4a', fluorite: '#9a6fd0', rhodochrosite: '#c06a7a',
    villiaumite: '#b05a8a', zirconium: '#a8b0b0', glowstone: '#e0c060', quartz: '#e8e4d8',
    molybdenum: '#8a9aa6', endstone: '#d8d8a0', purpur: '#9a5fb0', cobalt: '#3f5fb0',
    lumium: '#e8c060', barium: '#b8c0b0', witherite: '#6a7a6a', promethium147: '#6fd060',
    mercury: '#b8bcc4', niobiumtin: '#9aa0a8', baratol: '#8a5a4a', gold198: '#c8a830',
    europium155: '#c08a60', strontium: '#d0603f', enderium: '#2f9e8f', terbium: '#a0c060',
    ytterbium: '#9ab0c0', redstone: '#cc2b1e', graphite: '#3a3a3a', signalum: '#d06030',
    smore: '#7a4a2a', electrum: '#e0c060', calcium: '#d8d8c8', hafnium: '#9aa0a8',
    lithium6deuteride: '#b8aed6', superalloy: '#8a9098', yttrium: '#9aa0a8',
    platinum: '#d8dde2', erbium: '#b090c0', radioactiveearth: '#6a7a4a', osmiridium: '#8a8f96',
    antihelium: '#e0a8d0', antihelium3: '#e89ac8'
  };

  var TOKENS = Object.keys(COLORS).sort(function (a, b) { return b.length - a.length; });

  function material(def) {
    return String(def.id).replace(/(magnet|stabilizer|converter|extractor)$/, '');
  }

  function color(def) {
    var m = material(def);
    if (COLORS[m]) return COLORS[m];
    // token fallback (e.g. ferrobron -> iron? no; just substring match)
    for (var i = 0; i < TOKENS.length; i++) {
      if (m.indexOf(TOKENS[i]) !== -1) return COLORS[TOKENS[i]];
    }
    // deterministic spread hue
    var h = 0;
    for (var k = 0; k < def.id.length; k++) h = (h * 31 + def.id.charCodeAt(k)) & 0xffffffff;
    var hue = (h % 360);
    return 'hsl(' + hue + ',58%,58%)';
  }

  // Extract 1-2 Chinese characters naming the coil type.
  function label(def) {
    if (BASE_IDS[def.id]) return BASE_IDS[def.id];
    var n = def.nameZh || '';
    var stripped = n
      .replace(/感应?涡轮机电磁铁$/, '')
      .replace(/涡轮机电磁铁$/, '')
      .replace(/涡轮机稳定器$/, '')
      .replace(/涡轮机能量转换器$/, '')
      .replace(/磁场稳定器$/, '')
      .replace(/磁场转化器$/, '')
      .replace(/能量提取器$/, '');
    if (!stripped) stripped = n;
    var out = '';
    for (var i = 0; i < stripped.length && out.length < 2; i++) {
      var ch = stripped.charAt(i);
      if ('-—·、 '.indexOf(ch) !== -1) continue;
      out += ch;
    }
    return out || String(def.id).slice(0, 2);
  }

  // Readable foreground for a background colour (hex or hsl()).
  function textColor(bg) {
    var r, g, b;
    var m = /^#([0-9a-f]{6})$/i.exec(bg);
    if (m) {
      r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16);
    } else {
      var mh = /hsl\((\d+(?:\.\d+)?),\s*(\d+)%,\s*(\d+)%\)/.exec(bg);
      if (mh) {
        var h = +mh[1] / 360, s = +mh[2] / 100, l = +mh[3] / 100;
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        var hue2 = function (t) {
          if (t < 0) t += 1; if (t > 1) t -= 1;
          if (t < 1 / 6) return p + (q - p) * 6 * t;
          if (t < 1 / 2) return q;
          if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
          return p;
        };
        r = Math.round(hue2(h + 1 / 3) * 255); g = Math.round(hue2(h) * 255); b = Math.round(hue2(h - 1 / 3) * 255);
      } else { return '#f0f4f8'; }
    }
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? '#0b0f14' : '#f2f6fb';
  }

  var api = { color: color, label: label, textColor: textColor, material: material, BASE_IDS: BASE_IDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TurbineColors = api;
})(typeof window !== 'undefined' ? window : globalThis);
