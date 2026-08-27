// Extracts the CORE block out of index.html and exercises it under node, so
// the browser logic is testable without a browser and without a build step.
//
//   node test/core.test.mjs
//
// The assertion that matters is byte parity with `inv fmt`. If that breaks,
// saving from the UI reformats the whole file and every diff becomes noise.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const rel = p => new URL(p, import.meta.url);
const html = fs.readFileSync(rel('../index.html'), 'utf8');
const coreSrc = fs.readFileSync(rel('../js/core.js'), 'utf8');
const appSrc = fs.readFileSync(rel('../js/app.js'), 'utf8');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(rel('../third_party/js-yaml.min.js'), 'utf8'), ctx);
vm.runInContext(coreSrc + '\nglobalThis.__Core = Core;', ctx);
const Core = ctx.__Core;

// A hermetic fixture, deliberately NOT the user's live inventory: coverage must
// not shrink when they delete a node, and their inventory must not have to be
// committed to a public repo for the suite to run.
// The shipped example, deliberately NOT the user's live inventory: coverage must
// not shrink when they delete a node, and a public repo must not need their real
// data committed for the suite to run. It doubles as documentation, so it is
// built to contain every construct the format has.
const real = () => fs.readFileSync(rel('../inventory.example.yaml'), 'utf8');

// Core lives in a vm realm, so its arrays have a different Array.prototype and
// deepStrictEqual rejects them outright. Copy across the boundary before comparing.
const arr = a => [...(a || [])];

let pass = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) {
    console.error('  FAIL ' + name + '\n       ' + String(e.message || e).split('\n').join('\n       '));
    process.exitCode = 1;
  }
};

test('the example exercises every construct', () => {
  const inv = Core.parse(real());
  assert.ok(inv.nodes.length >= 10, 'too few nodes to be a useful fixture');
  assert.ok(inv.vlans.length >= 2, 'needs vlans');
  assert.ok(inv.links.length >= 5, 'needs cables');
  // the constructs that have each broken at least once
  assert.ok(inv.nodes.some(n => n.hostname), 'needs a hostname');
  assert.ok(inv.nodes.some(n => n.parent && Core.index(inv).nodeById.get(n.parent).parent),
    'needs nesting at least 3 deep');
  const plugs = inv.nodes.flatMap(n => n.pluggables);
  assert.ok(plugs.some(p => p.mac), 'needs a mac');
  assert.ok(plugs.some(p => (p.ips || []).length), 'needs an ip');
  assert.ok(plugs.some(p => p.untagged && (p.tagged || []).length), 'needs a trunk port');
  assert.ok(plugs.some(p => p.fanout > 1), 'needs a fanout port');
  assert.ok(inv.links.some(l => l.poe), 'needs a poe link');
  assert.ok(inv.links.some(l => l.blocks.length), 'needs a blocks entry');
  assert.ok(plugs.some(p => p.type === 'sata'), 'needs a non-network cable');
  assert.ok(inv.nodes.some(n => n.meta && typeof n.meta.dimensions === 'object'),
    'needs a composite meta value');
});

test('serialize matches `inv fmt` byte-for-byte', () => {
  const golden = real();
  const out = Core.serialize(Core.parse(golden));
  if (out !== golden) {
    const a = golden.split('\n'), b = out.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        throw new Error(`first diff at line ${i + 1}\ngo: ${JSON.stringify(a[i])}\njs: ${JSON.stringify(b[i])}`);
      }
    }
  }
});

test('serialize is idempotent', () => {
  const once = Core.serialize(Core.parse(real()));
  assert.equal(Core.serialize(Core.parse(once)), once);
});

test('fingerprint survives a round trip', () => {
  const inv = Core.parse(real());
  assert.equal(Core.fingerprint(Core.parse(Core.serialize(inv))), Core.fingerprint(inv));
});

