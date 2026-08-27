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
  // the toolbar always exists; #nav has no rows until an inventory is open
  await page.waitForSelector('#menubar .tab');
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

// Views are tabs on the toolbar now, not rows in the sidebar; the sidebar holds
// nothing but the user's inventory. Settings is the gear on the right.
const nav = (page, label) => label === 'Settings'
  ? page.click('#menubar .tbtn.icon')
  : page.click(`#menubar .tab:text-is("${label}")`);
// and an inventory row, which is what the sidebar still has
const navNode = (page, label) => page.click(`#nav .row:has(.lbl:text-is("${label}"))`);

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
    await page.waitForTimeout(20);
    const h = await page.textContent('#nodeBody h2');
    assert.ok(h && h.trim().length, 'node ' + id + ' rendered no heading in the dialog');
  }
  noErrs(page);
  await page.ctx.close();
});

/* ------------------------------------------------- meta editor regressions - */
// The bug: touched() calls saveDraft() -> currentYaml(), which pruned empty meta
// values IN PLACE, so a field added as '' was deleted before the re-render drew
// its row. Every string, number and enum field in the picker did nothing.

const NODE = 'compute/srv-1';
// the meta picker is a filterable combo now, not a native select
const PICKER = '#nodeBody .metapick input';
// type the field id, then take the first match
const addField = async (page, id) => {
  const box = page.locator(PICKER);
  await box.click();
  await box.fill(id);
  // by value, not "the first match": typing "serial" also matches "Serial console"
  await page.locator(`#nodeBody .metapick .combomenu .opt[data-value="${id}"]`).click();
  await page.waitForTimeout(60);
};
const openNodeWithMeta = async page => {
  await page.evaluate(id => { S.sel = { kind: 'node', id }; render(); }, NODE);
  await page.waitForSelector(PICKER);   // the editor is a dialog now
};

// The picker only offers fields that are NOT already set, so a test must ask
// what is on the menu rather than hard-coding a field: hard-coding "cpu" waited
// forever for an option the app was right to omit.
const offered = page => page.evaluate(id => {
  const n = S.inv.nodes.find(x => x.id === id);
  const already = new Set(Object.keys((n && n.meta) || {}));
  const out = {};
  for (const f of FIELDS) {
    if (f.applies_to.length && !f.applies_to.includes('node')) continue;
    if (already.has(f.id)) continue;
    out[f.id] = { type: f.type, label: f.label };
  }
  return out;
}, NODE);

const firstOfType = (avail, type) => Object.keys(avail).find(id => avail[id].type === type);
const metaKeys = page => page.evaluate(id =>
  Object.keys((S.inv.nodes.find(n => n.id === id).meta) || {}), NODE);
const row = (page, key) => page.locator(`#nodeBody .metarow[data-key="${key}"]`);

await test('choosing a field from the picker adds a visible row', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);

  const avail = await offered(page);
  const id = firstOfType(avail, 'string');
  assert.ok(id, 'the picker offered no string field: ' + JSON.stringify(avail));
  const before = (await metaKeys(page)).length;

  await addField(page, id);
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
    await addField(page, id);
    await row(page, id).waitFor({ timeout: 3000 }).catch(() => {});
    const keys = await metaKeys(page);
    assert.ok(keys.includes(id), `${type} field "${id}" vanished after being added`);
    assert.equal(await row(page, id).count(), 1, `${type} field "${id}" added no row`);
  }
  noErrs(page);
  await page.ctx.close();
});

await test('the field picker filters as you type', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);

  const box = page.locator(PICKER);
  await box.click();
  const all = await page.locator('#nodeBody .metapick .combomenu .opt').count();
  assert.ok(all > 20, 'the picker is not offering the shipped fields, saw ' + all);

  await box.fill('volts');
  await page.waitForTimeout(60);
  const hits = await page.locator('#nodeBody .metapick .combomenu .opt').allTextContents();
  assert.ok(hits.length > 0 && hits.length < all, 'typing did not narrow the list');
  assert.ok(hits.every(h => /volt/i.test(h)), 'the filter kept unrelated fields: ' + hits.join(','));
  noErrs(page);
  await page.ctx.close();
});

await test('long dropdowns are filterable, short ones stay native', async () => {
  const page = await open();
  await load(page);
  // the parent picker lists every node, so it must be searchable
  await page.evaluate(() => { S.sel = { kind: 'node', id: 'compute/srv-1' }; render(); });
  const parent = page.locator('#nodeBody label:text-is("parent") + div .combo input');
  assert.equal(await parent.count(), 1, 'the parent picker is not a filterable combo');
  // dir has three options and is better off as a plain select
  await page.evaluate(() => {
    S.openPorts = new Set(['compute/srv-1:eth0']); render();
  });
  assert.ok(await page.locator('#nodeBody select').count() > 0, 'short lists should stay native selects');
  noErrs(page);
  await page.ctx.close();
});

await test('+ ad hoc key adds a row you can rename and fill', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);

  await page.click('#nodeBody button:text-is("+ ad hoc key")');
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
  await addField(page, id);
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
  await addField(page, id);
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

