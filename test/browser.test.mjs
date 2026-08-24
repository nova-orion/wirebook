// Real browser tests. Chromium, real layout, real event dispatch, real CSS.
//
//   npx playwright install chromium     (once)
//   node test/browser.test.mjs
//
// Why this exists, bluntly: the stub-DOM suite in ui.test.mjs passed while the
// shipped app was broken. It could not see that adding a meta field deleted
// itself, that panning the graph moved a sixth as far as the mouse, that tree
// rows read "cpu null", or that node links rendered in the UA stylesheet's
// unreadable default blue. None of those are logic bugs; they are layout,
// computed style, and event-ordering bugs, and only a browser can see them.
//
// Every test below is a regression for a defect that reached the user.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.yaml': 'text/yaml', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
};

// Serve the repo as-is. Not a build output: if index.html references something
// that is not in the tree, these tests 404 exactly like a browser would.
function serve() {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); pass++; results.push('  ok   ' + name); }
  catch (e) {
    fail++;
    results.push('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 6).join('\n       '));
  }
}

const { srv, port } = await serve();
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();

// A page with console/pageerror capture. Any uncaught exception or console.error
// during a test is a failure, whether or not the assertions noticed.
async function open({ deleteFS = true, hash = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
  if (deleteFS) {
    // Force the <input type=file> fallback so Playwright can drive Open. The FS
    // Access API is available on localhost and cannot be scripted.
    await page.addInitScript(() => {
      delete window.showOpenFilePicker;
      delete window.showSaveFilePicker;
    });
  }
  await page.goto(base + 'index.html' + hash);
  await page.waitForSelector('#nav .row');
  page.errs = errs;
  page.ctx = ctx;
  return page;
}
const noErrs = page => assert.equal(page.errs.join('\n'), '', 'page reported errors');

async function load(page, file = 'inventory.example.yaml') {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#bOpen'),
  ]);
  await chooser.setFiles(path.join(root, file));
  // Wait on the model, not the header. Waiting for the word "node" in #hStat let
  // "0 nodes" satisfy it before the file arrived, so tests that walked the
  // inventory passed over an empty one and proved nothing.
  await page.waitForFunction(() => S.loaded && S.inv.nodes.length > 0);
}

// Click a nav row by its visible label.
const nav = (page, label) => page.click(`#nav .row:has(.lbl:text-is("${label}"))`);

/* ------------------------------------------------------------------ boot --- */

await test('boots with no console errors and loads shipped settings', async () => {
  const page = await open();
  noErrs(page);
  const n = await page.evaluate(() => FIELDS.length);
  assert.ok(n > 50, 'field specs did not load, got ' + n);
  await page.ctx.close();
});

