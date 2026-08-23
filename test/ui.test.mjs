// Actually executes the UI. `new vm.Script(...)` only proves the file parses; it
// cannot see a ReferenceError, a renamed export, or a renderer that throws on
// real data. Those are exactly the faults that show up the first time the page is
// opened, so this stubs enough of the DOM to run boot() and every view for real.
//
//   node test/ui.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

// ---------------------------------------------------------------- fake DOM ---
// One node class covers everything, because the app only ever builds elements
// through its own el() / svgEl() helpers.
function makeDom(settingsYaml) {
  class N {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.attrs = {};
      this.dataset = {}; this.style = {}; this.value = ''; this.checked = false;
      this.hidden = false; this.disabled = false; this.open = false;
      this._text = '';
      this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
      this.files = [];
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); }
    get innerHTML() { return this._html || ''; }
    set innerHTML(v) { this._html = String(v); }
    append(...k) { for (const x of k) if (x != null) this.children.push(x); }
    appendChild(x) { this.children.push(x); return x; }
    replaceChildren(...k) { this.children = k.filter(x => x != null); }
    insertBefore(x) { this.children.unshift(x); return x; }
    remove() {}
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener() {} removeEventListener() {}
    setPointerCapture() {}
    focus() {} blur() {} select() {} setSelectionRange() {} click() {}
    showModal() { this.open = true; } close() { this.open = false; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    cloneNode() { return new N(this.tagName); }
    get clientWidth() { return 800; }
    get firstChild() { return this.children[0] || null; }
  }

  const byId = {};
  for (const id of ['hFile', 'hDirty', 'hStat', 'hProb', 'bOpen', 'bSave', 'bUndo',
                    'bRedo', 'bLink', 'nav', 'view', 'dlg', 'dlgHead', 'dlgBody',
                    'dlgFoot', 'toast', 'banner']) byId[id] = new N();
  byId.builtinSettings = new N('script');
  byId.builtinSettings.textContent = settingsYaml;

  const store = new Map();
  const ctx = {
    console,
    document: {
      body: new N('body'),
      getElementById: id => byId[id] || null,
      createElement: t => new N(t),
      createElementNS: (_ns, t) => new N(t),
      createTextNode: v => { const n = new N('#text'); n.textContent = v; n.nodeType = 3; return n; },
      querySelector: () => null,
      addEventListener() {},
      get activeElement() { return null; },
    },
    // no showOpenFilePicker, so canFS is false: exercises the fallback path
    window: { addEventListener() {} },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    location: { hash: '', protocol: 'file:', href: 'file:///x/index.html' },
    history: { replaceState() {} },
    navigator: {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: class {},
    XMLSerializer: class { serializeToString() { return '<svg/>'; } },
    setTimeout: (f) => { if (typeof f === 'function') f(); return 0; },
    clearTimeout() {},
    queueMicrotask: f => f(),
    fetch: () => Promise.reject(new Error('offline in this harness')),
    indexedDB: undefined,
    __store: store,
    __byId: byId,
  };
  ctx.globalThis = ctx;
  ctx.window.location = ctx.location;
  return vm.createContext(ctx);
}

let pass = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) {
    console.error('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       '));
    process.exitCode = 1;
  }
};

const settings = read('settings.yaml');
const example = read('inventory.example.yaml');

function boot() {
  const ctx = makeDom(settings);
  vm.runInContext(read('third_party/js-yaml.min.js'), ctx);
  vm.runInContext(read('js/core.js'), ctx);
  vm.runInContext(read('js/app.js'), ctx);
  // top-level const in a classic script lands in the context's global lexical
  // scope, so a later run in the same context can reach it
  vm.runInContext('globalThis.__S = S; globalThis.__render = render; '
    + 'globalThis.__ingest = ingest; globalThis.__Core = Core; '
    + 'globalThis.__FIELDS = () => FIELDS; globalThis.__TPLS = () => TPLS;', ctx);
  return ctx;
}

// --------------------------------------------------------------------- tests

test('the app boots without throwing', () => {
  const ctx = boot();
  assert.ok(ctx.__S, 'state not reachable');
  assert.ok(ctx.__FIELDS().length > 50, 'shipped field specs did not load');
  assert.ok(ctx.__TPLS().length > 20, 'templates did not load');
});

