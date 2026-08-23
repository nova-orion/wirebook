// Exhaustive scalar-quoting sweep.
//
//   node test/sweep.mjs            # emit + compare against `inv fmt`
//
// The fixed list of awkward values in core.test.mjs is a museum of past bugs.
// This enumerates every 1- and 2-character string over an alphabet of
// YAML-significant characters, plus targeted longer cases, batches them into one
// document as meta values, and diffs the JS emitter against Go's. Any mismatch
// is a byte the browser would write that the CLI would rewrite, which is what
// turns every git diff into noise.
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'third_party/js-yaml.min.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/core.js'), 'utf8') + '\nglobalThis.__Core = Core;', ctx);
const Core = ctx.__Core;

const C = c => String.fromCharCode(c);
const ALPHABET = [
  '0', '1', '7', '9', 'a', 'e', 'n', 'o', 'y', 'T', 'N', 'Y',
  '-', '+', '.', ':', ',', '#', "'", '"', '{', '}', '[', ']',
  '&', '*', '!', '|', '>', '%', '@', '`', '~', '?', '=', '_', '/',
  ' ', C(160), '\u00e9', '\u{1F600}',
];

const LONGER = [
  '0X1F', '0O17', '0B101', '0x1f', '1_000', '9007199254740993', '-0', '+0',
  '2024-03-01', '2024-03-01 12:00', '2024-03-01T12:00:00Z', '12:30', '1:2:3',
  '.inf', '-.inf', '.NAN', '.nan', 'yes', 'Off', 'TRUE', '~', 'null', 'Null',
  'a  b', ' lead', 'trail ', 'a #b', 'a:b', 'end:', 'say "hi"', "it's",
  'plain text', 'TODO',
  '- item', '-x', '? q', '?q', 'k: v', '{}', '[]', 'a,b',
];

const values = new Set();
for (const a of ALPHABET) {
  values.add(a);
  for (const b of ALPHABET) values.add(a + b);
}
for (const v of LONGER) values.add(v);

// Values with whitespace at either edge are a validation error, so they are not
// part of the parity contract; asserted separately below.
const list = [...values].filter(v => v === '' || v === v.trim());
const meta = {};
list.forEach((v, i) => { meta['k' + String(i).padStart(6, '0')] = v; });

const inv = {
  vlans: [],
  nodes: [{
    id: 'z', label: '', type: '', hostname: '', parent: '', note: '',
    meta, pluggables: [], src: 'sweep',
  }],
  links: [],
};

// WB_SWEEP_DIR keeps the generated file around, which is how you inspect a
// divergence instead of guessing at it.
const dir = process.env.WB_SWEEP_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sweep-'));
fs.mkdirSync(dir, { recursive: true });
const jsFile = path.join(dir, 'js.yaml');
fs.writeFileSync(jsFile, Core.serialize(inv));
console.log(`${list.length} candidate scalars`);

// --- oracle-free invariants: these need no Go at all ----------------------
let selfFail = 0;
for (const [k, v] of Object.entries(meta)) {
  const one = { vlans: [], nodes: [{ id: 'z', label: '', type: '', hostname: '', parent: '', note: '', meta: { [k]: v }, pluggables: [], src: 's' }], links: [] };
  let text;
  try { text = Core.serialize(one); } catch (e) { console.error(`  emit threw for ${JSON.stringify(v)}: ${e.message}`); selfFail++; continue; }
  let back;
  try { back = Core.parse(text); } catch (e) { console.error(`  will not reparse ${JSON.stringify(v)}: ${e.message}\n    ${JSON.stringify(text)}`); selfFail++; continue; }
  const got = back.nodes[0].meta ? back.nodes[0].meta[k] : undefined;
  if (got !== v) { console.error(`  round trip changed ${JSON.stringify(v)} -> ${JSON.stringify(got)}`); selfFail++; }
}
console.log(selfFail ? `${selfFail} self-consistency failures` : 'self-consistency: all values survive a JS round trip');

// Control characters must be REFUSED, not round-tripped, in both languages.
let ctlFail = 0;
for (const c of [0, 1, 7, 9, 10, 11, 27, 127, 133]) {
  const one = { vlans: [], nodes: [{ id: 'z', label: 'a' + String.fromCharCode(c) + 'b',
    type: '', hostname: '', parent: '', note: '', meta: null, pluggables: [], src: 's' }], links: [] };
  const errs = Core.validate(one).filter(p => !p.warn);
  if (!errs.some(e => e.msg.includes('control character'))) {
    console.error(`  0x${c.toString(16)} was not rejected`);
    ctlFail++;
  }
}
console.log(ctlFail ? `${ctlFail} control characters not rejected` : 'control characters: rejected as expected');

let wsFail = 0;
for (const v of [' a', 'a ', ' ', 'a\t']) {
  const one = { vlans: [], nodes: [{ id: 'z', label: v, type: '', hostname: '', parent: '',
    note: '', meta: null, pluggables: [], src: 's' }], links: [] };
  if (!Core.validate(one).some(p => !p.warn && p.msg.includes('whitespace'))) {
    console.error(`  ${JSON.stringify(v)} was not rejected`);
    wsFail++;
  }
}
console.log(wsFail ? `${wsFail} whitespace-edged values not rejected` : 'edge whitespace: rejected as expected');