await test('every asset index.html references returns 200', async () => {
  const page = await open();
  const refs = await page.evaluate(() =>
    [...document.querySelectorAll('[src],[href]')]
      .map(e => e.getAttribute('src') || e.getAttribute('href'))
      .filter(u => u && !/^(https?:|\/\/|#|data:|blob:)/.test(u)));
  assert.ok(refs.length >= 2, 'expected local css and js references, saw ' + refs.length);
  for (const u of refs) {
    const r = await page.request.get(new URL(u, base).href);
    assert.equal(r.status(), 200, u + ' returned ' + r.status());
  }
  await page.ctx.close();
});

await test('the example inventory opens through the Open button', async () => {
  const page = await open();
  await load(page);
  noErrs(page);
  const stat = await page.textContent('#hStat');
  assert.match(stat, /\d+ nodes/, 'header did not report nodes: ' + stat);
  await page.ctx.close();
});

/* ------------------------------------------------------------ every view --- */

await test('every view renders in a real browser with no errors', async () => {
  const page = await open();
  await load(page);
  for (const v of ['Problems', 'Free ports', 'Cables', 'Tree', 'Graph', 'VLANs', 'YAML', 'Settings']) {
    await nav(page, v);
    await page.waitForSelector('#view h2');
    const h = await page.textContent('#view h2');
    assert.ok(h && h.trim().length, v + ' rendered no heading');
  }
  noErrs(page);
  await page.ctx.close();
});

await test('every node detail page renders with no errors', async () => {
  const page = await open();
  await load(page);
  const ids = await page.evaluate(() => S.inv.nodes.map(n => n.id));
  for (const id of ids) {
    await page.evaluate(i => { S.sel = { kind: 'node', id: i }; render(); }, id);
    const h = await page.textContent('#view h2');
    assert.ok(h && h.trim().length, 'node ' + id + ' rendered no heading');
  }
  noErrs(page);
  await page.ctx.close();
});

/* ------------------------------------------------- meta editor regressions - */
// The bug: touched() calls saveDraft() -> currentYaml(), which pruned empty meta
// values IN PLACE, so a field added as '' was deleted before the re-render drew
// its row. Every string, number and enum field in the picker did nothing.

const NODE = 'compute/srv-1';
// the meta picker is the select whose placeholder option is the add prompt
const PICKER = '#view select:has(option[value=""]:text-matches("add field"))';
const openNodeWithMeta = async page => {
  await page.evaluate(id => { S.sel = { kind: 'node', id }; render(); }, NODE);
  await page.waitForSelector(PICKER);
};

// The picker only offers fields that are NOT already set, so a test must ask it
// what is on the menu rather than hard-coding a field. Hard-coding "cpu" made
// selectOption wait forever for an option the app was right to omit.
// Runs in the page, so it must use plain CSS: :text-matches is a Playwright
// selector engine extension and querySelector rejects it outright.
const offered = page => page.evaluate(() => {
  const s = [...document.querySelectorAll('#view select')]
    .find(x => x.options[0] && /add field|all fields/.test(x.options[0].textContent));
  if (!s) throw new Error('no meta picker on screen');
  const out = {};
  for (const o of s.options) {
    if (!o.value) continue;
    const spec = FIELD_BY_ID.get(o.value);
    if (spec) out[o.value] = { type: spec.type, label: spec.label };
  }
  return out;
});

const firstOfType = (avail, type) => Object.keys(avail).find(id => avail[id].type === type);
const metaKeys = page => page.evaluate(id =>
  Object.keys((S.inv.nodes.find(n => n.id === id).meta) || {}), NODE);
const row = (page, key) => page.locator(`#view .metarow[data-key="${key}"]`);

await test('choosing a field from the picker adds a visible row', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);

  const avail = await offered(page);
  const id = firstOfType(avail, 'string');
  assert.ok(id, 'the picker offered no string field: ' + JSON.stringify(avail));
  const before = (await metaKeys(page)).length;

  await page.selectOption(PICKER, id);
  await row(page, id).waitFor({ timeout: 3000 });

  const keys = await metaKeys(page);
  assert.ok(keys.includes(id), `${id} was not kept in the model after adding it`);
  assert.equal(keys.length, before + 1, 'key count did not grow');
  // the row must be usable, not merely present
  assert.ok(await row(page, id).locator('input').count() > 0, 'the row has nothing to type into');
  noErrs(page);
  await page.ctx.close();
});

await test('every field type in the picker survives being added', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);

  // one representative of each control kind, so a single broken blankValue or
  // prune rule cannot hide behind a type that happens to work
  const avail = await offered(page);
  const targets = {};
  for (const type of ['string', 'number', 'integer', 'boolean', 'enum', 'text', 'composite']) {
    const id = firstOfType(avail, type);
    if (id) targets[type] = id;
  }
  assert.ok(Object.keys(targets).length >= 4,
    'too few field types offered to be a real check: ' + JSON.stringify(targets));

  for (const [type, id] of Object.entries(targets)) {
    await page.selectOption(PICKER, id);
    await row(page, id).waitFor({ timeout: 3000 }).catch(() => {});
    const keys = await metaKeys(page);
    assert.ok(keys.includes(id), `${type} field "${id}" vanished after being added`);
    assert.equal(await row(page, id).count(), 1, `${type} field "${id}" added no row`);
  }
  noErrs(page);
  await page.ctx.close();
});