await test('the settings gear works with no inventory open', async () => {
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
  await page.click('#nodeBody button:text-is("+ ad hoc key")');
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
  // editing an existing field says Save, not Declare
  assert.equal(await page.textContent('#dlgHead'), 'Edit field');
  await page.fill('#dlgBody textarea', 'Added later.');
  await page.click('#dlgFoot button:text-is("Save")');
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
  // the control now sits in a wrapper div alongside its help line, so the
  // label's sibling is that div rather than the input itself
  const res = page.locator('#nodeBody label:text-is("reserved for") + div input');
  assert.equal(await res.count(), 1, 'there is no reserved control in the port editor');
  await res.fill('second NAS uplink');
  await res.dispatchEvent('change');
  await page.waitForTimeout(60);

  const yaml = await page.evaluate(() => currentYaml());
  assert.match(yaml, /reserved: second NAS uplink/, 'reserved did not reach the file');
  // and it must be visible without opening the detail row
  await page.evaluate(() => { S.openPorts = new Set(); render(); });
  assert.match(await page.textContent('#nodeBody'), /reserved/, 'reserved is invisible in the port list');
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

/* ------------------------------------------- more than one cable per port -- */
// The model always allowed it through `fanout`, but the editor did not: a full
// port offered no button, and fanout itself was hidden behind the "more" toggle,
// so plugging two small plugs into one universal socket was impossible without
// hand-editing the file.

await test('a full port offers to take another cable', async () => {
  const page = await open();
  await load(page);
  // compute/srv-1:eth0 is cabled to net/sw-1:p1 in the fixture
  await page.evaluate(() => { S.sel = { kind: 'node', id: 'compute/srv-1' }; render(); });
  const rowFull = page.locator('#nodeBody tr', { has: page.locator('input[value="eth0"]') });
  await rowFull.waitFor({ timeout: 3000 });

  const btn = rowFull.locator('button:text-is("+ another cable")');
  assert.equal(await btn.count(), 1, 'a full port offers no way to add a second cable');

  await btn.click();
  await page.waitForTimeout(80);

  // fanout is raised for us, and the picker opens
  assert.equal(await page.evaluate(() =>
    S.inv.nodes.find(n => n.id === 'compute/srv-1').pluggables.find(p => p.id === 'eth0').fanout), 2,
  'fanout was not raised');
  assert.equal(await page.evaluate(() => document.getElementById('dlg').open), true, 'no peer picker');

  // pick the first compatible target and confirm two cables really land
  const opts = page.locator('#dlgBody .opt');
  assert.ok(await opts.count() > 0, 'nothing compatible offered for the second cable');
  await opts.first().click();
  await page.waitForTimeout(80);

  const got = await page.evaluate(() => {
    const ix = Core.index(S.inv);
    return {
      cables: Core.cablesAt(ix, 'compute/srv-1:eth0').length,
      errs: Core.validate(S.inv, FIELD_BY_ID).filter(p => !p.warn).map(p => p.msg),
    };
  });
  assert.equal(got.cables, 2, 'the second cable did not attach to the same port');
  assert.deepEqual(got.errs, [], 'two cables on one port produced a validation error');
  assert.match(await page.evaluate(() => currentYaml()), /fanout: 2/, 'fanout did not reach the file');
  noErrs(page);
  await page.ctx.close();
});

await test('fanout is visible on the port row once set', async () => {
  const page = await open();
  await load(page);
  await page.evaluate(() => {
    const p = S.inv.nodes.find(n => n.id === 'compute/srv-1').pluggables.find(x => x.id === 'eth1');
    p.fanout = 3;
    S.sel = { kind: 'node', id: 'compute/srv-1' }; render();
  });
  assert.match(await page.textContent('#nodeBody'), /fanout 3/,
    'fanout is set but never shown, so it stays invisible behind the more toggle');
  await page.ctx.close();
});

await test('typing fanout immediately offers the extra connections', async () => {
  const page = await open();
  await load(page);
  // eth0 is already cabled, so at capacity 1 it offers no connect button
  await page.evaluate(() => {
    S.sel = { kind: 'node', id: 'compute/srv-1' };
    S.openPorts = new Set(['compute/srv-1:eth0']);
    render();
  });
  const rowSel = '#nodeBody tr:has(input[value="eth0"])';
  const buttons = () => page.locator(rowSel).first().locator('button').allTextContents();
  assert.ok(!(await buttons()).includes('connect'), 'a port at capacity should not offer connect');

  // raise fanout the way a user does, by typing in the box
  const fan = page.locator('#nodeBody label:text-is("fanout") + div input');
  await fan.fill('3');
  await fan.dispatchEvent('change');
  await page.waitForTimeout(120);

  // this is the bug: the model updated but the row never redrew, so the extra
  // capacity looked like it had not applied at all
  assert.ok((await buttons()).includes('connect'),
    'raising fanout did not bring back the connect button: ' + (await buttons()).join(','));
  assert.equal(await page.evaluate(() => {
    const ix = Core.index(S.inv);
    const n = S.inv.nodes.find(x => x.id === 'compute/srv-1');
    return Core.slotsLeft(ix, n.id, n.pluggables.find(p => p.id === 'eth0'));
  }), 2, 'capacity did not rise');
  noErrs(page);
  await page.ctx.close();
});

await test('a VLAN takes as many prefixes as it carries', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');
  await nav(page, 'VLANs');
  const headers = await page.locator('#view th').allTextContents();
  assert.ok(headers.includes('subnets'), 'no subnets column: ' + headers.join(','));

  // dual stack is normal, and one network routinely has a ULA and a GUA on top
  // of the v4 range, so a single string could never have expressed it
  const before = await page.evaluate(() => S.inv.vlans.find(v => v.id === 10).subnets.length);
  assert.ok(before >= 3, 'the demo should show a dual stack VLAN, got ' + before);

  const row = page.locator('#view tbody tr', { has: page.locator('input[value="10"]') }).first();
  await row.locator('button:text-is("+ prefix")').click();
  await page.waitForTimeout(60);

  // the empty row must NOT be in the model yet: pushing a placeholder into
  // subnets made the whole document unsaveable, because the parser drops empty
  // entries on read-back and the fingerprints then disagree
  assert.equal(await page.evaluate(() =>
    S.inv.vlans.find(v => v.id === 10).subnets.length), before,
  'the empty prefix row was written into the model');
  assert.doesNotThrow(() => {}, 'placeholder');
  const stillSaves = await page.evaluate(() => {
    try { currentYaml(); return true; } catch { return false; }
  });
  assert.equal(stillSaves, true, 'adding an empty prefix row made the document unsaveable');

  const box = row.locator('input[style*="190px"]').last();
  await box.fill('10.0.11.0/24');
  await box.dispatchEvent('change');
  await page.waitForTimeout(80);

  const after = await page.evaluate(() => S.inv.vlans.find(v => v.id === 10).subnets);
  assert.equal(after.length, before + 1, 'the extra prefix was not kept');
  assert.ok(after.includes('10.0.11.0/24'), 'the value was lost: ' + after.join(','));
  assert.match(await page.evaluate(() => currentYaml()), /10\.0\.11\.0\/24/, 'it did not reach the file');
  noErrs(page);
  await page.ctx.close();
});

await test('the old single subnet key still loads and is migrated', async () => {
  const page = await open();
  const got = await page.evaluate(() => {
    ingest('vlans:\n  - {id: 7, subnet: 10.0.7.0/24}\nnodes: []\n', 'old.yaml');
    return { subnets: S.inv.vlans[0].subnets, out: currentYaml() };
  });
  assert.deepEqual(got.subnets, ['10.0.7.0/24'], 'the old key was dropped');
  assert.match(got.out, /subnets:/, 'it should be written back in the list form');
  assert.ok(!/^\s*subnet:/m.test(got.out), 'the deprecated key should not be written back');
  noErrs(page);
  await page.ctx.close();
});

await test('a sublabel shows on a second line instead of truncating', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');
  await nav(page, 'Graph');
  await page.waitForSelector('#view svg g[data-node]');

  const box = await page.evaluate(() => {
    const g = document.querySelector('[data-node="power/strip"]');
    if (!g) return null;
    const t = [...g.querySelectorAll('text')].map(x => x.textContent.trim());
    return { texts: t, rect: +g.querySelector('rect').getAttribute('height') };
  });
  assert.ok(box, 'the strip is not drawn');
  assert.ok(box.texts.includes('Power strip'), 'label missing: ' + box.texts.join('|'));
  assert.ok(box.texts.includes('4 socket'), 'sublabel missing: ' + box.texts.join('|'));
  assert.ok(!box.texts.some(t => t.includes('\u2026')), 'something still truncates: ' + box.texts.join('|'));

  // the taller header must not push the cables through the wrong port row
  const off = await page.evaluate(() => {
    const g = document.querySelector('[data-node="power/strip"]');
    const dot = [...g.querySelectorAll('circle')][0];
    const label = [...g.querySelectorAll('text')].find(t => t.textContent.trim() === 'inlet');
    return Math.abs(+dot.getAttribute('cy') - (+label.getAttribute('y') - 3));
  });
  assert.ok(off <= 1, 'the socket dot is ' + off + 'px off its port row');
  noErrs(page);
  await page.ctx.close();
});