test('namespace defaults resolve like Go', () => {
  const inv = Core.parse([
    'defaults:',
    '  namespace: compute',
    '  parent: loc/office',
    'nodes:',
    '  - id: srv-1',
    '    pluggables:',
    '      - id: eth0',
    '        type: eth',
    '        connected_with: net/sw-1:p1',
    '  - id: disk-1',
    '    parent: srv-1',
  ].join('\n'));
  assert.equal(inv.nodes[0].id, 'compute/srv-1');
  assert.equal(inv.nodes[0].parent, 'loc/office');
  assert.equal(inv.nodes[0].pluggables[0].connected_with, 'net/sw-1:p1');
  assert.equal(inv.nodes[1].parent, 'compute/srv-1');
});

test('reciprocal connected_with collapses to one cable', () => {
  const inv = Core.parse([
    'nodes:',
    '  - id: a',
    '    pluggables: [{id: p, type: eth, connected_with: "b:p"}]',
    '  - id: b',
    '    pluggables: [{id: p, type: eth, connected_with: "a:p"}]',
  ].join('\n'));
  assert.equal(inv.links.length, 1);
});

test('errors are contradictions, warnings are incompleteness', () => {
  const inv = Core.parse([
    'nodes:',
    '  - id: a',
    '    parent: ghost',
    '    pluggables:',
    '      - {id: p1, type: power, dir: in}',
    '      - {id: p2, type: power, dir: in}',
    '      - {id: p3, type: eth}',
    'links:',
    '  - {a: "a:p1", b: "a:p2"}',
    '  - {a: "a:p3", b: "nope:x"}',
  ].join('\n'));
  const probs = Core.validate(inv);
  const errs = probs.filter(p => !p.warn).map(p => p.msg);
  const warns = probs.filter(p => p.warn).map(p => p.msg);
  assert.ok(errs.some(m => m.includes('both ends are dir')), 'dir clash must be an error');
  assert.ok(warns.some(m => m.includes('parent "ghost"')), 'missing parent must warn');
  assert.ok(warns.some(m => m.includes('nope:x')), 'missing port must warn');
});

test('cycles are errors, reported once', () => {
  const inv = Core.parse('nodes:\n  - {id: x, parent: y}\n  - {id: y, parent: x}\n');
  assert.equal(Core.validate(inv).filter(p => p.msg.startsWith('parent cycle')).length, 1);
});

test('deep nesting has no depth limit', () => {
  const n = 500;
  let y = 'nodes:\n';
  for (let i = 0; i < n; i++) y += '  - {id: n' + i + (i ? ', parent: n' + (i - 1) : '') + '}\n';
  const inv = Core.parse(y);
  assert.equal(inv.nodes.length, n);
  assert.equal(Core.validate(inv).length, 0, 'a 500-deep chain should be clean');
});

test('compatible() enforces type and opposite dir', () => {
  const eth = { type: 'eth', dir: '' };
  const pIn = { type: 'power', dir: 'in' }, pOut = { type: 'power', dir: 'out' };
  assert.ok(Core.compatible(eth, { type: 'eth', dir: '' }));
  assert.ok(Core.compatible(pIn, pOut));
  assert.ok(!Core.compatible(pIn, pIn));
  assert.ok(!Core.compatible(eth, pIn));
  assert.ok(!Core.compatible(eth, { type: 'eth', dir: 'in' }));
});

test('meta stays open and keeps number types', () => {
  const inv = Core.parse('nodes:\n  - id: a\n    meta: {volts: 12, anything: fine, nested: {deep: 1}}\n');
  assert.equal(inv.nodes[0].meta.volts, 12);
  assert.match(Core.serialize(inv), /volts: 12/);
});

test('vlan/fanout fixture matches `inv fmt` byte-for-byte', () => {
  const golden = fs.readFileSync(rel('fixtures/vlan.yaml'), 'utf8');
  const out = Core.serialize(Core.parse(golden));
  if (out !== golden) {
    const a = golden.split('\n'), b = out.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        throw new Error(`first diff at line ${i + 1}\ngo: ${JSON.stringify(a[i])}\njs: ${JSON.stringify(b[i])}`);
      }
    }
  }
});