await test('+ ad hoc key adds a row you can rename and fill', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);

  await page.click('#view button:text-is("+ ad hoc key")');
  await row(page, 'custom').waitFor({ timeout: 3000 });
  assert.ok((await metaKeys(page)).includes('custom'), 'ad hoc key not in the model');

  const r = row(page, 'custom');
  assert.ok(await r.locator('span.chip:text-is("ad hoc")').count() > 0, 'no ad hoc chip');
  const inputs = r.locator('input');
  assert.equal(await inputs.count(), 2, 'an ad hoc row needs a key box and a value box');

  // rename it, which is the whole point of an ad hoc key
  await inputs.first().fill('psu_note');
  await inputs.first().dispatchEvent('change');
  await row(page, 'psu_note').waitFor({ timeout: 3000 });
  assert.ok((await metaKeys(page)).includes('psu_note'), 'rename did not take');
  noErrs(page);
  await page.ctx.close();
});

await test('an unfilled placeholder is not written, a filled one is', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);
  const id = firstOfType(await offered(page), 'string');
  await page.selectOption(PICKER, id);
  await row(page, id).waitFor({ timeout: 3000 });

  let yaml = await page.evaluate(() => currentYaml());
  assert.ok(!new RegExp('^\\s*' + id + ':', 'm').test(yaml),
    `the empty placeholder "${id}" reached the file`);
  // ...and adding it must not drag its field spec in either
  assert.ok(!new RegExp('id: ' + id + '\\b').test(yaml),
    `a spec was embedded for unused field "${id}"`);

  const input = row(page, id).locator('input').first();
  await input.fill('WB-TEST');
  await input.dispatchEvent('change');
  await page.waitForTimeout(60);

  yaml = await page.evaluate(() => currentYaml());
  assert.match(yaml, new RegExp('^\\s*' + id + ': WB-TEST$', 'm'),
    'a filled field did not reach the file');
  await page.ctx.close();
});

await test('removing a field with x actually removes it', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);
  const id = firstOfType(await offered(page), 'string');
  await page.selectOption(PICKER, id);
  await row(page, id).waitFor({ timeout: 3000 });

  await row(page, id).locator('button:text-is("×")').click();
  await page.waitForTimeout(60);
  assert.ok(!(await metaKeys(page)).includes(id), 'x did not remove the key');
  assert.equal(await row(page, id).count(), 0, 'the row is still on screen');

  // and an existing, filled field must be removable too
  const existing = (await metaKeys(page))[0];
  await row(page, existing).locator('button:text-is("×")').click();
  await page.waitForTimeout(60);
  assert.ok(!(await metaKeys(page)).includes(existing), 'could not remove a filled field');
  noErrs(page);
  await page.ctx.close();
});

/* ---------------------------------------------- fresh load, no file -------- */
// These are the tests that were missing. "every view renders" loaded a file
// first, and the stub-DOM empty-inventory test only asserted that render() did
// not throw, never that anything was on screen. So a fresh visit to
// /#view/settings showing one line of prose went unnoticed: the only way to
// reach Settings was to create a node and navigate back.

await test('deep link to settings works with no inventory open', async () => {
  const page = await open({ hash: '#view/settings' });
  const text = await page.textContent('#view');
  assert.ok(!/Nothing to show here yet/.test(text),
    'settings is gated behind opening a file');
  // it must be the real thing: the shipped field specs and templates
  assert.ok(await page.locator('#view h3').count() >= 2, 'no settings sections rendered');
  assert.match(text, /fields \(\d+\)/, 'the fields table is missing');
  assert.match(text, /templates \(\d+\)/, 'the templates table is missing');
  assert.ok(await page.locator('#view tbody tr').count() > 20,
    'the fields table rendered no rows');
  noErrs(page);
  await page.ctx.close();
});

await test('clicking Settings in the nav works with no inventory open', async () => {
  const page = await open();
  await nav(page, 'Settings');
  assert.match(await page.textContent('#view'), /fields \(\d+\)/,
    'the nav route to settings is gated too');
  await page.ctx.close();
});