await test('tracing a video cable does not light the power chain', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');
  await nav(page, 'Graph');
  const r = await page.evaluate(() => {
    const ix = Core.index(S.inv);
    const links = S.inv.links.filter(l => ix.portByRef.has(l.a) && ix.portByRef.has(l.b));
    const AV = ['hdmi', 'dp', 'dvi', 'vga', 'audio'];
    const bucketsOf = l => {
      const p = ix.portByRef.get(l.a); const t = p ? p.port.type : '';
      const base = t === 'eth' ? 'eth' : t === 'power' ? 'power' : t === 'usb' ? 'usb'
        : AV.includes(t) ? 'av' : 'other';
      const out = new Set([base]); const says = l.meta && l.meta.carries;
      if (says === 'power') { out.add('power'); if (base !== 'power') out.delete(base); }
      if (says === 'both') out.add('power');
      if (l.poe) out.add('power');
      return out;
    };
    const go = ref => {
      const l = links.find(x => x.a === ref || x.b === ref);
      const c = tracedChain(links, { a: l.a, b: l.b }, ix, bucketsOf);
      return [...c.nodes].sort();
    };
    return { video: go('misc/dp-hdmi:out'), power: go('compute/server:psu') };
  });
  // upstream of a video cable is the video source, not the machine's mains feed
  assert.ok(!r.video.some(n => /wall|ups|strip/.test(n)),
    'a video trace wandered into the power chain: ' + r.video.join(', '));
  // and a power run still traces all the way back to the socket
  assert.ok(r.power.some(n => /wall/.test(n)),
    'a power trace stopped short of the wall: ' + r.power.join(', '));
  noErrs(page);
  await page.ctx.close();
});

await test('an inventory can be loaded from a URL', async () => {
  const page = await open();
  await page.click('#bUrl');
  await page.waitForSelector('#dlgBody input');
  await page.fill('#dlgBody input', base + 'inventory.demo.yaml');
  await page.click('#dlgFoot button:text-is("Load")');
  await page.waitForFunction(() => S.loaded && S.inv.nodes.length > 0);

  assert.match(await page.textContent('#hFile'), /from a URL/,
    'the header must say the copy came from a URL, since Save cannot write back');
  assert.match(await page.evaluate(() => location.href), /[?&]url=/,
    'the address should keep the url so a reload repeats it');

  // and the demo shortcut, which is what a first-time visitor clicks
  const p2 = await open();
  await p2.click('#view a:text-is("load the demo")');
  await p2.waitForFunction(() => S.loaded && S.inv.nodes.length > 0);
  assert.ok(await p2.evaluate(() => S.inv.nodes.length) >= 10, 'the demo did not load');
  noErrs(page);
  await page.ctx.close();
  await p2.ctx.close();
});

await test('a long hint collapses instead of burying the view', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Graph');
  // the help above the graph had grown to a third of the window
  const h = await page.evaluate(() => {
    const d = document.querySelector('#view details.hint');
    if (!d) return null;
    return { open: d.open, height: Math.round(d.getBoundingClientRect().height),
      summary: d.querySelector('summary').textContent.trim() };
  });
  assert.ok(h, 'the graph hint is not collapsible');
  assert.equal(h.open, false, 'it should start collapsed');
  assert.ok(h.height < 40, 'collapsed it still takes ' + h.height + 'px');
  assert.ok(h.summary.length < 40, 'the summary is itself a paragraph');
  noErrs(page);
  await page.ctx.close();
});

await test('a recorded cable colour shows in the table and the graph', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');

  await nav(page, 'Cables');
  const heads = await page.locator('#view th').allTextContents();
  assert.ok(heads.includes('colour'), 'colour is not a column: ' + heads.join(','));

  // the demo records one, and the graph must draw that cable in it
  const drawn = await page.evaluate(() => {
    S.sel = { kind: 'view', id: 'graph' }; render();
    const want = S.inv.links.find(l => l.meta && l.meta.colour);
    if (!want) return { none: true };
    const strokes = [...document.querySelectorAll('#view svg path[stroke]')]
      .map(p => p.getAttribute('stroke').toLowerCase());
    return { colour: want.meta.colour.toLowerCase(), strokes };
  });
  assert.ok(!drawn.none, 'the demo should record a cable colour');
  assert.ok(drawn.strokes.includes(drawn.colour),
    `no line drawn in ${drawn.colour}: ${[...new Set(drawn.strokes)].join(',')}`);

  // setting one from the table reaches the file
  await nav(page, 'Cables');
  const cell = page.locator('#view tbody tr').first().locator('input[placeholder^="blue"]');
  await cell.fill('rebeccapurple');
  await cell.dispatchEvent('change');
  await page.waitForTimeout(80);
  assert.match(await page.evaluate(() => currentYaml()), /colour: rebeccapurple/,
    'the colour did not reach the file');
  noErrs(page);
  await page.ctx.close();
});

await test('ctrl+z in a text box undoes the typing, not the document', async () => {
  const page = await open();
  await load(page);
  const before = await page.evaluate(() => currentYaml());

  await page.evaluate(() => { S.sel = { kind: 'node', id: 'compute/srv-1' }; render(); });
  const box = page.locator('#nodeBody label:text-is("label") + div input');
  await box.click();
  await box.type('xyz');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(80);

  // the document must be untouched: rolling it back mid-edit looks like the app
  // throwing your work away
  assert.equal(await page.evaluate(() => currentYaml()), before,
    'ctrl+z while typing rolled back the whole document');

  // outside a text box it still undoes properly
  await page.evaluate(() => { S.inv.nodes[0].label = 'changed'; touched(); });
  assert.notEqual(await page.evaluate(() => currentYaml()), before);
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => currentYaml()), before, 'undo stopped working entirely');
  noErrs(page);
  await page.ctx.close();
});

await test('the filter narrows every view, not just the sidebar', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');
  await page.evaluate(() => {
    // tag two things so there is something to select that type cannot express
    S.inv.nodes.find(n => n.id === 'power/ups').tags = ['battery-backed'];
    S.inv.nodes.find(n => n.id === 'power/strip').tags = ['battery-backed'];
    touched();
  });

  const counts = async q => {
    await page.evaluate(v => { S.navQ = v; render(); }, q);
    const o = {};
    await page.evaluate(() => { S.sel = { kind: 'view', id: 'tree' }; render(); });
    o.tree = await page.locator('#view .treerow').count();
    await page.evaluate(() => { S.sel = { kind: 'view', id: 'graph' }; render(); });
    o.graph = await page.locator('#view svg g[data-node]').count();
    await page.evaluate(() => { S.sel = { kind: 'view', id: 'free' }; render(); });
    o.free = await page.locator('#view tbody tr').count();
    await page.evaluate(() => { S.sel = { kind: 'view', id: 'cables' }; render(); });
    o.cables = await page.locator('#view tbody tr').count();
    o.note = (await page.locator('#view .filternote').count()) > 0;
    return o;
  };

  const all = await counts('');
  assert.equal(all.note, false, 'an unfiltered view should not claim to be filtered');

  // by type, which is the commonest thing you want and was impossible before
  const sw = await counts('switch');
  for (const k of ['tree', 'graph', 'free', 'cables']) {
    assert.ok(sw[k] < all[k], `${k} did not narrow for a type filter: ${sw[k]} of ${all[k]}`);
  }
  assert.equal(sw.note, true, 'a filtered view must say so, or you conclude things are missing');

  // by tag, which cuts across type
  const bat = await counts('battery-backed');
  assert.ok(bat.tree > 0 && bat.tree < all.tree, 'tag filter did not narrow the tree');
  assert.ok(bat.graph > 0 && bat.graph < all.graph, 'tag filter did not narrow the graph');

  // and clearing puts everything back
  await page.click('#view .filternote button');
  await page.waitForTimeout(60);
  assert.equal(await page.evaluate(() => S.navQ), '', 'clear did not clear');
  noErrs(page);
  await page.ctx.close();
});