test('vlans, hostname, mac, ips survive a round trip', () => {
  const inv = Core.parse(fs.readFileSync(rel('fixtures/vlan.yaml'), 'utf8'));
  assert.equal(inv.vlans.length, 2);
  const sw = inv.nodes.find(n => n.id === 'net/sw-1');
  assert.equal(sw.hostname, 'sw1.lan');
  const p1 = sw.pluggables.find(p => p.id === 'p1');
  assert.equal(p1.mac, 'aa:bb:cc:00:00:01');
  assert.deepEqual(arr(p1.ips), ['10.0.10.2']);
  assert.equal(p1.untagged, 10);
  assert.deepEqual(arr(p1.tagged), [20]);
  assert.equal(Core.fingerprint(Core.parse(Core.serialize(inv))), Core.fingerprint(inv));
});

test('fanout lets one outlet feed several devices', () => {
  const y = [
    'nodes:',
    '  - id: src',
    '    pluggables: [{id: o, type: power, dir: out, fanout: 3}]',
    '  - id: a',
    '    pluggables: [{id: p, type: power, dir: in, connected_with: "src:o"}]',
    '  - id: b',
    '    pluggables: [{id: p, type: power, dir: in, connected_with: "src:o"}]',
  ].join('\n');
  const inv = Core.parse(y);
  assert.equal(inv.links.length, 2);
  assert.equal(Core.validate(inv).filter(p => !p.warn).length, 0, 'fanout 3 permits 2 cables');
});

test('without fanout a second cable on one port is an error', () => {
  const y = [
    'nodes:',
    '  - id: src',
    '    pluggables: [{id: o, type: power, dir: out}]',
    '  - id: a',
    '    pluggables: [{id: p, type: power, dir: in, connected_with: "src:o"}]',
    '  - id: b',
    '    pluggables: [{id: p, type: power, dir: in, connected_with: "src:o"}]',
  ].join('\n');
  const errs = Core.validate(Core.parse(y)).filter(p => !p.warn);
  assert.ok(errs.some(e => e.msg.includes('carries 2 cables')), errs.map(e => e.msg).join('; '));
});

test('trunk vlan mismatch warns, and is only a warning', () => {
  const y = [
    'vlans: [{id: 10}, {id: 20}]',
    'nodes:',
    '  - id: sw',
    '    pluggables: [{id: p1, type: eth, untagged: 10, tagged: [20], connected_with: "srv:eth0"}]',
    '  - id: srv',
    '    pluggables: [{id: eth0, type: eth, untagged: 10}]',
  ].join('\n');
  const probs = Core.validate(Core.parse(y));
  assert.equal(probs.filter(p => !p.warn).length, 0, 'a config mismatch must not be fatal');
  assert.ok(probs.some(p => p.warn && p.msg.includes('tagged on')), probs.map(p => p.msg).join('; '));
});

test('a vlan both untagged and tagged on one port is an error', () => {
  const y = [
    'vlans: [{id: 10}]',
    'nodes:',
    '  - id: sw',
    '    pluggables: [{id: p1, type: eth, untagged: 10, tagged: [10]}]',
  ].join('\n');
  const errs = Core.validate(Core.parse(y)).filter(p => !p.warn);
  assert.ok(errs.some(e => e.msg.includes('both untagged and tagged')), errs.map(e => e.msg).join('; '));
});

// Field specs and the schema's documented meta properties must not drift: a
// field in one and not the other is either undiscoverable or unvalidated.
const settingsText = html.match(/id="builtinSettings">([\s\S]*?)<\/script>/)[1];

test('settings.yaml is embedded and parses', () => {
  const st = Core.parseSettings(settingsText);
  assert.ok(st.fields.length >= 60, `only ${st.fields.length} fields`);
  assert.ok(st.templates.length >= 15, `only ${st.templates.length} templates`);
});

