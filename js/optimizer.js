// Turbine coil-plane optimizer.
//
// Model
// -----
// The turbine end wall is an N x N square (the interior cross-section).  A
// centred B x B square holds the rotor bearings.  Every other cell of the wall
// is casing and may instead host a dynamo coil or a coil connector.  Two cells
// per face are reserved (left empty) for the controller and the fluid
// valve(s).
//
// A placed dynamo part only counts when its placement rule is satisfied by
// already-valid dynamo parts / bearings, exactly like
// TurbineLogic.refreshDynamos computes its least fixed point.  Connectors
// satisfy "connector" requirements and "one of any coil" but have no
// conductivity, so they are free bridges.
//
// Objective (matches the controller's "Dynamo Efficiency"):
//     M      = number of valid coils
//     S      = sum of their conductivities
//     eff    = S / max(B*B, M)
(function (root) {
  'use strict';

  var Rules = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./rules.js')
    : root.TurbineRules;
  var parseRule = Rules.parseRule;

  var EMPTY = -1;      // casing
  var CONNECTOR = -2;  // turbine coil connector
  var BEARING = -3;    // rotor bearing (static)
  var RESERVED = -4;   // left empty for controller / valve

  function TurbineOptimizer(N, B, opts) {
    opts = opts || {};
    this.N = N;
    this.B = B;
    this.defs = opts.defs;
    this.connName = opts.connectorName || 'connector';
    this.maxCounts = opts.maxCounts || null; // array of int|null, indexed like defs
    this.idx = {};
    for (var i = 0; i < this.defs.length; i++) this.idx[this.defs[i].id] = i;
    this.rules = this.defs.map(function (d) { return parseRule(d.rule); });
    this.connRule = parseRule(opts.connectorRule || 'one of any coil');

    var N2 = N * N;
    this.N2 = N2;
    this.kind = new Int16Array(N2);
    for (i = 0; i < N2; i++) this.kind[i] = EMPTY;
    var lo = (N - B) >> 1;
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        if (r >= lo && r < lo + B && c >= lo && c < lo + B) this.kind[r * N + c] = BEARING;
      }
    }
    var reserved = opts.reserved || [];
    for (i = 0; i < reserved.length; i++) {
      var ri = reserved[i][0] * N + reserved[i][1];
      if (this.kind[ri] === EMPTY) this.kind[ri] = RESERVED;
    }

    // 4-neighbourhood inside the plane.
    this.nbr = new Array(N2);
    for (r = 0; r < N; r++) {
      for (c = 0; c < N; c++) {
        var a = [];
        if (r > 0) a.push((r - 1) * N + c);
        if (r < N - 1) a.push((r + 1) * N + c);
        if (c > 0) a.push(r * N + c - 1);
        if (c < N - 1) a.push(r * N + c + 1);
        this.nbr[r * N + c] = a;
      }
    }

    this.free = [];
    this.bearingAdjacent = [];
    for (i = 0; i < N2; i++) {
      if (this.kind[i] === EMPTY) {
        this.free.push(i);
        var nb = this.nbr[i], adj = false;
        for (var q = 0; q < nb.length; q++) if (this.kind[nb[q]] === BEARING) { adj = true; break; }
        if (adj) this.bearingAdjacent.push(i);
      }
    }

    // Reserved (air) slots for the controller / fluid ports.  Fixed pins are
    // already marked RESERVED in `kind`; `reserveCount` is the total required
    // per face, so the optimiser must leave `extraReserve` further free cells
    // empty and may choose their positions itself.
    var fixedReserved = 0;
    for (i = 0; i < N2; i++) if (this.kind[i] === RESERVED) fixedReserved++;
    this.fixedReserved = fixedReserved;
    this.reserveCount = opts.reserveCount != null ? opts.reserveCount : fixedReserved;
    this.extraReserve = Math.max(0, this.reserveCount - fixedReserved);
    this.maxPlaced = this.free.length - this.extraReserve;

    this.order = this.computeOrder();
    this.pot = this.computePotential();
    // LNS parameters: fraction of the incumbent's coils destroyed each
    // iteration, tie-breaking noise during reconstruction, and how much worse
    // a new incumbent may be before it is rejected (record-to-record travel).
    // The window widens with the bearing: a large bearing leaves a big empty
    // "free lunch" plateau (denominator B^2) that is costly to descend into,
    // so regressions there must be tolerated or the search freezes at its seed.
    this.removeFrac = opts.removeFrac != null ? opts.removeFrac : 0.08;
    this.regrowBias = opts.regrowBias != null ? opts.regrowBias : 0.5;
    var defDelta = Math.min(0.25, 0.05 + 0.6 * (B * B) / this.free.length);
    this.recordDelta = opts.recordDelta != null ? opts.recordDelta : defDelta;

    this.labels = new Int16Array(N2);
    this.validScratch = new Uint8Array(N2);
    this.counts = new Int32Array(this.defs.length);
    this._valid = new Uint8Array(N2);
    this._M = 0; this._S = 0; this._eff = 0;
  }

  TurbineOptimizer.prototype.computeOrder = function () {
    var N = this.N, dist = new Int32Array(this.N2);
    for (var i = 0; i < this.N2; i++) dist[i] = -1;
    var q = [], qi;
    for (i = 0; i < this.N2; i++) if (this.kind[i] === BEARING) { dist[i] = 0; q.push(i); }
    for (qi = 0; qi < q.length; qi++) {
      var nb = this.nbr[q[qi]];
      for (var k = 0; k < nb.length; k++) {
        if (dist[nb[k]] < 0) { dist[nb[k]] = dist[q[qi]] + 1; q.push(nb[k]); }
      }
    }
    var free = this.free.slice();
    free.sort(function (a, b) { return dist[a] - dist[b]; });
    return free;
  };

  // Forward "potential": the best conductivity reachable by depending on a
  // given coil type.  Edges point from a coil to the prerequisites named in
  // its rule; "any coil" edges are ignored so that connectors do not create a
  // cycle through the whole tech tree.
  TurbineOptimizer.prototype.computePotential = function () {
    var n = this.defs.length;
    var pot = new Float64Array(n);
    for (var i = 0; i < n; i++) pot[i] = this.defs[i].cond;
    var connPot = 0;
    for (var iter = 0; iter < n + 4; iter++) {
      var changed = false;
      for (var u = 0; u < n; u++) {
        var terms = this.rules[u].terms;
        for (var t = 0; t < terms.length; t++) {
          var tg = terms[t].target;
          if (tg.kind === 'coil') {
            var ti = this.idx[tg.type];
            if (ti != null && pot[ti] < pot[u]) { pot[ti] = pot[u]; changed = true; }
          } else if (tg.kind === 'connector') {
            if (connPot < pot[u]) { connPot = pot[u]; changed = true; }
          }
        }
      }
      if (!changed) break;
    }
    this.connPot = connPot;
    return pot;
  };

  TurbineOptimizer.prototype.typeName = function (lab) {
    if (lab >= 0) return this.defs[lab].id;
    if (lab === CONNECTOR) return '@connector';
    return null;
  };

  // Evaluate the placement rule of a single dynamo part.
  TurbineOptimizer.prototype.ruleOK = function (i, valid, labels) {
    var lab = labels[i];
    var rule = lab >= 0 ? this.rules[lab] : this.connRule;
    var nbr = this.nbr[i];
    var isAnd = rule.op === 'and';
    var base = isAnd;
    for (var t = 0; t < rule.terms.length; t++) {
      var term = rule.terms[t], tg = term.target, cnt = 0, k;
      if (tg.kind === 'bearing') {
        for (k = 0; k < nbr.length; k++) if (this.kind[nbr[k]] === BEARING) cnt++;
      } else {
        for (k = 0; k < nbr.length; k++) {
          var j = nbr[k];
          if (!valid[j]) continue;
          var lj = labels[j];
          if (tg.kind === 'coil') { if (lj >= 0 && this.defs[lj].id === tg.type) cnt++; }
          else if (tg.kind === 'any') { if (lj >= 0) cnt++; }
          else if (tg.kind === 'connector') { if (lj === CONNECTOR) cnt++; }
          else if (tg.kind === 'casing') { cnt++; }
        }
      }
      var ok;
      if (term.count === 'exactly') ok = cnt === term.amount;
      else if (term.count === 'atmost') ok = cnt <= term.amount;
      else ok = cnt >= term.amount;
      if (isAnd) { if (!ok) return false; }
      else if (ok) return true;
    }
    return isAnd ? true : false;
  };

  // Least fixed point of valid dynamo parts.  Cells are visited in
  // bearing-distance order which makes the fixed point converge in a couple of
  // passes for the vast majority of layouts.
  TurbineOptimizer.prototype.evaluate = function (labels, maxPasses, outValid) {
    var valid = outValid || this._valid;
    valid.fill(0);
    var order = this.order, changed = true, passes = 0;
    if (!maxPasses) maxPasses = 1e9;
    while (changed && passes < maxPasses) {
      changed = false; passes++;
      for (var k = 0; k < order.length; k++) {
        var i = order[k];
        var lab = labels[i];
        if (lab === EMPTY || lab === RESERVED || lab === BEARING) continue;
        if (valid[i]) continue;
        if (this.ruleOK(i, valid, labels)) { valid[i] = 1; changed = true; }
      }
    }
    var M = 0, S = 0;
    for (k = 0; k < order.length; k++) {
      var c = order[k];
      if (valid[c] && labels[c] >= 0) { M++; S += this.defs[labels[c]].cond; }
    }
    var denom = this.B * this.B;
    if (M > denom) denom = M;
    this._M = M; this._S = S; this._eff = M > 0 ? S / denom : 0;
    return this._eff;
  };

  TurbineOptimizer.prototype.effFromCounts = function (M, S) {
    var denom = this.B * this.B;
    if (M > denom) denom = M;
    return M > 0 ? S / denom : 0;
  };

  TurbineOptimizer.prototype.currentCounts = function (labels, valid) {
    var counts = new Int32Array(this.defs.length);
    for (var k = 0; k < this.order.length; k++) {
      var i = this.order[k], lab = labels[i];
      if (lab >= 0 && valid[i]) counts[lab]++;
    }
    return counts;
  };

  // Mark exactly `extraReserve` still-empty free cells as RESERVED (air) so the
  // controller / fluid ports have a home.  Marking does not change the score:
  // RESERVED is treated like EMPTY by evaluate().
  TurbineOptimizer.prototype.markReserves = function (labels) {
    var need = this.extraReserve;
    if (!need) return labels;
    var have = 0, k, i;
    for (k = 0; k < this.free.length; k++) {
      if (labels[this.free[k]] === RESERVED) have++;
    }
    for (k = 0; k < this.order.length && have < need; k++) {
      i = this.order[k];
      if (labels[i] === EMPTY) { labels[i] = RESERVED; have++; }
    }
    return labels;
  };

  // --- greedy growth ------------------------------------------------------
  // Repeatedly place the dynamo part with the highest forward "potential"
  // (breaking ties by conductivity).  This drives construction towards the
  // deepest / strongest coils instead of greedily grabbing the highest
  // conductivity base coil.
  TurbineOptimizer.prototype.grow = function (labels, rng, bias) {
    var defs = this.defs, valid = new Uint8Array(this.N2);
    var counts = new Int32Array(defs.length);
    var maxCounts = this.maxCounts;
    bias = bias || 0;
    var placed = 0;
    var b2 = this.B * this.B, M = 0, S = 0;
    // Best-eff snapshot seen while building: the whole filled plane has a much
    // worse average than the small high-conductivity cluster encountered on the
    // way, so this is the incumbent the LNS should start from.
    var bestEff = 0, bestLabels = labels.slice(), bestM = 0, bestS = 0;
    for (;;) {
      if (placed >= this.maxPlaced) break;
      var bestI = -1, bestType = EMPTY, bestScore = -Infinity;
      for (var fi = 0; fi < this.free.length; fi++) {
        var i = this.free[fi];
        if (labels[i] !== EMPTY) continue;
        var nb = this.nbr[i], adj = false;
        for (var k = 0; k < nb.length; k++) {
          if (this.kind[nb[k]] === BEARING || valid[nb[k]]) { adj = true; break; }
        }
        if (!adj) continue;
        for (var t = 0; t < defs.length; t++) {
          if (maxCounts && maxCounts[t] != null && counts[t] >= maxCounts[t]) continue;
          labels[i] = t;
          var ok = this.ruleOK(i, valid, labels);
          labels[i] = EMPTY;
          if (!ok) continue;
          var score = this.pot[t] + defs[t].cond * 1e-4 + (rng ? rng() * bias : 0);
          if (score > bestScore) { bestScore = score; bestI = i; bestType = t; }
        }
      }
      if (bestI < 0) break;
      labels[bestI] = bestType;
      valid[bestI] = 1;
      counts[bestType]++;
      placed++; M++; S += defs[bestType].cond;
      var e = S / Math.max(b2, M);
      if (e > bestEff + 1e-12) { bestEff = e; bestLabels = labels.slice(); bestM = M; bestS = S; }
    }
    return { valid: valid, best: { labels: bestLabels, eff: bestEff, M: bestM, S: bestS } };
  };

  // Remove dynamo parts that are not part of the valid network.  This is
  // always safe: valid parts are defined by a least fixed point that never
  // depends on invalid parts.
  TurbineOptimizer.prototype.prune = function (labels, valid) {
    for (var k = 0; k < this.order.length; k++) {
      var i = this.order[k], lab = labels[i];
      if ((lab >= 0 || lab === CONNECTOR) && !valid[i]) labels[i] = EMPTY;
    }
  };

  // --- large-neighbourhood search -----------------------------------------
  // The optimum is normally a *small* dense cluster of high-conductivity
  // coils, while the potential-guided greedy fills the whole plane with a
  // mediocre average.  Single-cell annealing cannot cross that valley, so the
  // main search is ruin-and-recreate: repeatedly delete a random slice of the
  // incumbent's coils and greedily rebuild a valid layout, keeping the best.

  // Potential-guided greedy seed.  We keep the best-eff snapshot along the
  // build (a small, strong cluster) rather than the fully-filled plane, then
  // prune and mark reserves.  This is the initial incumbent for the LNS.
  TurbineOptimizer.prototype.initialSeed = function () {
    var labels = new Int16Array(this.N2);
    labels.fill(EMPTY);
    this.labels = labels;
    var bl = this.grow(labels, null, 0).best.labels;
    this.evaluate(bl, 0);
    this.prune(bl, this._valid);
    this.markReserves(bl);
    var eff = this.evaluate(bl, 0);
    return { labels: bl, valid: new Uint8Array(this._valid), M: this._M, S: this._S, eff: eff };
  };

  // Greedily fill the EMPTY cells of `labels` (which may already hold a partial
  // layout) in potential order, returning the best-eff snapshot along the way.
  // RESERVED cells are left empty.
  TurbineOptimizer.prototype.regrow = function (labels) {
    var defs = this.defs, valid = this.validScratch;
    this.evaluate(labels, 0, valid);
    var M = this._M, S = this._S, b2 = this.B * this.B;
    var bestEff = M > 0 ? S / Math.max(b2, M) : 0;
    var bestLabels = labels.slice(), bestM = M, bestS = S;
    var counts = this.currentCounts(labels, valid);
    for (;;) {
      var bestI = -1, bestType = EMPTY, bestScore = -Infinity;
      for (var fi = 0; fi < this.free.length; fi++) {
        var i = this.free[fi];
        if (labels[i] !== EMPTY) continue;
        var nb = this.nbr[i], adj = false;
        for (var k = 0; k < nb.length; k++) {
          if (this.kind[nb[k]] === BEARING || valid[nb[k]]) { adj = true; break; }
        }
        if (!adj) continue;
        for (var t = 0; t < defs.length; t++) {
          if (this.maxCounts && this.maxCounts[t] != null && counts[t] >= this.maxCounts[t]) continue;
          labels[i] = t;
          var ok = this.ruleOK(i, valid, labels);
          labels[i] = EMPTY;
          if (!ok) continue;
          var score = this.pot[t] + defs[t].cond * 1e-4 + Math.random() * this.regrowBias;
          if (score > bestScore) { bestScore = score; bestI = i; bestType = t; }
        }
      }
      if (bestI < 0) break;
      labels[bestI] = bestType; valid[bestI] = 1; counts[bestType]++; M++; S += defs[bestType].cond;
      var e = S / Math.max(b2, M);
      if (e > bestEff + 1e-12) { bestEff = e; bestLabels = labels.slice(); bestM = M; bestS = S; }
    }
    return { labels: bestLabels, eff: bestEff, M: bestM, S: bestS };
  };

  // One ruin-and-recreate step around an incumbent layout.
  TurbineOptimizer.prototype.lnsStep = function (base) {
    var w = base.labels.slice(), i;
    var cells = [];
    for (i = 0; i < this.N2; i++) {
      if (this.kind[i] !== BEARING && w[i] >= 0) cells.push(i);
    }
    if (cells.length) {
      var k = Math.max(1, Math.round(cells.length * this.removeFrac));
      for (var q = 0; q < k; q++) {
        var p = (Math.random() * cells.length) | 0;
        w[cells[p]] = EMPTY;
      }
    }
    // coils that lost their prerequisites in the ruin are dropped as well
    this.evaluate(w, 0);
    for (i = 0; i < this.N2; i++) {
      if (this.kind[i] !== BEARING && w[i] >= 0 && !this._valid[i]) w[i] = EMPTY;
    }
    return this.regrow(w);
  };

  // Finalise a candidate (prune + reserves + full evaluation) so it can be
  // compared or exported.
  TurbineOptimizer.prototype.finalizeLNS = function (cand) {
    var labels = cand.labels;
    this.evaluate(labels, 0);
    this.prune(labels, this._valid);
    this.markReserves(labels);
    var eff = this.evaluate(labels, 0);
    return { labels: labels, valid: new Uint8Array(this._valid), M: this._M, S: this._S, eff: eff };
  };

  // --- top-level optimiser ------------------------------------------------
  TurbineOptimizer.prototype.optimize = function (opts) {
    opts = opts || {};
    if (opts.removeFrac != null) this.removeFrac = opts.removeFrac;
    var deadline = opts.deadline || (Date.now() + 3000);
    var bestEver = this.initialSeed();
    var cur = bestEver;
    var iterations = 0;
    while (Date.now() < deadline) {
      var fe = this.finalizeLNS(this.lnsStep(cur));
      iterations++;
      // record-to-record travel: accept small regressions to drift between
      // basins, but always remember the true best.
      if (fe.eff >= cur.eff * (1 - this.recordDelta)) cur = fe;
      if (fe.eff > bestEver.eff + 1e-12) bestEver = fe;
    }
    return {
      labels: bestEver.labels, valid: bestEver.valid, M: bestEver.M, S: bestEver.S,
      eff: bestEver.eff, iterations: iterations
    };
  };

  // --- time-sliced session ------------------------------------------------
  // The browser drives a session by repeatedly calling stepSession() from a
  // timer so the page stays responsive.  Each call does at most budgetMs of
  // work.
  TurbineOptimizer.prototype.createSession = function (opts) {
    opts = opts || {};
    if (opts.removeFrac != null) this.removeFrac = opts.removeFrac;
    var totalMs = opts.infinite ? Infinity : (opts.totalMs || 3000);
    var now = Date.now();
    return {
      opt: this,
      options: opts,
      totalMs: totalMs,
      deadline: now + totalMs,
      start: now,
      phase: 'seed',
      best: null,
      validOut: null,
      eff: 0, M: 0, S: 0,
      iterations: 0,
      done: false
    };
  };

  TurbineOptimizer.prototype.stepSession = function (s, budgetMs) {
    if (s.done) return s;
    var end = Date.now() + (budgetMs || 30);

    if (s.phase === 'seed') {
      // One potential-guided seed (its best-eff cluster), improved with LNS.
      s.best = this.initialSeed();
      s.cur = s.best;
      s.phase = 'improve';
      s.validOut = s.best.valid;
      s.eff = s.best.eff; s.M = s.best.M; s.S = s.best.S;
      return s;
    }

    while (Date.now() < end && Date.now() < s.deadline) {
      var fe = this.finalizeLNS(this.lnsStep(s.cur));
      s.iterations++;
      // record-to-record travel between basins, keeping the true best
      if (fe.eff >= s.cur.eff * (1 - this.recordDelta)) s.cur = fe;
      if (fe.eff > s.best.eff + 1e-12) s.best = fe;
    }
    if (Date.now() >= s.deadline) s.done = true;
    s.validOut = s.best.valid;
    s.eff = s.best.eff; s.M = s.best.M; s.S = s.best.S;
    return s;
  };

  var api = {
    TurbineOptimizer: TurbineOptimizer,
    EMPTY: EMPTY, CONNECTOR: CONNECTOR, BEARING: BEARING, RESERVED: RESERVED
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TurbineOpt = api;
})(typeof window !== 'undefined' ? window : globalThis);