await test('tags round trip and normalise', async () => {
  const page = await open();
  const got = await page.evaluate(() => {
    ingest('nodes:\n  - {id: a, tags: [Critical, critical, " NET ", ""]}\n', 'x.yaml');
    return { tags: S.inv.nodes[0].tags, out: currentYaml() };
  });
  // lowercased, deduped, sorted, blanks dropped: a diff must not depend on the
  // order they were typed
  assert.deepEqual(got.tags, ['critical', 'net'], 'tags were not normalised: ' + JSON.stringify(got.tags));
  assert.match(got.out, /tags:/, 'tags did not reach the file');
  noErrs(page);
  await page.ctx.close();
});

await test('the yaml view can be edited by hand', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');
  await nav(page, 'YAML');
  const before = await page.evaluate(() => currentYaml());

  // a real edit applies
  await page.evaluate(() => {
    const t = document.querySelector('#view textarea');
    t.value = t.value.replace('label: UPS', 'label: UPS renamed by hand');
  });
  await page.click('#view button:text-is("Apply")');
  await page.waitForTimeout(120);
  assert.match(await page.evaluate(() => currentYaml()), /UPS renamed by hand/, 'the edit did not apply');

  // a bad one is refused, and must not half-apply
  await nav(page, 'YAML');
  const nodesBefore = await page.evaluate(() => S.inv.nodes.length);
  await page.evaluate(() => {
    document.querySelector('#view textarea').value = 'nodes:\n  - {id: a, bogus_key: 1}\n';
  });
  await page.click('#view button:text-is("Apply")');
  await page.waitForTimeout(120);
  const shown = await page.evaluate(() => {
    const p = document.querySelector('#view .prob.e');
    return p && p.style.display !== 'none' ? p.textContent : '';
  });
  assert.match(shown, /bogus_key/, 'the refusal did not say what was wrong');
  assert.equal(await page.evaluate(() => S.inv.nodes.length), nodesBefore,
    'a refused apply changed the document anyway');

  // and an apply is undoable like any other edit
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => currentYaml()), before, 'ctrl+z did not undo the apply');
  noErrs(page);
  await page.ctx.close();
});

await test('cable labels show in the graph and can be turned off', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');
  await nav(page, 'Graph');
  const texts = () => page.evaluate(() =>
    [...document.querySelectorAll('#view svg text')].map(t => t.textContent));

  // what is written on a cable is the whole point of writing on it, and it was
  // only ever in the tooltip
  assert.ok((await texts()).includes('C13-A'), 'a cable label is not drawn');
  await page.click('#view button:text-is("labels")');
  await page.waitForTimeout(80);
  assert.ok(!(await texts()).includes('C13-A'), 'the toggle does not hide them');
  await page.click('#view button:text-is("labels")');
  await page.waitForTimeout(80);
  assert.ok((await texts()).includes('C13-A'), 'the toggle does not bring them back');
  noErrs(page);
  await page.ctx.close();
});

await test('the reason saving falls back to a download names the real cause', async () => {
  // deleteFS reproduces exactly what Brave does: a secure origin where the API
  // is simply absent. Telling that user to "use https" is wrong twice over,
  // since they are already on https and it will not help.
  const page = await open();
  const secure = await page.evaluate(() => window.isSecureContext);
  assert.ok(secure, 'the harness is not on a secure origin, so this proves nothing');

  const generic = await page.evaluate(() => whyNoFileWrite());
  assert.ok(!/secure origin/.test(generic), 'blames the origin on a secure origin: ' + generic);
  assert.ok(/File System Access API/.test(generic), 'does not say what is missing: ' + generic);

  const brave = await page.evaluate(() => {
    Object.defineProperty(navigator, 'brave', { value: {}, configurable: true });
    return whyNoFileWrite();
  });
  assert.ok(/brave:\/\/flags/.test(brave), 'does not tell a Brave user the fix: ' + brave);
  assert.ok(!/secure origin/.test(brave), 'still blames the origin: ' + brave);
  noErrs(page);
  await page.ctx.close();
});

await test('purpose and hostname show in every view, not just the graph', async () => {
  // Two nodes with the same name, told apart only by what they are for. This
  // is the shape that made moving purpose out of the label a regression: the
  // sublabel was drawn in the graph and nowhere else, so the tree and sidebar
  // showed the same word twice and said nothing. Invented names, not anyone's
  // real ones: fixtures in a public repo are published network documentation.
  const page = await open();
  await page.evaluate(y => ingest(y, 'x.yaml'), `nodes:
  - {id: sbc/one, label: Single board, sublabel: router duty, type: server, hostname: alpha.example}
  - {id: sbc/two, label: Single board, sublabel: secrets duty, type: server, hostname: beta.example}
`);
  const sidebar = await page.evaluate(() => [...document.querySelectorAll('nav .row')]
    .map(r => ({ text: r.textContent, title: r.getAttribute('title') })));
  for (const want of ['router duty', 'secrets duty']) {
    assert.ok(sidebar.some(r => r.text.includes(want)), `sidebar hides ${want}`);
  }
  // the sidebar ellipsises, so the row has to carry the whole of it on hover
  assert.ok(sidebar.some(r => /sbc\/one/.test(r.title || '') && /alpha\.example/.test(r.title)),
    'no sidebar tooltip with the id and hostname: ' + JSON.stringify(sidebar));

  await nav(page, 'Tree');
  const tree = await page.evaluate(() =>
    [...document.querySelectorAll('.treerow')].map(r => r.textContent));
  for (const want of ['router duty', 'secrets duty', 'alpha.example', 'beta.example']) {
    assert.ok(tree.some(t => t.includes(want)), `tree hides ${want}: ` + JSON.stringify(tree));
  }

  await nav(page, 'Graph');
  const graph = await page.evaluate(() =>
    [...document.querySelectorAll('#view svg text')].map(t => t.textContent));
  for (const want of ['router duty', 'secrets duty', 'alpha.example', 'beta.example']) {
    assert.ok(graph.includes(want), `graph hides ${want}: ` + JSON.stringify(graph));
  }
  // an extra identity line must make the box taller, not land on the line below
  const collide = await page.evaluate(() => {
    const ts = [...document.querySelectorAll('#view svg text')];
    return ts.some((t, i) => ts.slice(i + 1).some(o =>
      Math.abs(+o.getAttribute('y') - +t.getAttribute('y')) < 4
      && Math.abs(+o.getAttribute('x') - +t.getAttribute('x')) < 40));
  });
  assert.ok(!collide, 'two identity lines overlap in the graph');
  noErrs(page);
  await page.ctx.close();
});