await test('a data view with no inventory still says which view it is', async () => {
  const page = await open();
  for (const [id, title] of [['problems', 'Problems'], ['free', 'Free ports'],
    ['cables', 'Cables'], ['tree', 'Tree'], ['graph', 'Graph'],
    ['vlans', 'VLANs'], ['yaml', 'YAML']]) {
    await page.evaluate(i => { S.sel = { kind: 'view', id: i }; render(); }, id);
    const h = await page.locator('#view h2').first().textContent().catch(() => '');
    assert.equal((h || '').trim(), title,
      `view "${id}" lost its heading when empty, so a bookmark looks broken`);
    // and the empty state has to offer a way out, not just describe the problem
    assert.ok(await page.locator('#view a').count() > 0,
      `view "${id}" gave the user nothing to click`);
  }
  noErrs(page);
  await page.ctx.close();
});

// A fourth test used to live here asserting only that #view was non-empty for
// every view. It passed against the broken build, because one line of prose is
// non-empty, so it was worse than no test: it reported coverage it did not have.
// Deleted rather than kept. The three above are checked to fail without the fix.

/* ------------------------------------------------- shipped field scope ----- */

await test('no shipped field points into another tool config', async () => {
  const page = await open();
  // These were shipped by mistake. Each one changes without the hardware
  // changing, which is the test for whether it belongs in wirebook at all.
  const banned = ['ansible_host', 'k8s_node', 'network_profile', 'ssid', 'credentials_ref'];
  const present = await page.evaluate(b => FIELDS.filter(f => b.includes(f.id)).map(f => f.id), banned);
  assert.deepEqual(present, [], 'config-pointer fields are back in the shipped settings');

  // and no template may seed one either
  const seeded = await page.evaluate(b => {
    const hits = [];
    for (const t of TPLS) for (const k of Object.keys((t.node && t.node.meta) || {})) {
      if (b.includes(k)) hits.push(t.id + '.' + k);
    }
    return hits;
  }, banned);
  assert.deepEqual(seeded, [], 'a template still fills in a config pointer');
  await page.ctx.close();
});

/* ------------------------------------------------- custom field notes ------ */

await test('a field you declare can carry a note, and it persists', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);

  // an ad hoc key, then declare it with a note
  await page.click('#view button:text-is("+ ad hoc key")');
  await row(page, 'custom').waitFor({ timeout: 3000 });
  await row(page, 'custom').locator('button:text-is("declare")').click();
  await page.waitForSelector('#dlgBody textarea');

  const NOTE = 'Which shelf the brick sits on. Fill in when the cable is short.';
  await page.fill('#dlgBody input >> nth=0', 'shelf_note');
  await page.fill('#dlgBody textarea', NOTE);
  await page.click('#dlgFoot button:text-is("Declare")');
  await page.waitForTimeout(80);

  const spec = await page.evaluate(() => {
    const f = FIELD_BY_ID.get('shelf_note');
    return f ? { desc: f.description, shipped: f.shipped } : null;
  });
  assert.ok(spec, 'the field was not declared');
  assert.equal(spec.desc, NOTE, 'the note was dropped');

  // it must reach the file, since a custom spec lives in the inventory
  const yaml = await page.evaluate(() => currentYaml());
  assert.match(yaml, /id: shelf_note/, 'the spec did not reach the inventory');
  assert.ok(yaml.includes(NOTE), 'the note did not reach the inventory');
  noErrs(page);
  await page.ctx.close();
});

await test('an existing custom field can be edited to add a note', async () => {
  const page = await open();
  await load(page);
  // declare one with no note at all
  await page.evaluate(() => {
    S.inv.fields = [...(S.inv.fields || []), {
      id: 'shelf_note', label: 'Shelf note', type: 'string', control: 'text',
      unit: '', enum: [], open: false, min: null, max: null,
      applies_to: ['node'], description: '', parts: [], shipped: false, builtin: false,
    }];
    refreshFields();
    S.sel = { kind: 'view', id: 'settings' };
    render();
  });

  const r = page.locator('#view tr:has(td:text-is("shelf_note"))');
  await r.waitFor({ timeout: 3000 });
  await r.locator('button:text-is("edit")').click();
  await page.waitForSelector('#dlgBody textarea');
  await page.fill('#dlgBody textarea', 'Added later.');
  await page.click('#dlgFoot button:text-is("Declare")');
  await page.waitForTimeout(80);

  const desc = await page.evaluate(() => (FIELD_BY_ID.get('shelf_note') || {}).description);
  assert.equal(desc, 'Added later.', 'editing an existing field did not save the note');
  noErrs(page);
  await page.ctx.close();
});

