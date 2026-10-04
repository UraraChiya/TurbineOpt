// Turbine placement-rule parser + evaluator.
// Mirrors nc.multiblock.turbine.TurbinePlacement.DefaultRuleParser and the
// adjacency logic of TurbineLogic.refreshDynamos.
//
// A rule string looks like:
//   "one bearing || one connector"
//   "one gold coil && one copper coil"
//   "three ironmagnet coils || three lithiummagnet coils"
//   "one of any coil"
// Default count type is AT_LEAST, default adjacency is STANDARD (the four
// in-plane neighbours of a wall block).
(function (root) {
  'use strict';

  var NUM = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    a: 1, an: 1
  };

  // Parse a single rule string into { op: 'and'|'or', terms: [...] }.
  // Each term = { count: 'atleast'|'exactly'|'atmost', amount: int,
  //               target: { kind: 'coil'|'any'|'bearing'|'connector'|'casing',
  //                         type: '<coilid>'? } }
  function parseRule(str) {
    str = String(str || '').trim().toLowerCase();
    var op, parts;
    if (str.indexOf('&&') !== -1) { op = 'and'; parts = str.split('&&'); }
    else if (str.indexOf('||') !== -1) { op = 'or'; parts = str.split('||'); }
    else { op = 'and'; parts = [str]; }

    var terms = [];
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k].replace(/\s+/g, ' ').trim();
      if (!p) continue;
      var count = 'atleast';
      if (p.indexOf('at least ') === 0) { count = 'atleast'; p = p.slice(9); }
      else if (p.indexOf('exactly ') === 0) { count = 'exactly'; p = p.slice(8); }
      else if (p.indexOf('at most ') === 0) { count = 'atmost'; p = p.slice(8); }

      // Adjacency qualifiers. Turbine dynamo coils have no depth, so axial /
      // edge / vertex never actually occur in the coil rules; ignore them.
      p = p.replace(/\bat a vertex\b/g, ' ')
           .replace(/\bvertex\b/g, ' ')
           .replace(/\bat an edge\b/g, ' ')
           .replace(/\bedge\b/g, ' ')
           .replace(/\baxial\b/g, ' ')
           .replace(/\s+/g, ' ').trim();

      var toks = p.split(' ');
      var amount = 1;
      if (/^\d+$/.test(toks[0])) { amount = parseInt(toks.shift(), 10); }
      else if (NUM[toks[0]] != null) { amount = NUM[toks.shift()]; }
      p = toks.join(' ');

      var target;
      if (/\bbearing\b/.test(p)) target = { kind: 'bearing' };
      else if (/\bconnector\b/.test(p)) target = { kind: 'connector' };
      else if (/\bcasing\b|\bwall\b/.test(p)) target = { kind: 'casing' };
      else if (/\bcoil\b/.test(p)) {
        var words = p.split(' ').filter(function (w) {
          return w !== 'coil' && w !== 'of' && w !== 'any' && w !== 'a' && w !== 'an';
        });
        if (words.length === 0) target = { kind: 'any' };
        else target = { kind: 'coil', type: words[words.length - 1] };
      } else {
        target = { kind: 'any' };
      }
      terms.push({ count: count, amount: amount, target: target });
    }
    return { op: op, terms: terms };
  }

  function listPrereqs(parsed) {
    var out = [];
    parsed.terms.forEach(function (t) {
      if (t.target.kind === 'coil') out.push(t.target.type);
      else if (t.target.kind === 'connector') out.push('@connector');
      else if (t.target.kind === 'bearing') out.push('@bearing');
    });
    return out;
  }

  var api = { parseRule: parseRule, listPrereqs: listPrereqs, NUM: NUM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TurbineRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