await test('node tags can be shown in the graph and are off by default', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');
  await nav(page, 'Graph');
  // the tag line is the only text drawn in this colour
  const tagLines = () => page.evaluate(() =>
    [...document.querySelectorAll('#view svg text')]
      .filter(t => t.getAttribute('fill') === '#7f9ec9').map(t => t.textContent));

  assert.equal((await tagLines()).length, 0, 'tags are drawn before the toggle is used');
  await page.click('#view button:text-is("tags")');
  await page.waitForTimeout(80);
  const on = await tagLines();
  assert.ok(on.length > 0, 'the toggle does not draw any tags');
  assert.ok(on.some(t => t.includes('critical')), 'a known tag is missing: ' + JSON.stringify(on));
  // a third line in the header must push the port rows down, not land on them
  const collide = await page.evaluate(() => {
    const ts = [...document.querySelectorAll('#view svg text')];
    return ts.filter(t => t.getAttribute('fill') === '#7f9ec9').some(t => ts.some(o =>
      o !== t && Math.abs(+o.getAttribute('y') - +t.getAttribute('y')) < 4
      && Math.abs(+o.getAttribute('x') - +t.getAttribute('x')) < 40));
  });
  assert.ok(!collide, 'a tag line overlaps another label');
  await page.click('#view button:text-is("tags")');
  await page.waitForTimeout(80);
  assert.equal((await tagLines()).length, 0, 'the toggle does not hide them again');
  noErrs(page);
  await page.ctx.close();
});

await test('a label the graph had to cut carries the whole of it in a tooltip', async () => {
  const page = await open();
  await page.evaluate(y => ingest(y, 'long.yaml'), `nodes:
  - id: net/switch-with-a-very-long-identifier
    label: Netgear GS308EPP managed switch, ground floor
    sublabel: eight port, four of them power over ethernet
    type: switch
    tags: [a-fairly-long-tag, another-long-tag, third-long-tag]
    pluggables:
      - id: uplink-port-number-one
        label: uplink to the upstairs cupboard switch
        type: eth
        connected_with: net/other:p1
  - id: net/other
    label: Other
    type: switch
    pluggables:
      - {id: p1, type: eth}
`);
  await nav(page, 'Graph');
  await page.click('#view button:text-is("tags")');
  await page.waitForTimeout(80);
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll('#view svg text')]
      .filter(t => t.textContent.includes('…'))
      .map(t => ({
        shown: t.textContent,
        // the title has to be a sibling under a wrapping <g>: inside the <text>
        // it would show up in textContent and corrupt the label itself
        tip: t.parentNode.tagName === 'g'
          ? (t.parentNode.querySelector(':scope > title') || {}).textContent || null : null,
      })));
  assert.ok(cut.length >= 4, 'expected the long name, sublabel, tags and port to be cut, got '
    + JSON.stringify(cut));
  for (const c of cut) {
    assert.ok(c.tip, 'no tooltip on the cut label ' + JSON.stringify(c.shown));
    assert.ok(c.tip.startsWith(c.shown.slice(0, -1)),
      'the tooltip does not carry the label it belongs to: ' + JSON.stringify(c));
  }
  noErrs(page);
  await page.ctx.close();
});

await test('the filter applies without leaving the view', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');
  await nav(page, 'Graph');
  const boxes = () => page.locator('#view svg g[data-node]').count();
  const before = await boxes();

  // typing in the filter used to repaint only the sidebar, so the graph kept
  // showing the old set until you switched away and back
  await page.fill('#nav input', 'switch');
  await page.waitForTimeout(200);
  assert.ok(await boxes() < before, `the graph did not narrow: ${await boxes()} of ${before}`);
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#nav input')),
    true, 'the caret left the filter box, so you cannot keep typing');
  noErrs(page);
  await page.ctx.close();
});

await test('the colour picker offers colours already used', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');
  await nav(page, 'Cables');
  assert.ok(await page.locator('#view input[type=color]').count() > 0, 'no colour picker');

  const opts = await page.evaluate(() => {
    const dl = document.getElementById('cablecolours');
    return dl ? [...dl.querySelectorAll('option')].map(o => o.value) : null;
  });
  assert.ok(opts && opts.length > 0, 'no suggestions from colours already in the file');

  // the picker must not write into cables that have no colour: type=color always
  // has a value, so reading it at render time would stamp #000000 everywhere
  const painted = await page.evaluate(() => S.inv.links.filter(l => l.meta && l.meta.colour).length);
  await page.waitForTimeout(60);
  assert.equal(await page.evaluate(() => S.inv.links.filter(l => l.meta && l.meta.colour).length),
    painted, 'rendering the picker coloured cables that had no colour');
  noErrs(page);
  await page.ctx.close();
});

/* ------------------------------------------------------ tree editing ------- */

const treeRow = (page, id) => page.locator(`#view [data-node-id="${id}"]`);
const parentOf = (page, id) => page.evaluate(i =>
  (S.inv.nodes.find(n => n.id === i) || {}).parent, id);

// Playwright cannot drive HTML5 drag and drop, so the events are dispatched with
// a shared DataTransfer, which is what the browser itself does.
const dragRow = (page, fromId, toSel) => page.evaluate(({ from, to }) => {
  const src = document.querySelector(`[data-node-id="${from}"]`);
  const dst = document.querySelector(to);
  if (!src || !dst) throw new Error('missing ' + (src ? to : from));
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
}, { from: fromId, to: toSel });

await test('dragging a tree row onto another re-parents it', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Tree');
  await treeRow(page, 'net/sw-1').waitFor({ timeout: 3000 });

  assert.notEqual(await parentOf(page, 'net/sw-1'), 'compute/srv-1');
  await dragRow(page, 'net/sw-1', '[data-node-id="compute/srv-1"]');
  await page.waitForTimeout(80);
  assert.equal(await parentOf(page, 'net/sw-1'), 'compute/srv-1', 'the drop did not re-parent');

  // and it must survive a save
  assert.match(await page.evaluate(() => currentYaml()), /parent: compute\/srv-1/);
  noErrs(page);
  await page.ctx.close();
});

await test('a drop that would make a loop is refused', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Tree');
  await treeRow(page, 'compute/disk-1').waitFor({ timeout: 3000 });

  // disk-1's parent is srv-1, so dropping srv-1 onto disk-1 would make srv-1 its
  // own descendant, which strands both of them
  const before = await parentOf(page, 'compute/srv-1');
  await dragRow(page, 'compute/srv-1', '[data-node-id="compute/disk-1"]');
  await page.waitForTimeout(80);
  assert.equal(await parentOf(page, 'compute/srv-1'), before, 'a cycle-making drop was accepted');

  // and onto itself
  await dragRow(page, 'compute/srv-1', '[data-node-id="compute/srv-1"]');
  await page.waitForTimeout(80);
  assert.equal(await parentOf(page, 'compute/srv-1'), before, 'a node was dropped onto itself');
  noErrs(page);
  await page.ctx.close();
});

await test('dropping on the strip moves a node to the top level', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Tree');
  await treeRow(page, 'compute/disk-1').waitFor({ timeout: 3000 });
  assert.ok(await parentOf(page, 'compute/disk-1'), 'fixture has no nested node to un-nest');

  await dragRow(page, 'compute/disk-1', '.droproot');
  await page.waitForTimeout(80);
  assert.equal(await parentOf(page, 'compute/disk-1'), '', 'the node was not moved to the top level');
  noErrs(page);
  await page.ctx.close();
});