test('embedded settings matches settings.yaml on disk', () => {
  const disk = Core.parseSettings(fs.readFileSync(rel('../settings.yaml'), 'utf8'));
  const embedded = Core.parseSettings(settingsText);
  assert.equal(Core.settingsDoc(embedded.fields, embedded.templates),
    Core.settingsDoc(disk.fields, disk.templates),
    'index.html embeds a stale copy of settings.yaml');
});

test('no location block in nginx.conf declares add_header', () => {
  // nginx inherits add_header from the enclosing level only when the current
  // level declares none of its own. One add_header in a location therefore
  // drops every server-level header for that location, silently, with no
  // warning on reload. A `location = /index.html` that set a cache header this
  // way served the page itself with no Content-Security-Policy.
  const conf = fs.readFileSync(rel('../deploy/nginx.conf'), 'utf8');
  const offenders = [];
  let loc = null, depth = 0;
  for (const raw of conf.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (/^location\b/.test(line)) { loc = line; depth = 0; }
    if (loc) {
      depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      if (/\badd_header\b/.test(line)) offenders.push(`${loc} -> ${line}`);
      if (depth <= 0 && /}/.test(line)) loc = null;
    }
  }
  assert.deepEqual(offenders, [], 'add_header inside a location drops the server-level headers');

  // and the headers that have to survive are in fact set
  for (const h of ['Cache-Control', 'Content-Security-Policy', 'X-Content-Type-Options']) {
    assert.ok(new RegExp('add_header ' + h + '\\b').test(conf), 'nginx.conf sets no ' + h);
  }
  // the assets carry no version in their names, so nothing else can bust them
  assert.ok(/add_header Cache-Control "no-cache"/.test(conf), 'assets are not revalidated');
});

test('field specs and the schema meta vocabulary agree', () => {
  const specIds = new Set(Core.parseSettings(settingsText).fields.map(f => f.id));
  const schemaText = fs.readFileSync(rel('../schema/inventory.yaml'), 'utf8');
  const doc = vm.runInContext('jsyaml.load(' + JSON.stringify(schemaText) + ')', ctx);
  const schemaKeys = new Set(Object.keys(doc.$defs.meta.properties));
  assert.deepEqual(arr([...schemaKeys].filter(k => !specIds.has(k)).sort()), [],
    'documented in the schema but has no field spec');
  assert.deepEqual(arr([...specIds].filter(k => !schemaKeys.has(k)).sort()), [],
    'has a field spec but is undocumented in the schema, so hand-editing gets no autocomplete');
});

test('every field spec is coherent', () => {
  for (const f of Core.parseSettings(settingsText).fields) {
    assert.match(f.id, /^[a-z][a-z0-9_]*$/, `bad id ${f.id}`);
    assert.ok(['string', 'number', 'integer', 'boolean', 'enum', 'composite'].includes(f.type), `${f.id}: ${f.type}`);
    assert.ok(['text', 'textarea', 'number', 'checkbox', 'select', 'combo', 'composite'].includes(f.control), `${f.id}: ${f.control}`);
    if (f.type === 'enum') assert.ok(f.enum.length, `${f.id} is an enum with no values`);
    if (f.type === 'composite') assert.ok(f.parts.length, `${f.id} is composite with no parts`);
    // a unit on a non-numeric field is almost always a mistake
    if (f.unit) assert.ok(['number', 'integer', 'composite'].includes(f.type), `${f.id} has unit ${f.unit} but type ${f.type}`);
  }
});

test('typed meta is checked against the specs', () => {
  const specs = new Map(Core.parseSettings(settingsText).fields.map(f => [f.id, f]));
  const inv = Core.parse([
    'nodes:',
    '  - id: a',
    '    meta: {watts: lots, cores: 1.5, label_printed: yes-please}',
    '    pluggables:',
    '      - {id: p, type: eth, meta: {duplex: sideways, speed: fast}}',
  ].join('\n'));
  const msgs = Core.validate(inv, specs).filter(p => !p.warn).map(p => p.msg);
  assert.ok(msgs.some(m => m.includes('watts') && m.includes('number')), msgs.join('; '));
  assert.ok(msgs.some(m => m.includes('cores') && m.includes('whole number')), msgs.join('; '));
  assert.ok(msgs.some(m => m.includes('duplex') && m.includes('not one of')), msgs.join('; '));
  assert.ok(msgs.some(m => m.includes('speed')), msgs.join('; '));
});

