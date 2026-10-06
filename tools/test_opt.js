const { COIL_DEFS, CONNECTOR_DEF } = require('/home/chiya/TurbineOpt/js/coils.js');
const { TurbineOptimizer, EMPTY, CONNECTOR, BEARING } = require('/home/chiya/TurbineOpt/js/optimizer.js');

const N = parseInt(process.argv[2] || '13', 10);
const B = parseInt(process.argv[3] || '3', 10);
const ms = parseInt(process.argv[4] || '3000', 10);

const opt = new TurbineOptimizer(N, B, {
  defs: COIL_DEFS,
  connectorRule: CONNECTOR_DEF.rule,
  reserved: [[0, 0], [0, 1]],
});

const t0 = Date.now();
const res = opt.optimize({ deadline: Date.now() + ms });
console.log('N=' + N, 'B=' + B, 'time=' + (Date.now() - t0) + 'ms', 'iters=' + res.iterations);
console.log('eff=' + res.eff.toFixed(6), 'M=' + res.M, 'S=' + res.S.toFixed(4), 'denom=' + Math.max(B * B, res.M));

// print grid
function sym(lab) {
  if (lab === BEARING) return ' B ';
  if (lab === EMPTY) return ' . ';
  if (lab === CONNECTOR) return ' C ';
  return (' ' + (lab % 100).toString().padStart(2)) + ' ';
}
// map coil id -> short label
const short = {};
COIL_DEFS.forEach((d, i) => { short[i] = d.id.slice(0, 2); });
for (let r = 0; r < N; r++) {
  let line = '';
  for (let c = 0; c < N; c++) {
    const i = r * N + c;
    const lab = res.labels[i];
    if (lab === BEARING) line += '##';
    else if (lab === EMPTY) line += ' .';
    else if (lab === CONNECTOR) line += ' C';
    else line += ' ' + (res.valid[i] ? 'o' : 'x');
  }
  console.log(line);
}
// list placed types
const counts = {};
for (let i = 0; i < N * N; i++) {
  const lab = res.labels[i];
  if (lab >= 0) counts[COIL_DEFS[lab].id] = (counts[COIL_DEFS[lab].id] || 0) + 1;
}
console.log(counts);