await test('tree rows highlight and tie their buttons to the row', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Tree');
  const row = treeRow(page, 'compute/srv-1');
  await row.waitFor({ timeout: 3000 });

  // the buttons used to sit at the far right of a wide window with nothing
  // connecting them to the row they act on
  const geom = await page.evaluate(() => {
    const r = document.querySelector('[data-node-id="compute/srv-1"]');
    const t = r.querySelector('.treetools');
    return {
      rowRight: Math.round(r.getBoundingClientRect().right),
      toolsRight: Math.round(t.getBoundingClientRect().right),
      toolsLeft: Math.round(t.getBoundingClientRect().left),
      textRight: Math.round(Math.max(...[...r.children]
        .filter(c => !c.classList.contains('treetools'))
        .map(c => c.getBoundingClientRect().right))),
      paneRight: Math.round(document.querySelector('section').getBoundingClientRect().right),
      before: getComputedStyle(r).backgroundColor,
    };
  });
  assert.ok(geom.paneRight - geom.toolsRight > 100,
    'the row tools still run to the far edge of the pane');
  // and they sit right after the row's own text, not in a lane of their own
  assert.ok(geom.toolsLeft - geom.textRight < 40,
    `the tools are ${geom.toolsLeft - geom.textRight}px adrift of the row content`);

  await row.hover();
  await page.waitForTimeout(60);
  const after = await page.evaluate(() =>
    getComputedStyle(document.querySelector('[data-node-id="compute/srv-1"]')).backgroundColor);
  assert.notEqual(after, geom.before, 'the row does not highlight on hover');
  noErrs(page);
  await page.ctx.close();
});

await test('deleting from the tree warns what else goes, then removes it', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Tree');
  await treeRow(page, 'compute/srv-1').waitFor({ timeout: 3000 });

  const before = await page.evaluate(() => S.inv.links.length);
  await treeRow(page, 'compute/srv-1').locator('button:text-is("×")').click();
  await page.waitForTimeout(80);

  // it must say what is lost before doing anything
  const warn = await page.textContent('#dlgBody');
  assert.match(warn, /port/, 'the warning does not mention the ports: ' + warn);
  assert.match(warn, /cable/, 'the warning does not mention the cables');
  assert.match(warn, /child|move/, 'the warning does not say what happens to children');
  assert.equal(await page.evaluate(() => !!S.inv.nodes.find(n => n.id === 'compute/srv-1')), true,
    'the node was deleted before the confirmation');

  await page.click('#dlgFoot button:text-is("Delete")');
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => !!S.inv.nodes.find(n => n.id === 'compute/srv-1')), false,
    'the node was not deleted');
  assert.ok(await page.evaluate(() => S.inv.links.length) < before, 'its cables were left dangling');
  // the child moves up rather than disappearing with the parent
  assert.equal(await page.evaluate(() => !!S.inv.nodes.find(n => n.id === 'compute/disk-1')), true,
    'a child was deleted along with its parent');
  noErrs(page);
  await page.ctx.close();
});

await test('opening a node keeps the view behind it and can edit in place', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Tree');
  await treeRow(page, 'compute/srv-1').waitFor({ timeout: 3000 });
  await treeRow(page, 'compute/srv-1').locator('a').click();
  await page.waitForTimeout(120);

  // it is the FULL editor, not a read-only summary: there is one node editor
  assert.equal(await page.evaluate(() => document.getElementById('nodeDlg').open), true, 'no dialog');
  const dlg = await page.textContent('#nodeBody');
  assert.match(dlg, /compute\/srv-1/, 'the dialog does not identify the node');
  assert.equal(await page.locator('#nodeBody input[value="eth0"]').count(), 1,
    'the dialog does not list the ports');
  assert.ok(await page.locator('#nodeBody .metapick input').count() > 0, 'no meta editor in the dialog');
  assert.ok(await page.locator('#nodeBody label:text-is("parent")').count() > 0, 'no parent picker');

  // the view you were reading is still underneath, and the URL still addresses
  // the node so a deep link and the back button keep working
  assert.equal(await page.evaluate(() => S.lastView), 'tree', 'the tree was replaced rather than kept');
  assert.match(await page.evaluate(() => location.hash), /#node\/compute\/srv-1/, 'the url lost the node');

  // an edit made in the dialog sticks, and the dialog stays open
  const lab = page.locator('#nodeBody label:text-is("label") + div input');
  await lab.fill('Edited in the dialog');
  await lab.dispatchEvent('change');
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() =>
    S.inv.nodes.find(n => n.id === 'compute/srv-1').label), 'Edited in the dialog', 'the edit was lost');
  assert.equal(await page.evaluate(() => document.getElementById('nodeDlg').open), true,
    'the dialog closed on the first edit');

  // closing puts you back where you were
  await page.click('#nodeFoot button:text-is("Done")');
  await page.waitForTimeout(120);
  assert.deepEqual(await page.evaluate(() => ({ ...S.sel })), { kind: 'view', id: 'tree' },
    'closing did not restore the view');
  noErrs(page);
  await page.ctx.close();
});

/* ------------------------------------------------ sidebar structure -------- */
// It used to be one flat list in which app views, the user's inventory and the
// buttons that create things all had identical weight, and namespace groups from
// the user's own ids sat at the same level as the chrome headings.

await test('the sidebar holds inventory only, chrome is on the toolbar', async () => {
  const page = await open();
  await load(page);
  const shape = await page.evaluate(() => ({
    navText: (document.getElementById('nav').textContent || ''),
    subs: document.querySelectorAll('#nav h5').length,
    navBtns: document.querySelectorAll('#nav .navbtn').length,
    // an action must never look like a node in the list above it
    actionRows: [...document.querySelectorAll('#nav .row')]
      .filter(r => /^\+/.test((r.textContent || '').trim())).length,
    tabs: [...document.querySelectorAll('#menubar .tab')].map(t => t.textContent.trim()),
    addBtns: [...document.querySelectorAll('#menubar .tgroup .tbtn')].map(b => b.textContent.trim()),
    gear: document.querySelectorAll('#menubar .tbtn.icon').length,
    menus: document.querySelectorAll('#menubar .drop').length,
  }));

  // a node called "View" with a child "Problems" used to be indistinguishable
  // from the application's own navigation, because both lived in this list
  for (const v of ['Problems', 'Free ports', 'Cables', 'Graph', 'VLANs', 'YAML']) {
    assert.ok(!shape.navText.includes(v), `"${v}" is still in the sidebar`);
  }
  assert.equal(shape.actionRows, 0, 'a create action is still rendered as a plain nav row');
  assert.ok(shape.subs > 0, 'namespace groups are not sub-headings');
  assert.ok(shape.navBtns >= 3, 'the sidebar create buttons are gone');

  // everything on the toolbar is visible, not hidden behind a menu
  assert.equal(shape.menus, 0, 'the toolbar still has dropdown menus');
  assert.ok(shape.tabs.length >= 7, 'views are not tabs: ' + shape.tabs.join(','));
  assert.deepEqual(shape.addBtns, ['+Node', '+Location', '+Template'],
    'add and template are not visible buttons: ' + shape.addBtns.join(','));
  assert.equal(shape.gear, 1, 'no gear for settings');
  noErrs(page);
  await page.ctx.close();
});