await test('the settings table shows a note column', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Settings');
  const heads = await page.locator('#view th').allTextContents();
  assert.ok(heads.includes('note'), 'no note column: ' + heads.join(','));
  await page.ctx.close();
});

/* ------------------------------ found by test/explore.mjs ------------------ */
// Every case below is a bug the exploratory crawler found by clicking things I
// had not thought to write a test for.

await test('copy falls back to a dialog when the clipboard is refused', async () => {
  const page = await open();
  await load(page);
  // deny it the way a non-secure context does
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => ({ writeText: () => Promise.reject(new Error('denied')) }),
    });
  });
  await nav(page, 'YAML');
  await page.click('#view button:text-is("copy")');
  await page.waitForTimeout(80);

  // it must not claim success, and must give the text to copy by hand
  const dlg = await page.textContent('#dlgBody');
  assert.match(dlg, /refused clipboard access/, 'no fallback offered: ' + dlg.slice(0, 120));
  const ta = page.locator('#dlgBody textarea');
  assert.equal(await ta.count(), 1, 'the text was not offered for manual copying');
  assert.match(await ta.inputValue(), /^nodes:/m, 'the fallback textarea is not the yaml');
  noErrs(page);   // and the rejection must not surface as an uncaught error
  await page.ctx.close();
});

await test('a port can be marked reserved from the editor', async () => {
  const page = await open();
  await load(page);
  await page.evaluate(() => {
    S.sel = { kind: 'node', id: 'compute/srv-1' };
    S.openPorts = new Set(['compute/srv-1:eth1']);
    render();
  });
  const inp = page.locator('#view .grid2 input').nth(0);
  await inp.waitFor({ timeout: 3000 });
  // find the reserved input by its label
  const res = page.locator('#view label:text-is("reserved for") + input');
  assert.equal(await res.count(), 1, 'there is no reserved control in the port editor');
  await res.fill('second NAS uplink');
  await res.dispatchEvent('change');
  await page.waitForTimeout(60);

  const yaml = await page.evaluate(() => currentYaml());
  assert.match(yaml, /reserved: second NAS uplink/, 'reserved did not reach the file');
  // and it must be visible without opening the detail row
  await page.evaluate(() => { S.openPorts = new Set(); render(); });
  assert.match(await page.textContent('#view'), /reserved/, 'reserved is invisible in the port list');
  await page.ctx.close();
});

await test('reserved is a string, and a boolean does not brick saving', async () => {
  const page = await open();
  await load(page);
  // reserved is the reason a port is kept free. Whatever ends up in it, the file
  // must still be saveable: an unsaveable document has no way out for the user.
  for (const v of ['why not', '', 'true']) {
    const err = await page.evaluate(val => {
      S.inv.nodes.find(n => n.pluggables.length).pluggables[0].reserved = val;
      try { currentYaml(); return null; } catch (e) { return String(e.message || e); }
    }, v);
    assert.equal(err, null, `reserved=${JSON.stringify(v)} made the document unsaveable: ${err}`);
  }
  await page.ctx.close();
});