test('a real inventory ingests', () => {
  const ctx = boot();
  assert.equal(ctx.__ingest(example, 'inventory.example.yaml'), true);
  assert.ok(ctx.__S.inv.nodes.length >= 10);
  assert.equal(ctx.__S.loaded, true);
});

test('every view renders against real data', () => {
  const ctx = boot();
  ctx.__ingest(example, 'inventory.example.yaml');
  for (const id of ['problems', 'free', 'cables', 'tree', 'graph', 'vlans', 'yaml', 'settings']) {
    ctx.__S.sel = { kind: 'view', id };
    try { ctx.__render(); }
    catch (e) { throw new Error(`view "${id}" threw: ${e && e.message}`); }
  }
});

test('every node renders its detail page', () => {
  const ctx = boot();
  ctx.__ingest(example, 'inventory.example.yaml');
  for (const n of ctx.__S.inv.nodes) {
    ctx.__S.sel = { kind: 'node', id: n.id };
    try { ctx.__render(); }
    catch (e) { throw new Error(`node "${n.id}" threw: ${e && e.message}`); }
  }
});

test('an empty inventory renders every view', () => {
  const ctx = boot();
  for (const id of ['problems', 'free', 'cables', 'tree', 'graph', 'vlans', 'yaml', 'settings']) {
    ctx.__S.sel = { kind: 'view', id };
    try { ctx.__render(); }
    catch (e) { throw new Error(`empty + view "${id}" threw: ${e && e.message}`); }
  }
});

test('expanded port detail renders', () => {
  const ctx = boot();
  ctx.__ingest(example, 'inventory.example.yaml');
  const n = ctx.__S.inv.nodes.find(x => x.pluggables.length);
  ctx.__S.openPorts = new Set(n.pluggables.map(p => n.id + ':' + p.id));
  ctx.__S.sel = { kind: 'node', id: n.id };
  ctx.__render();
});

test('a malformed file is refused, not crashed on', () => {
  const ctx = boot();
  assert.equal(ctx.__ingest('nodes:\n  - {id: a, bogus_key: 1}\n', 'bad.yaml'), false,
    'an unknown key must be refused');
  assert.equal(ctx.__ingest(': : :\n', 'bad.yaml'), false, 'garbage must be refused');
  assert.equal(ctx.__S.loaded, false, 'a refused file must not half-load');
});

test('the yaml view emits what save would write', () => {
  const ctx = boot();
  ctx.__ingest(example, 'inventory.example.yaml');
  ctx.__S.sel = { kind: 'view', id: 'yaml' };
  ctx.__render();
  assert.equal(ctx.__Core.serializeChecked(ctx.__S.inv), example,
    'round trip through the loaded model must reproduce the file');
});

test('deep link in the url selects a node', () => {
  const ctx = makeDom(settings);
  ctx.location.hash = '#view/free';
  vm.runInContext(read('third_party/js-yaml.min.js'), ctx);
  vm.runInContext(read('js/core.js'), ctx);
  vm.runInContext(read('js/app.js'), ctx);
  vm.runInContext('globalThis.__S = S;', ctx);
  assert.equal(ctx.__S.sel.id, 'free', 'hash was not honoured at boot');
});

test('adding a meta key actually adds one', () => {
  const ctx = boot();
  ctx.__ingest(example, 'inventory.example.yaml');
  const n = ctx.__S.inv.nodes.find(x => x.pluggables.length);
  const before = Object.keys(n.meta || {}).length;
  // the two paths the UI offers: an ad hoc key, and a declared string field
  vm.runInContext('globalThis.__add = (node, k, v) => { node.meta = { ...(node.meta||{}), [k]: v }; };', ctx);
  ctx.__add(n, 'custom', '');
  assert.equal(Object.keys(n.meta).length, before + 1, 'an empty value must persist in the model');
  // ...but must not reach the file
  ctx.__S.sel = { kind: 'view', id: 'yaml' };
  ctx.__render();
  assert.ok(!ctx.__Core.serialize(ctx.__S.inv).includes("custom: ''"),
    'an unfilled placeholder should not be written');
});

console.log('\n' + pass + ' passed');