/* ------------------------------------------------ contextual help ---------- */
// All the guidance used to sit in one paragraph at the top of a view, so every
// individual control was unexplained: nothing said that "unit" wants a symbol or
// what "composite" does.

await test('every labelled control carries its own help', async () => {
  const page = await open();
  await load(page);
  const places = [
    ['node detail', () => { S.sel = { kind: 'node', id: 'compute/srv-1' }; render(); }],
    ['port detail', () => {
      S.sel = { kind: 'node', id: 'compute/srv-1' };
      S.openPorts = new Set(['compute/srv-1:eth0']);
      render();
    }],
  ];
  for (const [where, fn] of places) {
    await page.evaluate(f => eval('(' + f + ')')(), fn.toString());
    const rows = await page.evaluate(() => {
      const out = [];
      for (const lab of document.querySelectorAll('#nodeBody .grid2 > label')) {
        const control = lab.nextElementSibling;
        out.push({
          label: (lab.textContent || '').trim(),
          tip: (lab.getAttribute('title') || '').trim().length,
          inline: control ? control.querySelectorAll('.subhelp').length : 0,
        });
      }
      return out;
    });
    assert.ok(rows.length >= 5, `${where}: expected several rows, saw ${rows.length}`);
    const bare = rows.filter(r => !r.tip && !r.inline).map(r => r.label);
    assert.deepEqual(bare, [], `${where}: these controls have no help at all: ${bare.join(', ')}`);
  }
  noErrs(page);
  await page.ctx.close();
});

await test('the declare dialog explains each box and previews the control', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);
  await page.click('#nodeBody button:text-is("+ ad hoc key")');
  await row(page, 'custom').waitFor({ timeout: 3000 });
  await row(page, 'custom').locator('button:text-is("declare")').click();
  await page.waitForSelector('#dlgBody .grid2');

  const helps = await page.evaluate(() =>
    [...document.querySelectorAll('#dlgBody .grid2 > label')].map(l => ({
      label: (l.textContent || '').trim(),
      help: (l.nextElementSibling
        && l.nextElementSibling.querySelector('.subhelp')
        && l.nextElementSibling.querySelector('.subhelp').textContent || '').trim(),
    })));
  assert.ok(helps.length >= 6, 'expected a row per property, saw ' + helps.length);
  for (const h of helps) assert.ok(h.help.length > 20, `"${h.label}" has no explanation`);
  // the unit row must say it wants a symbol, which is what a "1" in there means
  const unit = helps.find(h => h.label === 'unit');
  assert.match(unit.help, /symbol|V, W/, 'unit does not explain what it wants: ' + unit.help);
  // and a live preview of the control being defined
  assert.match(await page.textContent('#dlgBody'), /preview/, 'no preview of the control');
  noErrs(page);
  await page.ctx.close();
});

await test('a composite field cannot be declared with no parts', async () => {
  const page = await open();
  await load(page);
  await openNodeWithMeta(page);
  await page.click('#nodeBody button:text-is("+ ad hoc key")');
  await row(page, 'custom').waitFor({ timeout: 3000 });
  await row(page, 'custom').locator('button:text-is("declare")').click();
  await page.waitForSelector('#dlgBody .grid2');

  await page.fill('#dlgBody .grid2 input >> nth=0', 'box_size');
  await page.selectOption('#dlgBody select >> nth=0', 'composite');
  await page.waitForTimeout(60);

  // it must say so inline, and refuse by disabling the button. Raising the
  // problem after the click is not an option: alertDlg replaces #dlgBody, which
  // destroyed everything the user had typed.
  assert.match(await page.textContent('#dlgBody'), /needs at least one part/,
    'no inline warning that a partless composite renders nothing');
  const btn = page.locator('#dlgFoot button:text-is("Declare")');
  assert.equal(await btn.isDisabled(), true, 'Declare is clickable with no parts');

  // adding a part must enable it, keep the form intact, and save the part
  await page.click('#dlgBody button:text-is("+ part")');
  const partId = page.locator('#dlgBody input[placeholder^="id, e.g."]').first();
  await partId.fill('w');
  await partId.dispatchEvent('change');
  await page.waitForTimeout(60);

  assert.equal(await page.locator('#dlgBody .grid2 input').first().inputValue(), 'box_size',
    'the form lost what was typed');
  assert.equal(await btn.isDisabled(), false, 'Declare still disabled after adding a part');
  await btn.click();
  await page.waitForTimeout(80);

  const spec = await page.evaluate(() => {
    const f = FIELD_BY_ID.get('box_size');
    return f ? { parts: f.parts.map(q => q.id), control: f.control } : null;
  });
  assert.ok(spec, 'the composite was not declared after adding a part');
  assert.deepEqual(spec.parts, ['w'], 'the part was not saved');
  assert.equal(spec.control, 'composite');
  // and the control must now actually render an input
  const rendered = await page.evaluate(() => {
    const n = S.inv.nodes.find(x => x.id === 'compute/srv-1');
    n.meta = { ...(n.meta || {}), box_size: {} };
    S.sel = { kind: 'node', id: n.id }; render();
    const r = document.querySelector('#nodeBody .metarow[data-key="box_size"]');
    return r ? r.querySelectorAll('input').length : -1;
  });
  assert.ok(rendered > 0, 'the declared composite renders no input at all');
  noErrs(page);
  await page.ctx.close();
});