await test('a cable can be marked planned from the editor', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Cables');
  const heads = await page.locator('#view th').allTextContents();
  assert.ok(heads.includes('planned'), 'no planned column: ' + heads.join(','));

  // the table is sorted by endpoint, so read which cable the first row IS rather
  // than assuming it is S.inv.links[0]
  const row0 = page.locator('#view tbody tr').first();
  const ref = (await row0.locator('td').first().textContent()).trim();
  assert.ok(ref.includes(':'), 'could not read the first row endpoint: ' + ref);

  await row0.locator('input[type=checkbox]').nth(1).check();
  await page.waitForTimeout(60);

  const got = await page.evaluate(r => {
    const l = S.inv.links.find(x => x.a === r || x.b === r);
    return { planned: !!(l && l.planned), occupied: Core.index(S.inv).usedBy.has(r) };
  }, ref);
  assert.equal(got.planned, true, 'planned did not take');
  assert.match(await page.evaluate(() => currentYaml()), /planned: true/, 'planned did not reach the file');
  // a planned cable must not occupy its ports: that is the whole point of it
  assert.equal(got.occupied, false, 'a planned cable still occupies its port');
  await page.ctx.close();
});

await test('every shipped template produces a valid node', async () => {
  const page = await open();
  await load(page);
  // A template that writes "48" into a volts field means the shipped templates
  // fail this repo's own validator the moment you use one.
  const bad = await page.evaluate(() => {
    const out = [];
    for (const t of TPLS) {
      const vars = {};
      for (const v of t.vars) vars[v.name] = v.default || '1';
      let node;
      try { node = Core.fromTemplate(t, vars, 'x.yaml', FIELD_BY_ID); }
      catch (e) { out.push(t.id + ': threw ' + e.message); continue; }
      if (!node.id || node.id.includes('{{')) { out.push(t.id + ': bad id ' + node.id); continue; }
      const probs = Core.validate({ ...Core.parse('nodes: []\n'), nodes: [node] }, FIELD_BY_ID)
        .filter(p => !p.warn);
      for (const p of probs) out.push(t.id + ': ' + p.msg);
    }
    return out;
  });
  assert.deepEqual(bad, [], 'shipped templates produce invalid inventory');
  await page.ctx.close();
});

await test('a self-parenting node does not hang the tree', async () => {
  const page = await open();
  // `nodes: {}` parses to one node whose id is '' and whose parent is ''. Because
  // '' is also the root sentinel it became its own child, and the tree recursed
  // until the stack blew. A four-character file was enough.
  for (const text of ['nodes: {}\n', 'nodes: [1,2]\n', 'nodes:\n  - {id: "", parent: ""}\n']) {
    const err = await page.evaluate(y => {
      try { ingest(y, 'bad.yaml'); } catch (e) { return 'ingest: ' + e.message; }
      try { S.sel = { kind: 'view', id: 'tree' }; render(); return null; }
      catch (e) { return 'render: ' + String(e.message).split('\n')[0]; }
    }, text);
    assert.equal(err, null, `${JSON.stringify(text)} broke the tree: ${err}`);
  }
  noErrs(page);
  await page.ctx.close();
});

await test('a node in a parent loop is listed, not silently dropped', async () => {
  const page = await open();
  await page.evaluate(() => {
    ingest('nodes:\n  - {id: a, parent: b}\n  - {id: b, parent: a}\n  - {id: c}\n', 'x.yaml');
    S.sel = { kind: 'view', id: 'tree' };
    render();
  });
  const text = await page.textContent('#view');
  assert.match(text, /not reachable from any root \(2\)/,
    'nodes in a parent loop vanished from the tree with no explanation');
  // and Problems must name the loop
  await page.evaluate(() => { S.sel = { kind: 'view', id: 'problems' }; render(); });
  assert.match(await page.textContent('#view'), /loop|cycle/i, 'Problems does not report the loop');
  noErrs(page);
  await page.ctx.close();
});

await test('the toolbar wraps instead of clipping the window', async () => {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(() => { delete window.showOpenFilePicker; });
  await page.goto(base + 'index.html');
  await page.waitForSelector('#nav .row');
  await page.evaluate(y => ingest(y, 'x.yaml'),
    fs.readFileSync(path.join(root, 'inventory.example.yaml'), 'utf8'));
  for (const v of ['problems', 'free', 'cables', 'tree', 'graph', 'vlans', 'yaml', 'settings']) {
    await page.evaluate(i => { S.sel = { kind: 'view', id: i }; render(); }, v);
    const over = await page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
    // body is overflow:hidden, so anything past the edge is unreachable, not scrollable
    assert.ok(over <= 4, `view ${v} clips ${over}px off the right edge at 420px wide`);
  }
  assert.deepEqual(errs, []);
  await ctx.close();
});

