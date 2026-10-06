// UI wiring for the turbine coil optimiser.
(function () {
  'use strict';

  var Opt = window.TurbineOpt;
  var Emp = window.TurbineExport;
  var Nbt = window.TurbineNbt;
  var Rules = window.TurbineRules;
  var Colors = window.TurbineColors;
  var Texture = window.TurbineTexture;
  var defs = window.COIL_DEFS;
  var connDef = window.CONNECTOR_DEF;
  var EMPTY = Opt.EMPTY, CONNECTOR = Opt.CONNECTOR, BEARING = Opt.BEARING, RESERVED = Opt.RESERVED;

  var defById = {};
  for (var di = 0; di < defs.length; di++) defById[defs[di].id] = defs[di];

  // Display name for a coil (now taken directly from the mod lang files).
  function coilName(d) {
    if (!d) return '';
    return d.nameZh || d.nameEn || d.id;
  }

  // Human-readable placement condition, e.g. "至少 1 个镁线圈".
  function ruleText(rule) {
    var parsed;
    try { parsed = Rules.parseRule(rule); } catch (e) { return String(rule || ''); }
    var parts = [];
    for (var i = 0; i < parsed.terms.length; i++) {
      var t = parsed.terms[i], tg = t.target;
      var prefix = t.count === 'exactly' ? '恰好 ' : (t.count === 'atmost' ? '至多 ' : '至少 ');
      var name;
      if (tg.kind === 'any') name = '任意线圈';
      else if (tg.kind === 'bearing') name = '轴承';
      else if (tg.kind === 'connector') name = '连接器';
      else if (tg.kind === 'casing') name = '外壳';
      else name = coilName(defById[tg.type]) || tg.type;
      parts.push(prefix + t.amount + ' 个' + name);
    }
    return parts.join(parsed.op === 'and' ? ' 且 ' : ' 或 ');
  }

  var state = {
    N: 11, B: 3,
    reserved: new Set(),
    reserveCount: 2,
    enabled: [],
    limits: [],
    fill: 'casing',
    opt: null,
    session: null,
    result: null,
    running: false,
    paused: false,
    startedAt: 0,
    lastPaint: 0,
    timer: null
  };
  for (var i = 0; i < defs.length; i++) { state.enabled.push(true); state.limits.push(null); }

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }); }

  // --- geometry -----------------------------------------------------------
  function collectMaxCounts() {
    var out = new Array(defs.length);
    for (var i = 0; i < defs.length; i++) {
      if (!state.enabled[i]) out[i] = 0;
      else out[i] = (state.limits[i] == null ? null : state.limits[i]);
    }
    return out;
  }

  function buildOptimizer() {
    var reserved = [];
    state.reserved.forEach(function (k) {
      var p = k.split(',');
      reserved.push([parseInt(p[0], 10), parseInt(p[1], 10)]);
    });
    return new Opt.TurbineOptimizer(state.N, state.B, {
      defs: defs, connectorRule: connDef.rule, reserved: reserved,
      reserveCount: state.reserveCount, maxCounts: collectMaxCounts()
    });
  }

  // --- coil list ----------------------------------------------------------
  function buildCoilList() {
    var list = $('coil-list');
    list.innerHTML = '';
    defs.forEach(function (d, i) {
      var row = document.createElement('div');
      row.className = 'coil-row';
      row.dataset.search = (d.id + ' ' + (d.nameZh || '') + ' ' + (d.nameEn || '')).toLowerCase();

      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = state.enabled[i];
      cb.addEventListener('change', function () { state.enabled[i] = cb.checked; });

      var sw = document.createElement('span');
      sw.className = 'sw';
      // Icon = the coil's texture only (no text); fall back to a colour block.
      if (!Texture.apply(sw, d.id, 18)) {
        var bg = Colors.color(d);
        sw.style.background = bg;
        sw.style.color = Colors.textColor(bg);
        sw.textContent = Colors.label(d);
      }

      var nm = document.createElement('div');
      nm.className = 'nm';
      nm.innerHTML = esc(d.nameZh || d.id) +
        ' <span class="en">' + esc(d.nameEn || '') + '</span>';

      var cond = document.createElement('div');
      cond.className = 'cond';
      cond.textContent = d.cond;

      var mx = document.createElement('input');
      mx.type = 'number'; mx.min = '0'; mx.placeholder = '上限';
      if (state.limits[i] != null) mx.value = state.limits[i];
      mx.addEventListener('change', function () {
        state.limits[i] = (mx.value === '' ? null : Math.max(0, parseInt(mx.value, 10) || 0));
      });

      // Hovering a row shows the coil's placement condition.
      row.addEventListener('mousemove', function (ev) {
        showTip(ev, '<div class="t-name">' + esc(coilName(d)) + '</div>' +
          '<div class="t-sub">导电率 ' + d.cond + '</div>' +
          '<div class="t-sub">放置条件：' + esc(ruleText(d.rule)) + '</div>');
      });
      row.addEventListener('mouseleave', hideTip);

      row.appendChild(cb); row.appendChild(sw); row.appendChild(nm);
      row.appendChild(cond); row.appendChild(mx);
      list.appendChild(row);
    });
    filterCoilList();
  }

  function filterCoilList() {
    var q = ($('coil-search').value || '').toLowerCase().trim();
    var rows = $('coil-list').children;
    for (var i = 0; i < rows.length; i++) {
      rows[i].style.display = (!q || rows[i].dataset.search.indexOf(q) !== -1) ? '' : 'none';
    }
  }

  // --- rendering ----------------------------------------------------------
  var FILL_COLORS = { casing: '#aab4c2', glass: '#9fd4e0' };
  var CELL_FONT = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

  function draw() {
    var opt = state.opt; if (!opt) return;
    var N = opt.N;
    var canvas = $('grid');
    var wrap = canvas.parentElement;
    var maxW = Math.min(wrap.clientWidth || 520, 640);
    var cell = Math.max(13, Math.min(40, Math.floor(maxW / N)));
    var dpr = window.devicePixelRatio || 1;
    canvas.width = N * cell * dpr; canvas.height = N * cell * dpr;
    canvas.style.width = N * cell + 'px'; canvas.style.height = N * cell + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, N * cell, N * cell);
    canvas._cell = cell;

    var labels = state.result ? state.result.labels : null;
    var fontSize = Math.max(9, Math.floor(cell * 0.42));
    ctx.font = '600 ' + fontSize + 'px ' + CELL_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.imageSmoothingEnabled = false; // pixel art: nearest-neighbour
    var atlasImg = Texture.isReady() ? Texture.image() : null;
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var i = r * N + c, dr = N - 1 - r;
        var x = c * cell, y = dr * cell;
        var lab = labels ? labels[i] : EMPTY;
        var key, col, text;
        if (opt.kind[i] === BEARING) { key = '__bearing'; col = '#39414f'; text = ''; }
        else if (opt.kind[i] === RESERVED || lab === RESERVED) { key = '__reserved'; col = '#ffd166'; text = '预'; }
        else if (lab >= 0) {
          var d = defs[lab]; key = d.id; col = Colors.color(d); text = Colors.label(d);
        }
        else if (lab === CONNECTOR) { key = '__connector'; col = '#37d0a0'; text = '连'; }
        else {
          key = state.fill === 'glass' ? '__glass' : '__casing';
          col = FILL_COLORS[state.fill] || FILL_COLORS.casing; text = '';
        }

        var drew = false;
        if (atlasImg && Texture.has(key)) {
          var t = Texture.tile(key);
          ctx.drawImage(atlasImg, t[0] * 16, t[1] * 16, 16, 16, x, y, cell, cell);
          drew = true;
        }
        if (!drew) { ctx.fillStyle = col; ctx.fillRect(x, y, cell, cell); }

        ctx.strokeStyle = 'rgba(0,0,0,.25)';
        ctx.strokeRect(x + .5, y + .5, cell - 1, cell - 1);
        if (opt.kind[i] === RESERVED) {
          ctx.strokeStyle = 'rgba(0,0,0,.55)';
          ctx.beginPath(); ctx.moveTo(x + 1, y + cell - 1); ctx.lineTo(x + cell - 1, y + 1); ctx.stroke();
        }
        if (text && cell >= 15) {
          var cx = x + cell / 2, cy = y + cell / 2 + 0.5;
          // Dark outline keeps the 1-2 char label readable over any texture.
          ctx.lineWidth = Math.max(2, cell * 0.12);
          ctx.strokeStyle = 'rgba(0,0,0,.78)';
          if (ctx.strokeText) ctx.strokeText(text, cx, cy);
          ctx.fillStyle = '#f4f8ff';
          ctx.fillText(text, cx, cy);
        }
      }
    }
  }

  function renderLegend() {
    var box = $('legend');
    if (!state.opt) { box.innerHTML = ''; return; }
    var items = [];
    var labels = state.result ? state.result.labels : null;
    var counts = {}, conn = 0, wall = 0, resv = 0, bear = 0;
    for (var i = 0; i < state.opt.kind.length; i++) {
      var k = state.opt.kind[i], lab = labels ? labels[i] : EMPTY;
      if (k === BEARING) bear++;
      else if (k === RESERVED || lab === RESERVED) resv++;
      else if (lab >= 0) counts[lab] = (counts[lab] || 0) + 1;
      else if (lab === CONNECTOR) conn++;
      else wall++;
    }
    items.push({ key: '__bearing', color: '#39414f', text: '#c7d2e0', label: '', name: '轴承', cnt: bear });
    items.push({
      key: state.fill === 'glass' ? '__glass' : '__casing',
      color: FILL_COLORS[state.fill] || FILL_COLORS.casing, text: '#33505c', label: '',
      name: state.fill === 'glass' ? '涡轮机玻璃' : '涡轮机外壳', cnt: wall
    });
    if (resv) items.push({ key: '__reserved', color: '#ffd166', text: '#0b0f14', label: '预', name: '预留', cnt: resv });
    if (conn) items.push({ key: '__connector', color: '#37d0a0', text: '#0b0f14', label: '连', name: '连接器', cnt: conn, cond: 0 });
    Object.keys(counts).map(Number).sort(function (a, b) { return defs[b].cond - defs[a].cond; }).forEach(function (idx) {
      var d = defs[idx], col = Colors.color(d);
      items.push({
        key: d.id, color: col, text: Colors.textColor(col), label: Colors.label(d),
        name: (d.nameZh || d.id), cnt: counts[idx], cond: d.cond
      });
    });
    box.innerHTML = items.map(function (it) {
      var tex = it.key ? Texture.cssText(it.key, 18) : '';
      return '<div class="item"><span class="swatch" style="' + tex +
        'background-color:' + it.color + ';color:' + it.text + '">' +
        esc(it.label || '') + '</span>' +
        '<span>' + esc(it.name) + '</span><span class="cnt">×' + it.cnt + '</span>' +
        (it.cond != null ? '<span class="cond">' + it.cond + '</span>' : '') + '</div>';
    }).join('');
  }

  function renderStats() {
    var r = state.result;
    if (!r) return;
    var conn = 0;
    for (var i = 0; i < r.labels.length; i++) if (r.labels[i] === CONNECTOR) conn++;
    var denom = Math.max(state.B * state.B, r.M);
    $('st-eff').textContent = r.eff.toFixed(3);
    $('st-m').textContent = r.M;
    $('st-s').textContent = r.S.toFixed(2);
    $('st-denom').textContent = denom;
    $('st-conn').textContent = conn;
  }

  // --- tooltip ------------------------------------------------------------
  function showTip(ev, html) {
    var tip = $('tooltip');
    tip.innerHTML = html;
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + w > window.innerWidth - 8) x = Math.max(8, ev.clientX - w - 14);
    if (y + h > window.innerHeight - 8) y = Math.max(8, ev.clientY - h - 14);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { $('tooltip').hidden = true; }

  function onMove(ev) {
    var canvas = $('grid'), tip = $('tooltip');
    if (!state.opt || !canvas._cell) { tip.hidden = true; return; }
    var rect = canvas.getBoundingClientRect();
    var cell = canvas._cell;
    var c = Math.floor((ev.clientX - rect.left) / cell);
    var dr = Math.floor((ev.clientY - rect.top) / cell);
    var N = state.opt.N, r = N - 1 - dr;
    if (c < 0 || c >= N || r < 0 || r >= N) { tip.hidden = true; return; }
    var i = r * N + c, kind = state.opt.kind[i];
    var labels = state.result ? state.result.labels : null;
    var lab = labels ? labels[i] : EMPTY;
    var name, lines = [];
    if (kind === BEARING) { name = '轴承'; lines.push('转子轴承'); }
    else if (kind === RESERVED || lab === RESERVED) { name = '预留位置'; lines.push('控制器 / 输入输出口'); }
    else if (lab >= 0) {
      var d = defs[lab];
      name = coilName(d);
      lines.push('导电率 ' + d.cond + ' · ' + (d.nameEn || d.id));
      lines.push('放置条件：' + ruleText(d.rule));
    } else if (lab === CONNECTOR) {
      name = '连接器';
      lines.push('无导电率，仅作桥接');
      lines.push('放置条件：' + ruleText(connDef.rule));
    } else {
      name = state.fill === 'glass' ? '涡轮机玻璃' : '涡轮机外壳';
    }
    showTip(ev, '<div class="t-name">' + esc(name) + '</div>' +
      lines.map(function (l) { return '<div class="t-sub">' + esc(l) + '</div>'; }).join(''));
  }

  function onClick(ev) {
    var canvas = $('grid');
    if (!state.opt || !canvas._cell) return;
    var rect = canvas.getBoundingClientRect();
    var cell = canvas._cell, N = state.opt.N;
    var c = Math.floor((ev.clientX - rect.left) / cell);
    var dr = Math.floor((ev.clientY - rect.top) / cell);
    var r = N - 1 - dr;
    if (c < 0 || c >= N || r < 0 || r >= N) return;
    var i = r * N + c;
    if (state.opt.kind[i] === BEARING) return;
    var key = r + ',' + c;
    if (state.reserved.has(key)) state.reserved.delete(key);
    else state.reserved.add(key);
    state.opt = buildOptimizer();
    state.result = null;
    draw(); renderLegend();
  }

  // --- run ----------------------------------------------------------------
  function validate() {
    var N = parseInt($('in-n').value, 10), B = parseInt($('in-b').value, 10);
    if (!(N >= 3) || !(B >= 1)) return 'N 和 B 必须是正整数。';
    if ((N - B) % 2 !== 0) return 'N 与 B 必须同奇偶（否则轴承无法居中）。';
    if (B > N - 2) return '需要 B ≤ N − 2。';
    state.N = N; state.B = B;
    return '';
  }

  function showError(msg) {
    var el = $('error');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = msg;
  }

  function setRunning(on) {
    state.running = on;
    $('btn-run').disabled = on;
    $('btn-run').textContent = on ? '运行中…' : '开始优化';
    $('btn-pause').disabled = !on;
    $('btn-stop').disabled = !on;
  }

  function setPaused(p) {
    state.paused = p;
    $('btn-pause').textContent = p ? '继续' : '暂停';
    var bar = $('progress-bar').parentElement;
    if (bar) bar.classList[p ? 'remove' : 'add']('active');
  }

  function scheduleTick() { state.timer = setTimeout(tick, 0); }

  function start() {
    if (state.running) { resume(); return; }
    var err = validate();
    if (err) { showError(err); return; }
    showError('');
    state.result = null;
    state.opt = buildOptimizer();
    // Continuous optimisation: runs until the user presses Stop.
    state.session = state.opt.createSession({ infinite: true });
    state.startedAt = Date.now();
    state.lastPaint = 0;
    setRunning(true);
    setPaused(false);
    $('progress-wrap').hidden = false;
    $('results').hidden = false;
    renderStats();
    tick();
  }

  function pause() {
    if (!state.running || state.paused) return;
    setPaused(true);
    clearTimeout(state.timer);
  }

  function resume() {
    if (!state.running || !state.paused) return;
    setPaused(false);
    scheduleTick();
  }

  function togglePause() {
    if (state.paused) resume(); else pause();
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    state.paused = false;
    clearTimeout(state.timer);
    finish();
  }

  function tick() {
    if (!state.running || state.paused) return;
    var s = state.session;
    state.opt.stepSession(s, 30);
    var secs = ((Date.now() - state.startedAt) / 1000).toFixed(0);
    $('progress-bar').style.width = '100%';
    $('progress-text').textContent = '已运行 ' + secs + ' s · 当前最优 ' + (s.best ? s.best.eff.toFixed(3) : '—');
    if (s.best) {
      state.result = s.best;
      renderStats();
      var now = Date.now();
      if (now - state.lastPaint > 150) { draw(); renderLegend(); state.lastPaint = now; }
    }
    if (s.done) { finish(); return; }
    scheduleTick();
  }

  function finish() {
    setRunning(false);
    setPaused(false);
    $('progress-wrap').hidden = true;
    var s = state.session;
    if (!s || !s.best) { showError('未找到可行布局，请检查参数或可用线圈。'); return; }
    state.result = s.best;
    draw(); renderLegend(); renderStats();
    $('results').hidden = false;
    buildExports();
  }

  // --- export -------------------------------------------------------------
  function origin() {
    return [parseInt($('ox').value, 10) || 0,
            parseInt($('oy').value, 10) || 0,
            parseInt($('oz').value, 10) || 0];
  }

  function buildExports() {
    if (!state.result) { $('snbt-out').value = ''; return; }
    var snbt = Emp.toBuildingGadgets(state.N, state.opt.kind, state.result.labels, defs, { origin: origin(), fill: state.fill });
    $('snbt-out').value = snbt;
  }

  function copySnbt() {
    var ta = $('snbt-out');
    if (!ta.value) return;
    var done = function () { flash($('btn-snbt'), '已复制 ✓'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(done, function () { fallbackCopy(ta); done(); });
    } else { fallbackCopy(ta); done(); }
  }
  function fallbackCopy(ta) { ta.removeAttribute('readonly'); ta.select(); document.execCommand('copy'); ta.setAttribute('readonly', ''); }
  function flash(btn, text) {
    var old = btn.textContent; btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 1400);
  }

  function exportNbt() {
    if (!state.result) return;
    var tag = Emp.toStructureTag(state.N, state.opt.kind, state.result.labels, defs, { origin: origin(), fill: state.fill });
    var bytes = Nbt.serialize('', tag);
    Nbt.gzip(bytes).then(function (gz) {
      Emp.download('turbine_coils.nbt', gz, 'application/gzip');
    }, function (e) {
      showError('导出 .nbt 失败：' + e.message);
      $('results').hidden = false;
    });
  }

  function exportMcFunction() {
    if (!state.result) return;
    var mc = Emp.toMcFunction(state.N, state.opt.kind, state.result.labels, defs, { origin: origin(), fill: state.fill });
    Emp.download('turbine_coils.mcfunction', mc, 'text/plain;charset=utf-8');
  }

  // --- init ---------------------------------------------------------------
  function init() {
    state.fill = ($('in-fill') && $('in-fill').value) === 'glass' ? 'glass' : 'casing';
    var rc = parseInt($('in-reserve-count').value, 10);
    state.reserveCount = Math.max(0, isNaN(rc) ? 2 : rc);
    buildCoilList();
    state.opt = buildOptimizer();
    draw(); renderLegend();
    // Repaint once the merged texture atlas is available.
    Texture.load(function () { draw(); renderLegend(); });

    $('btn-run').addEventListener('click', start);
    $('btn-pause').addEventListener('click', togglePause);
    $('btn-stop').addEventListener('click', stop);

    $('in-n').addEventListener('change', function () { onGeometry(); });
    $('in-b').addEventListener('change', function () { onGeometry(); });
    $('in-reserve-count').addEventListener('change', function () {
      var v = parseInt($('in-reserve-count').value, 10);
      state.reserveCount = Math.max(0, isNaN(v) ? 2 : v);
      state.opt = buildOptimizer(); state.result = null; draw(); renderLegend();
    });

    $('coil-search').addEventListener('input', filterCoilList);
    $('btn-all-on').addEventListener('click', function () {
      for (var i = 0; i < defs.length; i++) state.enabled[i] = true;
      buildCoilList();
    });
    $('btn-all-off').addEventListener('click', function () {
      for (var i = 0; i < defs.length; i++) state.enabled[i] = false;
      buildCoilList();
    });
    $('btn-bases').addEventListener('click', function () {
      var bases = { magnesium: 1, beryllium: 1, aluminum: 1, gold: 1, copper: 1, silver: 1 };
      for (var i = 0; i < defs.length; i++) state.enabled[i] = !!bases[defs[i].id];
      buildCoilList();
    });

    var canvas = $('grid');
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', function () { $('tooltip').hidden = true; });
    canvas.addEventListener('click', onClick);

    ['ox', 'oy', 'oz'].forEach(function (id) {
      $(id).addEventListener('change', function () { buildExports(); });
    });

    $('in-fill').addEventListener('change', function () {
      state.fill = $('in-fill').value === 'glass' ? 'glass' : 'casing';
      draw(); renderLegend(); buildExports();
    });

    $('btn-snbt').addEventListener('click', copySnbt);
    $('btn-snbt-file').addEventListener('click', function () {
      if (state.result) Emp.download('turbine_coils.snbt', $('snbt-out').value, 'text/plain;charset=utf-8');
    });
    $('btn-nbt').addEventListener('click', exportNbt);
    $('btn-mcfunction').addEventListener('click', exportMcFunction);

    window.addEventListener('resize', draw);
  }

  function onGeometry() {
    var err = validate();
    if (err) { showError(err); return; }
    showError('');
    // drop pinned reserved cells that are now inside the bearing
    var lo = (state.N - state.B) >> 1, keep = new Set();
    state.reserved.forEach(function (k) {
      var p = k.split(','), r = +p[0], c = +p[1];
      if (!(r >= lo && r < lo + state.B && c >= lo && c < lo + state.B)) keep.add(k);
    });
    state.reserved = keep;
    state.opt = buildOptimizer();
    state.result = null;
    draw(); renderLegend();
    $('results').hidden = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