await test('the wall outlet template makes a usable power source', async () => {
  const page = await open();
  await load(page);
  const got = await page.evaluate(() => {
    const t = TPLS.find(x => x.id === 'wall-outlet');
    if (!t) return { missing: true };
    const vars = {};
    for (const v of t.vars) vars[v.name] = v.default || '1';
    const n = Core.fromTemplate(t, vars, 'x.yaml', FIELD_BY_ID);
    return {
      id: n.id, type: n.type,
      outs: n.pluggables.filter(p => p.dir === 'out').length,
      ins: n.pluggables.filter(p => p.dir === 'in').length,
      circuit: n.meta && n.meta.circuit,
    };
  });
  assert.ok(!got.missing, 'there is no wall-outlet template');
  assert.equal(got.ins, 0, 'a wall socket is a source: it must have no inlet');
  assert.ok(got.outs >= 2, 'a double socket needs two pluggables so one can block the other');
  assert.ok(got.circuit, 'no circuit placeholder to record the breaker');
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
  // the toolbar always exists; #nav has no rows until an inventory is open
  await page.waitForSelector('#menubar .tab');
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

await test('the graph draws a child inside its parent', async () => {
  const page = await open();
  await load(page);
  // compute/disk-1 has parent compute/srv-1 in the shipped example, and a guest
  // is added here because virtual nodes used to be dropped from the graph
  // entirely, which is precisely where nesting matters most.
  await page.evaluate(() => {
    S.inv.nodes.push({
      id: 'compute/vm-1', label: 'Guest', type: 'vm', virtual: true,
      parent: 'compute/srv-1', hostname: '', note: '', meta: null, pluggables: [],
    });
    S.sel = { kind: 'view', id: 'graph' };
    render();
  });

  const boxes = await page.evaluate(() => {
    const out = {};
    for (const g of document.querySelectorAll('#view svg g[data-node]')) {
      const t = g.querySelector('text');
      const r = g.querySelector('rect');
      if (!t || !r) continue;
      out[(t.textContent || '').trim()] = {
        x: +r.getAttribute('x'), y: +r.getAttribute('y'),
        w: +r.getAttribute('width'), h: +r.getAttribute('height'),
        dashed: !!r.getAttribute('stroke-dasharray'),
      };
    }
    return out;
  });
  const parent = boxes['Mini PC'], disk = boxes['SSD'], guest = boxes['Guest'];
  assert.ok(parent, 'no parent box: ' + Object.keys(boxes).join(','));
  assert.ok(disk, 'the child drive is not drawn: ' + Object.keys(boxes).join(','));
  assert.ok(guest, 'a virtual guest is still missing from the graph');

  for (const [name, kid] of [['drive', disk], ['guest', guest]]) {
    assert.ok(kid.x > parent.x && kid.x + kid.w <= parent.x + parent.w + 0.5,
      `${name} is not horizontally inside its parent`);
    assert.ok(kid.y > parent.y && kid.y + kid.h <= parent.y + parent.h + 0.5,
      `${name} is not vertically inside its parent: ${JSON.stringify(kid)} vs ${JSON.stringify(parent)}`);
    assert.ok(kid.w < parent.w, `${name} is not inset, so nesting is invisible`);
  }
  assert.equal(guest.dashed, true, 'a guest should be dashed: it has no sockets');
  noErrs(page);
  await page.ctx.close();
});

await test('a parent loop does not hang or hide nodes in the graph', async () => {
  const page = await open();
  const err = await page.evaluate(() => {
    ingest('nodes:\n  - {id: a, parent: b}\n  - {id: b, parent: a}\n', 'x.yaml');
    try { S.sel = { kind: 'view', id: 'graph' }; render(); } catch (e) { return String(e.message); }
    return null;
  });
  assert.equal(err, null, 'a parent loop broke the graph: ' + err);
  const rects = await page.evaluate(() =>
    document.querySelectorAll('#view svg g[data-node] rect').length);
  assert.ok(rects >= 2, 'nodes in a parent loop vanished from the graph');
  noErrs(page);
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

await test('single click selects a node, double click opens it', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Graph');
  await page.waitForSelector('#view svg rect');

  // one click must NOT navigate: a stray click used to throw you out of the
  // diagram you were reading
  const box = page.locator('#view svg g[data-node="net/sw-1"]');
  await box.waitFor({ timeout: 3000 });
  await box.click({ position: { x: 20, y: 8 } });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => S.sel.id), 'graph', 'a single click navigated away');
  assert.equal(await page.evaluate(() => S.gpick), 'net/sw-1', 'a single click selected nothing');

  // and it highlights what that node is wired to, one hop
  const lit = await page.evaluate(() => {
    const ix = Core.index(S.inv);
    const live = S.inv.links.filter(l => ix.portByRef.has(l.a) && ix.portByRef.has(l.b));
    const c = neighbourhood(live, 'net/sw-1', ix);
    return { cables: c.links.size, nodes: c.nodes.size, total: S.inv.nodes.length };
  });
  assert.ok(lit.cables > 0, 'the selected node highlighted no cables');
  assert.ok(lit.nodes < lit.total, 'selecting a node lit up the entire diagram');

  // double click opens it
  await box.dblclick({ position: { x: 20, y: 8 } });
  await page.waitForTimeout(80);
  const sel = await page.evaluate(() => ({ ...S.sel }));
  assert.equal(sel.kind, 'node', 'double click did not open the node, sel=' + JSON.stringify(sel));
  noErrs(page);
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

await test('the browser back button walks back through the app', async () => {
  const page = await open();
  await load(page);
  await nav(page, 'Tree');
  await nav(page, 'Cables');
  await page.evaluate(() => { S.sel = { kind: 'node', id: 'compute/srv-1' }; render(); });
  await page.waitForTimeout(60);
  assert.equal(await page.evaluate(() => S.sel.id), 'compute/srv-1');

  await page.goBack();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => S.sel.id), 'cables', 'back did not return to the previous view');

  await page.goBack();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => S.sel.id), 'tree', 'back only worked once');

  await page.goForward();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => S.sel.id), 'cables', 'forward does not work');
  noErrs(page);
  await page.ctx.close();
});

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
  await addField(page, id);
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

await test('the demo inventory loads, renders and shows what it advertises', async () => {
  const page = await open();
  await load(page, 'inventory.demo.yaml');

  // it ships to users as the thing to poke at, so every view has to work
  for (const v of ['Problems', 'Free ports', 'Cables', 'Tree', 'Graph', 'VLANs', 'YAML', 'Settings']) {
    await nav(page, v);
    assert.ok((await page.textContent('#view')).trim().length > 50, v + ' rendered almost nothing');
  }

  // and it must demonstrate the things the README says it does
  await nav(page, 'Free ports');
  const free = await page.textContent('#view');
  assert.match(free, /1 of 2 free/, 'the fanout socket does not show a spare slot');
  assert.match(free, /blocked/i, 'no blocked outlet');
  assert.match(free, /reserved/i, 'no reserved port');

  const facts = await page.evaluate(() => ({
    planned: S.inv.links.filter(l => l.planned).length,
    poe: S.inv.links.filter(l => l.poe).length,
    carries: S.inv.links.filter(l => l.meta && l.meta.carries).length,
    virtual: S.inv.nodes.filter(n => n.virtual).length,
    nested: S.inv.nodes.filter(n => {
      const p = S.inv.nodes.find(x => x.id === n.parent);
      return p && p.type !== 'location';
    }).length,
    warns: Core.validate(S.inv, FIELD_BY_ID).filter(p => p.warn).length,
    errs: Core.validate(S.inv, FIELD_BY_ID).filter(p => !p.warn).length,
  }));
  assert.ok(facts.planned >= 1, 'no planned cable');
  assert.ok(facts.poe >= 1, 'no PoE run');
  assert.ok(facts.carries >= 1, 'nothing marked with what it carries');
  assert.ok(facts.virtual >= 1, 'no virtual guest');
  assert.ok(facts.nested >= 2, 'nothing nested inside a machine');
  assert.equal(facts.errs, 0, 'the demo must not ship with errors');
  assert.equal(facts.warns, 1, 'the demo should carry exactly the one deliberate warning');

  // the chain layout is the default and must actually lay out in steps
  await nav(page, 'Graph');
  const cols = await page.evaluate(() =>
    [...document.querySelectorAll('#view svg text')].map(t => t.textContent)
      .filter(t => /^(SOURCES|STEP )/.test(t)).length);
  assert.ok(cols >= 3, 'the chain layout produced ' + cols + ' columns');
  const boxes = await page.evaluate(() =>
    document.querySelectorAll('#view svg rect[stroke-dasharray="6 4"]').length);
  assert.ok(boxes >= 2, 'locations are not drawn as boundaries');

  assert.equal(await page.evaluate(() => currentYaml()),
    fs.readFileSync(path.join(root, 'inventory.demo.yaml'), 'utf8'),
    'the demo does not round trip');
  noErrs(page);
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