test('an undeclared meta key is legal, not an error', () => {
  const specs = new Map(Core.parseSettings(settingsText).fields.map(f => [f.id, f]));
  const inv = Core.parse('nodes:\n  - id: a\n    meta: {my_own_thing: whatever}\n');
  assert.equal(Core.validate(inv, specs).length, 0, 'meta must stay open');
});

test('composite values are checked but units stay on the spec', () => {
  const specs = new Map(Core.parseSettings(settingsText).fields.map(f => [f.id, f]));
  const good = Core.parse('nodes:\n  - id: a\n    meta:\n      dimensions: {w: 300, h: 45}\n');
  assert.equal(Core.validate(good, specs).filter(p => !p.warn).length, 0);
  const bad = Core.parse('nodes:\n  - id: a\n    meta:\n      dimensions: {w: 300, depth: 210}\n');
  assert.ok(Core.validate(bad, specs).some(p => !p.warn && p.msg.includes('part "depth"')));
  // the unit is metadata about the field, never part of the value
  assert.equal(specs.get('dimensions').parts.find(q => q.id === 'w').unit, 'mm');
  assert.equal(specs.get('speed').unit, 'gbps');
});

test('schema covers every first-class field the code reads', () => {
  const schemaText = fs.readFileSync(rel('../schema/inventory.yaml'), 'utf8');
  const doc = vm.runInContext('jsyaml.load(' + JSON.stringify(schemaText) + ')', ctx);
  for (const k of ['id', 'label', 'type', 'hostname', 'parent', 'note', 'meta', 'pluggables']) {
    assert.ok(doc.$defs.node.properties[k], `node.${k} missing from schema`);
  }
  for (const k of ['id', 'type', 'dir', 'connected_with', 'fanout', 'mac', 'ips', 'untagged', 'tagged', 'label', 'note', 'meta']) {
    assert.ok(doc.$defs.pluggable.properties[k], `pluggable.${k} missing from schema`);
  }
  for (const k of ['a', 'b', 'label', 'note', 'poe', 'blocks', 'meta']) {
    assert.ok(doc.$defs.link.properties[k], `link.${k} missing from schema`);
  }
  assert.ok(doc.properties.vlans, 'top-level vlans missing from schema');
});

test('the inventory is self-contained: settings.yaml can be lost', () => {
  const text = real();
  const inv = Core.parse(text);

  // no specs at all
  assert.equal(Core.validate(inv).filter(p => !p.warn).length, 0,
    'a valid inventory must stay valid with no field specs');
  assert.equal(Core.serialize(inv), text,
    'output must not depend on the specs; the meta key IS the field id');

  // and with them, byte-for-byte the same file
  const specs = new Map(Core.parseSettings(settingsText).fields.map(f => [f.id, f]));
  assert.equal(Core.serialize(inv), text);
  assert.equal(Core.validate(inv, specs).filter(p => !p.warn).length, 0);

  // every meta value survives without a spec to describe it
  const metas = inv.nodes.flatMap(n => [n.meta, ...n.pluggables.map(p => p.meta)]).filter(Boolean);
  assert.ok(metas.length >= 5, 'the example should carry meta to make this meaningful');
  const back = Core.parse(Core.serialize(inv));
  assert.equal(Core.fingerprint(back), Core.fingerprint(inv));
});