/* --------------------------------------------------------- readability ----- */

await test('tree never prints a literal null', async () => {
  const page = await open();
  await load(page);
  // give a node a null meta value, the state that produced "cpu null · ram null"
  await page.evaluate(() => {
    const n = S.inv.nodes.find(x => x.type === 'server');
    n.meta = { ...(n.meta || {}), cpu: null, ram: null };
    S.sel = { kind: 'view', id: 'tree' }; render();
  });
  const text = await page.textContent('#view');
  assert.ok(!/\bnull\b/.test(text), 'tree rendered a literal null:\n' + text.slice(0, 400));
  await page.ctx.close();
});

await test('links are legible, not the UA default blue', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Tree');
  const link = page.locator('#view a').first();
  assert.ok(await link.count() > 0, 'tree had no node links');
  const colour = await link.evaluate(e => getComputedStyle(e).color);
  // the UA default is rgb(0, 0, 238); anything near it is the bug
  const [r, g, b] = colour.match(/\d+/g).map(Number);
  assert.ok(!(r < 60 && g < 60 && b > 150), 'link is UA default blue: ' + colour);
  // and it must have real contrast against the page background
  const lum = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
  const bgL = 0.2126 * lum(0x14) + 0.7152 * lum(0x16) + 0.0722 * lum(0x1a);
  const ratio = (Math.max(L, bgL) + 0.05) / (Math.min(L, bgL) + 0.05);
  assert.ok(ratio >= 4.5, `link contrast is ${ratio.toFixed(2)}:1, need 4.5:1 (${colour})`);
  await page.ctx.close();
});

/* ------------------------------------------------------------- graph ------- */
// The bug: the viewBox was the content size while the element was 100% wide, so
// the browser fitted by height and centred the diagram, and the pan handler
// scaled mouse pixels by width/clientWidth. Dragging moved the graph a sixth as
// far as the pointer.

const gz = page => page.evaluate(() => ({ ...S.gz }));

await test('dragging the graph pans one-to-one with the pointer', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Graph');
  await page.waitForSelector('#view svg');

  const box = await page.locator('#view svg').boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 200, from.y + 60, { steps: 10 });
  await page.mouse.up();

  const z = await gz(page);
  assert.ok(Math.abs(z.tx - 200) <= 2, `dragged 200px, graph moved ${z.tx.toFixed(1)}`);
  assert.ok(Math.abs(z.ty - 60) <= 2, `dragged 60px down, graph moved ${z.ty.toFixed(1)}`);
  await page.ctx.close();
});

await test('the diagram starts at the left edge, not centred in blank space', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Graph');
  const svg = page.locator('#view svg');
  await svg.waitFor();
  const box = await svg.boundingBox();
  // the leftmost node box must sit near the left edge of the frame
  const rect = await page.locator('#view svg rect').first().boundingBox();
  const gap = rect.x - box.x;
  assert.ok(gap < 80, `first node is ${gap.toFixed(0)}px from the left edge; the diagram is being centred`);
  await page.ctx.close();
});

await test('a drag that starts on a node pans instead of opening it', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Graph');
  await page.waitForSelector('#view svg rect');

  const rect = await page.locator('#view svg rect').first().boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 120, rect.y + rect.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(60);

  const sel = await page.evaluate(() => ({ ...S.sel }));
  assert.equal(sel.id, 'graph', 'dragging from a node navigated away from the graph');
  const z = await gz(page);
  assert.ok(Math.abs(z.tx - 120) <= 2, 'the pan did not happen either, tx=' + z.tx);
  await page.ctx.close();
});

await test('a plain click on a node still opens it', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Graph');
  await page.waitForSelector('#view svg rect');
  await page.locator('#view svg rect').first().click();
  await page.waitForTimeout(60);
  const sel = await page.evaluate(() => ({ ...S.sel }));
  assert.equal(sel.kind, 'node', 'clicking a node did not open it, sel=' + JSON.stringify(sel));
  await page.ctx.close();
});

