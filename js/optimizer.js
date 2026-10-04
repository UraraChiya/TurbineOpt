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

    this.order = this.computeOrder();
    this.pot = this.computePotential();

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
    }
    return valid;
  };

  // --- local search -------------------------------------------------------
  // Simulated annealing over single-cell assignments, evaluated with the full
  // game semantics.  The greedy growth result is used as the initial state.
  TurbineOptimizer.prototype.anneal = function (labels, opts) {
    opts = opts || {};
    var deadline = opts.deadline || Date.now() + 2000;
    var eff = this.evaluate(labels, 0);
    var valid = new Uint8Array(this._valid);
    var M = this._M, S = this._S;
    var bestLabels = labels.slice();
    var bestEff = eff, bestM = M, bestS = S;
    var bestValid = new Uint8Array(valid);
    var counts = this.currentCounts(labels, valid);
    var free = this.free, nfree = free.length;
    var defs = this.defs, ntypes = defs.length;
    var temp = opts.temp || (0.25 * Math.max(bestEff, 1e-3));
    var cooling = opts.cooling || 0.9995;
    var itersPerCheck = 64, iterations = 0;

    // Candidate moves: random cell + random value, and "extend a prerequisite
    // of a neighbouring target" moves that help build chains.
    while (Date.now() < deadline) {
      for (var step = 0; step < itersPerCheck; step++) {
        iterations++;
        var i = free[(Math.random() * nfree) | 0];
        var old = labels[i];
        var nv;
        var roll = Math.random();
        if (roll < 0.35) {
          nv = EMPTY;
        } else if (roll < 0.75) {
          nv = (Math.random() * ntypes) | 0;
        } else if (roll < 0.9) {
          nv = CONNECTOR;
        } else {
          // place a prerequisite of a rule that wants something next door
          nv = this.suggestValue(i);
          if (nv == null) nv = (Math.random() * ntypes) | 0;
        }
        if (nv === old) continue;
        if (nv >= 0 && this.maxCounts && this.maxCounts[nv] != null &&
            nv !== old && counts[nv] >= this.maxCounts[nv]) continue;
        labels[i] = nv;
        var e = this.evaluate(labels, 5, this.validScratch);
        var d = e - eff;
        if (d >= 0 || Math.random() < Math.exp(d / temp)) {
          if (old >= 0) counts[old]--;
          if (nv >= 0) counts[nv]++;
          eff = e;
          valid.set(this.validScratch);
          M = this._M; S = this._S;
          if (eff > bestEff) {
            // confirm with a fully converged evaluation
            var full = this.evaluate(labels, 0);
            bestEff = full; bestM = this._M; bestS = this._S;
            bestLabels = labels.slice();
            bestValid.set(this._valid);
          }
        } else {
          labels[i] = old;
        }
      }
      temp *= cooling;
      if (temp < 1e-6) temp = 1e-6;
    }
    return { labels: bestLabels, valid: bestValid, M: bestM, S: bestS, eff: bestEff, iterations: iterations };
  };

  // Suggest a type that would satisfy an adjacent coil's unmet prerequisite.
  TurbineOptimizer.prototype.suggestValue = function (i) {
    var nb = this.nbr[i];
    var cands = [];
    for (var k = 0; k < nb.length; k++) {
      var lab = this.labels[nb[k]];
      if (lab < 0) continue;
      var terms = this.rules[lab].terms;
      for (var t = 0; t < terms.length; t++) {
        var tg = terms[t].target;
        if (tg.kind === 'coil') {
          var ti = this.idx[tg.type];
          if (ti != null) cands.push(ti);
        } else if (tg.kind === 'connector') cands.push(CONNECTOR);
        else if (tg.kind === 'bearing') { /* bearing is static */ }
      }
    }
    if (!cands.length) return null;
    return cands[(Math.random() * cands.length) | 0];
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

  // --- top-level optimiser ------------------------------------------------
  TurbineOptimizer.prototype.optimize = function (opts) {
    opts = opts || {};
    var seedRuns = opts.seedRuns || 24;
    var rng = opts.rng || Math.random;
    var deadline = opts.deadline || (Date.now() + 3000);
    var best = null;

    // Phase 1: several randomised greedy growths.
    for (var s = 0; s < seedRuns; s++) {
      var labels = new Int16Array(this.N2);
      labels.fill(EMPTY);
      this.labels = labels;
      var valid = this.grow(labels, rng, opts.bias != null ? opts.bias : 0);
      this.evaluate(labels, 0);
      this.prune(labels, this._valid);
      var e = this.evaluate(labels, 0);
      if (!best || e > best.eff + 1e-12 || (Math.abs(e - best.eff) < 1e-12 && this._M < best.M)) {
        best = { labels: labels.slice(), valid: new Uint8Array(this._valid), M: this._M, S: this._S, eff: e };
      }
      if (Date.now() > deadline) break;
    }

    // Phase 2: simulated annealing from the best seed.
    var work = best.labels.slice();
    this.labels = work;
    var res = this.anneal(work, { deadline: deadline, temp: opts.temp, cooling: opts.cooling });
    if (res.eff > best.eff + 1e-12) {
      best = { labels: res.labels, valid: res.valid, M: res.M, S: res.S, eff: res.eff };
    }
    return best;
  };

  // --- time-sliced session ------------------------------------------------
  // The browser drives a session by repeatedly calling stepSession() from a
  // timer so the page stays responsive.  Each call does at most budgetMs of
  // work.
  TurbineOptimizer.prototype.createSession = function (opts) {
    opts = opts || {};
    var totalMs = opts.totalMs || 3000;
    var now = Date.now();
    return {
      opt: this,
      options: opts,
      seedRuns: opts.seedRuns || 24,
      totalMs: totalMs,
      deadline: now + totalMs,
      start: now,
      phase: 'seed',
      seedIdx: 0,
      cooling: opts.cooling || 0.9995,
      best: null,
      work: null,
      valid: null,
      validOut: null,
      eff: 0, M: 0, S: 0, temp: 0,
      iterations: 0,
      done: false
    };
  };

  TurbineOptimizer.prototype.stepSession = function (s, budgetMs) {
    if (s.done) return s;
    var end = Date.now() + (budgetMs || 30);

    if (s.phase === 'seed') {
      while (s.seedIdx < s.seedRuns && Date.now() < end) {
        var labels = new Int16Array(this.N2);
        labels.fill(EMPTY);
        this.labels = labels;
        this.grow(labels, Math.random, 0);
        this.evaluate(labels, 0);
        this.prune(labels, this._valid);
        var e = this.evaluate(labels, 0);
        if (!s.best || e > s.best.eff + 1e-12 ||
            (Math.abs(e - s.best.eff) < 1e-12 && this._M < s.best.M)) {
          s.best = {
            labels: labels.slice(), valid: new Uint8Array(this._valid),
            M: this._M, S: this._S, eff: e
          };
        }
        s.seedIdx++;
      }
      if (s.seedIdx >= s.seedRuns || Date.now() >= s.deadline) {
        s.work = s.best.labels.slice();
        this.labels = s.work;
        this.evaluate(s.work, 0);
        s.valid = new Uint8Array(this._valid);
        s.counts = this.currentCounts(s.work, s.valid);
        s.eff = s.best.eff; s.M = s.best.M; s.S = s.best.S;
        s.temp = s.options.temp || (0.25 * Math.max(s.best.eff, 1e-3));
        s.phase = 'anneal';
      }
      s.validOut = s.best.valid;
      s.eff = s.best.eff; s.M = s.best.M; s.S = s.best.S;
      return s;
    }

    // anneal
    var free = this.free, nfree = free.length, ntypes = this.defs.length;
    while (Date.now() < end && Date.now() < s.deadline) {
      for (var step = 0; step < 64; step++) {
        s.iterations++;
        var i = free[(Math.random() * nfree) | 0];
        var old = s.work[i];
        var nv, roll = Math.random();
        if (roll < 0.35) nv = EMPTY;
        else if (roll < 0.75) nv = (Math.random() * ntypes) | 0;
        else if (roll < 0.9) nv = CONNECTOR;
        else { nv = this.suggestValue(i); if (nv == null) nv = (Math.random() * ntypes) | 0; }
        if (nv === old) continue;
        // enforce per-coil limits (0 == disabled)
        if (nv >= 0 && this.maxCounts && this.maxCounts[nv] != null &&
            nv !== old && s.counts[nv] >= this.maxCounts[nv]) continue;
        s.work[i] = nv;
        var e2 = this.evaluate(s.work, 5, this.validScratch);
        var d = e2 - s.eff;
        if (d >= 0 || Math.random() < Math.exp(d / s.temp)) {
          if (old >= 0) s.counts[old]--;
          if (nv >= 0) s.counts[nv]++;
          s.eff = e2;
          s.valid.set(this.validScratch);
          s.M = this._M; s.S = this._S;
          if (e2 > s.best.eff) {
            this.evaluate(s.work, 0);
            if (this._eff > s.best.eff) {
              s.best = {
                labels: s.work.slice(), valid: new Uint8Array(this._valid),
                M: this._M, S: this._S, eff: this._eff
              };
            }
            s.eff = this._eff; s.M = this._M; s.S = this._S;
            s.valid.set(this._valid);
          }
        } else {
          s.work[i] = old;
        }
      }
      s.temp *= s.cooling;
      if (s.temp < 1e-6) s.temp = 1e-6;
    }
    if (Date.now() >= s.deadline) s.done = true;
    s.validOut = s.best.valid;
    return s;
  };

  var api = {
    TurbineOptimizer: TurbineOptimizer,
    EMPTY: EMPTY, CONNECTOR: CONNECTOR, BEARING: BEARING, RESERVED: RESERVED
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TurbineOpt = api;
})(typeof window !== 'undefined' ? window : globalThis);