test('an inventory carrying its own field specs round-trips', () => {
  const src = [
    'fields:',
    '  - {id: my_w, label: My watts, type: number, unit: W, min: 0}',
    '  - {id: side, type: enum, enum: [front, rear]}',
    'nodes:',
    '  - {id: a, meta: {my_w: 42, side: front}}',
  ].join('\n');
  const inv = Core.parse(src);
  assert.equal(inv.fields.length, 2);
  assert.equal(inv.fields[0].unit, 'W');
  const out = Core.serialize(inv);
  assert.match(out, /^fields:/m, 'fields must be emitted first');
  assert.equal(Core.serialize(Core.parse(out)), out, 'not idempotent with fields');
  assert.equal(Core.fingerprint(Core.parse(out)), Core.fingerprint(inv));
});

test('embedded specs type-check the meta they describe', () => {
  const inv = Core.parse([
    'fields:',
    '  - {id: my_w, type: number, unit: W}',
    'nodes:',
    '  - {id: a, meta: {my_w: lots}}',
  ].join('\n'));
  const specs = new Map(inv.fields.map(f => [f.id, f]));
  const errs = Core.validate(inv, specs).filter(p => !p.warn).map(p => p.msg);
  assert.ok(errs.some(m => m.includes('my_w')), errs.join('; '));
});

test('a field spec is optional: losing it never loses the value', () => {
  const inv = Core.parse('nodes:\n  - {id: a, meta: {undeclared_thing: 7, another: hi}}\n');
  assert.equal(Core.validate(inv).length, 0, 'undeclared keys must not error');
  const out = Core.serialize(inv);
  assert.match(out, /undeclared_thing: 7/, 'the value is written with or without a spec');
  assert.match(out, /another: hi/);
  assert.equal(Core.serialize(Core.parse(out)), out, 'and it survives a round trip');
  assert.ok(!out.includes('fields:'), 'an undeclared key must not invent a spec');
});

// The UI code itself is not run here, but it is compiled, which catches the
// unbalanced-paren class of mistake without opening a browser.
test('app script compiles', () => {
  new vm.Script(appSrc);
});

test('core has no DOM dependency', () => {
  // The suite runs core.js in a bare vm with no document, so a stray DOM
  // reference would break the whole file. Assert it explicitly too.
  const code = coreSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .replace(/^\s*\/\/.*$/gm, '');           // line comments
  for (const bad of ['document.', 'window.', 'localStorage', 'navigator.', 'alert(']) {
    assert.ok(!code.includes(bad), `core.js must stay DOM-free, found ${bad}`);
  }
});