await test('ctrl+wheel zooms toward the pointer, not the origin', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Graph');
  const box = await page.locator('#view svg').boundingBox();
  // a point well away from the origin, where origin-anchored zoom is obvious
  const px = 400, py = 200;
  await page.mouse.move(box.x + px, box.y + py);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await page.waitForTimeout(60);

  const z = await gz(page);
  assert.ok(z.k > 1, 'ctrl+wheel did not zoom in, k=' + z.k);
  // the graph point that was under the cursor must still be under the cursor
  const stayed = Math.abs((px - z.tx) / z.k - px);
  assert.ok(stayed < 1, `the point under the cursor moved ${stayed.toFixed(1)} units`);
  await page.ctx.close();
});

await test('plain scroll does not get trapped by the graph', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Graph');
  const box = await page.locator('#view svg').boundingBox();
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(60);
  const z = await gz(page);
  assert.equal(z.k, 1, 'an unmodified scroll zoomed the graph');
  await page.ctx.close();
});

await test('fit scales an oversized diagram into the frame', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Graph');
  await page.click('#view button:text-is("fit")');
  const z = await gz(page);
  assert.ok(z.k > 0 && z.k <= 1, 'fit produced k=' + z.k);
  assert.equal(z.tx, 0); assert.equal(z.ty, 0);
  await page.ctx.close();
});

/* -------------------------------------------------------- navigation ------- */

await test('a deep link selects the view named in the url', async () => {
  const page = await open({ hash: '#view/free' });
  const sel = await page.evaluate(() => ({ ...S.sel }));
  assert.equal(sel.id, 'free', 'hash was ignored, sel=' + JSON.stringify(sel));
  await page.ctx.close();
});

await test('editing then undo restores the previous document', async () => {
  const page = await open();
  await load(page);
  const before = await page.evaluate(() => currentYaml());
  await openNodeWithMeta(page);
  const id = firstOfType(await offered(page), 'string');
  await page.selectOption(PICKER, id);
  await row(page, id).waitFor({ timeout: 3000 });
  const input = row(page, id).locator('input').first();
  await input.fill('WB-TEST');
  await input.dispatchEvent('change');
  await page.waitForTimeout(50);
  assert.notEqual(await page.evaluate(() => currentYaml()), before, 'the edit did not take');

  await page.click('#bUndo');
  await page.waitForTimeout(60);
  assert.equal(await page.evaluate(() => currentYaml()), before, 'undo did not restore the document');
  await page.ctx.close();
});

await test('a malformed file is refused with a message, not a crash', async () => {
  const page = await open();
  const bad = path.join(root, 'test', 'tmp-bad.yaml');
  fs.writeFileSync(bad, 'nodes:\n  - {id: a, bogus_key: 1}\n');
  try {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#bOpen')]);
    await chooser.setFiles(bad);
    await page.waitForTimeout(200);
    const loaded = await page.evaluate(() => S.loaded);
    assert.equal(loaded, false, 'an unknown key was accepted');
    // the user must be told, not left staring at an unchanged screen
    const shown = await page.evaluate(() =>
      (document.getElementById('dlg').textContent || '') +
      (document.getElementById('toast').textContent || '') +
      (document.getElementById('banner').textContent || ''));
    assert.ok(/bogus_key|could not|unknown|refus/i.test(shown),
      'nothing on screen explained the refusal: ' + JSON.stringify(shown.slice(0, 200)));
  } finally { fs.rmSync(bad, { force: true }); }
  await page.ctx.close();
});

await test('round tripping the example file changes not one byte', async () => {
  const page = await open();
  await load(page);
  const out = await page.evaluate(() => currentYaml());
  assert.equal(out, fs.readFileSync(path.join(root, 'inventory.example.yaml'), 'utf8'),
    'load then save altered the file');
  await page.ctx.close();
});

await browser.close();
srv.close();

console.log(results.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