// --- the real oracle: Go ---------------------------------------------------
let goOut;
try {
  goOut = execFileSync('go', ['run', './cmd/inv', 'fmt', jsFile], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, GOFLAGS: '-mod=mod', GOPROXY: 'off' },
  });
} catch (e) {
  console.error('go rejected the JS output entirely:\n' + String(e.stderr || e.message).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

let failures = selfFail + ctlFail + wsFail;

const jsOut = fs.readFileSync(jsFile, 'utf8');
if (jsOut === goOut) {
  console.log('emitter parity: byte-identical across every candidate');
} else {
  const a = jsOut.split('\n'), b = goOut.split('\n');
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) diffs.push({ line: i + 1, js: a[i], go: b[i] });
  }
  console.error(`\nemitter parity: ${diffs.length} DIVERGENCES`);
  for (const d of diffs.slice(0, 40)) {
    const key = (d.js || d.go || '').trim().split(':')[0];
    console.error(`  ${JSON.stringify(meta[key])}\n     js: ${JSON.stringify(d.js)}\n     go: ${JSON.stringify(d.go)}`);
  }
  if (diffs.length > 40) console.error(`  ... and ${diffs.length - 40} more`);
  failures++;
}

// --- structural parity ----------------------------------------------------
// The scalar sweep cannot reach these: key ordering, maps nested in sequences,
// empty collections, Date values, and fields whose emptiness is meaningful.
// Every one of these was a real divergence at some point.
const structural = {
  fields: [
    { id: 'zz_num', label: 'Zed', type: 'number', control: 'number', unit: 'W', enum: [],
      open: false, min: 0, max: 100, applies_to: ['node'], description: 'a number', parts: [], meta: null },
    { id: 'aa_enum', label: 'Ay', type: 'enum', control: 'combo', unit: '', enum: ['x', 'y'],
      open: true, min: null, max: null, applies_to: ['pluggable'], description: '', parts: [], meta: null },
    { id: 'mm_comp', label: 'Em', type: 'composite', control: 'composite', unit: '', enum: [],
      open: false, min: null, max: null, applies_to: ['node'], description: '',
      parts: [{ id: 'w', label: 'W', type: 'number', unit: 'mm' }, { id: 'h', label: 'H', type: 'number', unit: 'mm' }],
      meta: null },
  ],
  vlans: [{ id: 20, name: 'iot', subnet: '10.0.20.0/24', note: '', meta: null },
          { id: 3, name: 'mgmt', subnet: '', note: '', meta: null }],
  nodes: [
    { id: 'z/keys', label: '', type: '', hostname: '', parent: '', note: '',
      meta: { k10: 'a', k2: 'b', port10: 'c', port2: 'd', a1b: 'e', a10b: 'f' },
      pluggables: [], src: 's' },
    { id: 'z/empties', label: '', type: '', hostname: '', parent: '', note: '',
      meta: { emptyStr: '', emptyMap: {}, emptyList: [], nestedEmptyList: [[]], zero: 0, no: false },
      pluggables: [{ id: 'typeless', type: '', dir: '', connected_with: '', fanout: 0,
        mac: '', ips: [], untagged: 0, tagged: [], label: '', note: '', meta: null }], src: 's' },
    { id: 'z/nested', label: '', type: '', hostname: '', parent: '', note: '',
      meta: { psus: [{ watts: 750, bay: 1 }, { bay: 2, watts: 500 }] },
      pluggables: [], src: 's' },
    { id: 'z/vlans', label: '', type: '', hostname: '', parent: '', note: '',
      meta: null,
      pluggables: [{ id: 'p1', type: 'eth', dir: '', connected_with: '', fanout: 0,
        mac: 'aa:bb:cc:dd:ee:ff', ips: ['10.0.0.1', '10.0.0.2'], untagged: 3,
        tagged: [20, 3999], label: '', note: '', meta: null }], src: 's' },
  ],
  links: [],
};

fs.writeFileSync(path.join(dir, 'struct.yaml'), Core.serialize(structural));
let sOut;
try {
  sOut = execFileSync('go', ['run', './cmd/inv', 'fmt', path.join(dir, 'struct.yaml')], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, GOFLAGS: '-mod=mod', GOPROXY: 'off' },
  });
} catch (e) {
  console.error('structural parity: go rejected the output\n' +
    String(e.stderr || e.message).split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}
const sJs = fs.readFileSync(path.join(dir, 'struct.yaml'), 'utf8');
if (sJs === sOut) {
  console.log('structural parity: byte-identical');
} else {
  const x = sJs.split('\n'), y = sOut.split('\n');
  console.error('structural parity: DIVERGES');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) console.error(`  line ${i + 1}\n     js: ${JSON.stringify(x[i])}\n     go: ${JSON.stringify(y[i])}`);
  }
  process.exit(1);
}

// --- values that must be rejected, not silently dropped -------------------
let rejFail = 0;
const mustReject = [
  ['vlan out of range', { untagged: 9999 }, 'outside the valid range'],
  ['negative vlan', { tagged: [-7] }, 'outside the valid range'],
  ['empty ip entry', { ips: [''] }, 'empty entry in ips'],
  ['negative fanout', { fanout: -1 }, 'negative fanout'],
];
for (const [name, over, want] of mustReject) {
  const one = { vlans: [], nodes: [{ id: 'z', label: '', type: '', hostname: '', parent: '',
    note: '', meta: null, pluggables: [{ id: 'p', type: 'eth', dir: '', connected_with: '',
    fanout: 0, mac: '', ips: [], untagged: 0, tagged: [], label: '', note: '', meta: null,
    ...over }], src: 's' }], links: [] };
  if (!Core.validate(one).some(p => !p.warn && p.msg.includes(want))) {
    console.error(`  ${name}: not rejected`);
    rejFail++;
  }
}
console.log(rejFail ? `${rejFail} values not rejected` : 'out-of-range values: rejected as expected');
failures += rejFail;
process.exit(failures ? 1 : 0);