test('every asset is local, so file:// still works', () => {
  // Only things the page FETCHES. A hyperlink to the project on GitHub is not an
  // asset: nothing is loaded from it, so it cannot break opening this offline.
  const loads = [...html.matchAll(/<(script|link|img|iframe)\b[^>]*?(?:src|href)="([^"]+)"/g)]
    .map(m => m[2]);
  assert.ok(loads.length >= 4, `expected css + 3 scripts, found ${loads.length}`);
  for (const s of loads) {
    assert.ok(!/^(https?:)?\/\//.test(s), `${s} is remote; the app must work offline`);
  }
  // and no stylesheet or font smuggled in through an @import either
  assert.ok(!/@import\s+url\(\s*['"]?https?:/.test(html), 'remote @import breaks offline use');
  // ES modules are CORS-blocked over file://, so classic scripts only
  assert.ok(!/<script[^>]+type="module"/.test(html), 'no ES modules: they break file://');
});

test('every template placeholder is declared', () => {
  for (const t of Core.parseSettings(settingsText).templates) {
    const declared = new Set(t.vars.map(v => v.name));
    for (const u of Core.placeholdersIn(t.node)) {
      assert.ok(declared.has(u), `${t.id} uses {{${u}}} with no var`);
    }
  }
});

test('every template instantiates into a clean node', () => {
  for (const t of Core.parseSettings(settingsText).templates) {
    const vars = {};
    for (const v of t.vars) vars[v.name] = v.default || 'x';
    const node = Core.fromTemplate(t, vars, 'tpl');
    assert.ok(node.id, `${t.id} produced no id`);
    assert.ok(!node.id.includes('{{'), `${t.id} left a placeholder in its id`);
    const inv = { nodes: [node], links: [] };
    const errs = Core.validate(inv).filter(p => !p.warn);
    assert.equal(errs.length, 0, `${t.id}: ${errs.map(e => e.msg).join('; ')}`);
    assert.equal(Core.fingerprint(Core.parse(Core.serialize(inv))), Core.fingerprint(inv),
      `${t.id} does not survive a round trip`);
  }
});

test('toTemplate pulls a trailing number into {{n}}', () => {
  const node = {
    id: 'net/sw-flex-2', label: 'Flex 2', type: 'switch', parent: '', note: '', meta: null,
    pluggables: [{ id: 'p1', type: 'eth', dir: '', connected_with: '', label: '', note: '', meta: null }],
  };
  const t = Core.toTemplate(node, 'flex', 'net');
  assert.equal(t.node.id, 'net/sw-flex-{{n}}');
  assert.equal(t.vars[0].name, 'n');
  assert.equal(t.vars[0].default, '2');
});

test('templates survive an export/import round trip', () => {
  const list = Core.parseSettings(settingsText).templates;
  const back = Core.parseTemplates(Core.templatesDoc(list));
  assert.equal(back.length, list.length);
  assert.deepEqual(arr(back.map(t => t.id).sort()), arr(list.map(t => t.id).sort()));
});

// Awkward scalars, written out so the Go side can be diffed against it.
if (process.argv.includes('--emit-tricky')) {
  const meta = {};
  meta['k00'] = '1';
  meta['k01'] = '007';
  meta['k02'] = 'yes';
  meta['k03'] = 'no';
  meta['k04'] = 'on';
  meta['k05'] = 'off';
  meta['k06'] = 'true';
  meta['k07'] = 'null';
  meta['k08'] = '~';
  meta['k09'] = '';
  meta['k10'] = '3.5';
  meta['k11'] = '.inf';
  meta['k12'] = '.nan';
  meta['k13'] = '0x1f';
  meta['k14'] = '0b101';
  meta['k15'] = '0o17';
  meta['k16'] = '1_000';
  meta['k17'] = '2024-03-01';
  meta['k18'] = '2024-03';
  meta['k19'] = '12:30';
  meta['k20'] = '1:2:3';
  meta['k21'] = 'has: colon';
  meta['k22'] = 'trail ';
  meta['k23'] = '#hash';
  meta['k24'] = '-dash';
  meta['k25'] = '- dash';
  meta['k26'] = '-x';
  meta['k27'] = '?q';
  meta['k28'] = '? q';
  meta['k29'] = '*star';
  meta['k30'] = '&amp';
  meta['k31'] = '!bang';
  meta['k32'] = '|pipe';
  meta['k33'] = '>gt';
  meta['k34'] = '%pct';
  meta['k35'] = '@at';
  meta['k36'] = '`tick';
  meta['k37'] = '{brace}';
  meta['k38'] = '[brack]';
  meta['k39'] = ',comma';
  meta['k40'] = 'a #b';
  meta['k41'] = 'say "hi"';
  meta['k42'] = "it's";
  meta['k43'] = 'a:b';
  meta['k44'] = 'end:';
  meta['k45'] = 'plain text';
  meta['k46'] = 'TODO';
  const inv = { nodes: [{ id: 'z/tricky', label: '1', note: 'has: a colon and #hash',
    type: '', parent: '', meta, pluggables: [{ id: 'p1', type: 'eth', dir: '',
    connected_with: '', label: '2', note: 'say "hi"', meta: null }], src: 't' }], links: [] };
  fs.writeFileSync(process.env.TRICKY_OUT || '/tmp/tricky-js.yaml', Core.serialize(inv));
  console.log('wrote tricky doc with ' + Object.keys(meta).length + ' awkward values');
} else {
  console.log('\n' + pass + ' passed');
}
