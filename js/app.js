/* ------------------------------------------------------------------ app --- */
const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};

const LS_KEY = 'wirebook:draft';

// A FileSystemFileHandle is structured-cloneable, so it survives in IndexedDB.
// Permission does NOT survive, so on the next load the handle is inert until the
// user re-grants it with a click. That is the whole reason for the reconnect
// banner rather than a silent restore.
const IDB_NAME = 'wirebook';
const IDB_STORE = 'handles';

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { return reject(e); }
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(IDB_STORE, mode);
        const out = fn(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => { db.close(); resolve(out && out.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      } catch (e) { db.close(); reject(e); }
    };
  });
}
const rememberHandle = h => idb('readwrite', st => st.put(h, 'current')).catch(() => {});
const recallHandle = () => idb('readonly', st => st.get('current')).catch(() => null);
const forgetHandle = () => idb('readwrite', st => st.delete('current')).catch(() => {});
const PORT_TYPES = ['eth', 'power', 'usb', 'sata', 'pcie', 'm2', 'sfp', 'hdmi', 'dp', 'audio', 'coax', 'serial'];

const S = {
  inv: Core.emptyInv(),
  handle: null,
  name: 'inventory.yaml',
  dirty: false,
  sel: { kind: 'view', id: 'problems' },
  loaded: false,
  mtime: 0,      // file.lastModified as of the last read or write
  undo: [],
  redo: [],
  savedAt: '',
};

/* ---- persistence -------------------------------------------------------- */
function saveDraft() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      name: S.name, at: Date.now(), yaml: currentYaml(),
    }));
  } catch (e) {
    // Quota, or a private window. The file on disk is the real store, but the
    // user must be told the safety net is gone rather than assume it is there.
    if (!saveDraft.warned) { saveDraft.warned = true; toast('autosave unavailable, save to disk'); }
  }
}
function loadDraft() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d.yaml !== 'string') throw new Error('no yaml in draft');
    Core.parse(d.yaml);                 // prove it is usable before offering it
    return d;
  } catch (e) {
    // Keep the bad draft; otherwise the next edit silently overwrites it.
    try { localStorage.setItem(LS_KEY + ':corrupt', raw); localStorage.removeItem(LS_KEY); } catch {}
    return { corrupt: String(e.message || e) };
  }
}
function discardDraft() { try { localStorage.removeItem(LS_KEY); } catch {} }

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return s + 's ago';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 172800) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
function showBanner(children) {
  const b = $('banner');
  b.replaceChildren(...children);
  b.hidden = !children.length;
}
function hideBanner() { showBanner([]); }

// Undo works by keeping canonical YAML snapshots. Core.serialize round-trips
// exactly, so a string is a complete, cheap, trustworthy checkpoint. `lastSnap`
// holds the state as of the previous mutation, which is what makes the pushed
// snapshot the BEFORE state rather than the after.
const UNDO_MAX = 60;
let lastSnap = null;

// Checked, deliberately. The unchecked serializer would bake a state that Save
// refuses to write into the undo stack, and one Ctrl+Z would then make it live.
function snapshot() { try { return currentYaml(); } catch { return null; } }
function resetHistory() { S.undo = []; S.redo = []; lastSnap = snapshot(); }

function touched() {
  if (lastSnap !== null) {
    S.undo.push(lastSnap);
    if (S.undo.length > UNDO_MAX) S.undo.shift();
    S.redo = [];
  }
  lastSnap = snapshot();
  S.dirty = true; saveDraft(); render();
}

function step(from, to, what) {
  if (!from.length) { toast('nothing to ' + what); return; }
  const cur = snapshot();
  const text = from.pop();
  try { S.inv = Core.parse(text, S.name); }
  catch (e) { alertDlg('Cannot ' + what, String(e.message || e)); return; }
  if (cur !== null) to.push(cur);
  lastSnap = text;
  S.dirty = true; saveDraft(); render();
  toast(what === 'undo' ? 'undone' : 'redone');
}
const doUndo = () => step(S.undo, S.redo, 'undo');
const doRedo = () => step(S.redo, S.undo, 'redo');

/* ---- file open/save ----------------------------------------------------- */
const canFS = typeof window.showOpenFilePicker === 'function';

async function doOpen() {
  if (S.dirty) {
    const c = await choose('Unsaved changes',
      `${S.name} has edits you have not saved. Opening another file would discard them.`,
      [{ id: 'save', label: 'Save first', primary: true }, { id: 'discard', label: 'Discard and open' }]);
    if (!c) return;
    if (c === 'save') { await doSave(); if (S.dirty) return; }
  }
  if (canFS) {
    let h;
    try {
      [h] = await window.showOpenFilePicker({
        types: [{ description: 'YAML', accept: { 'text/yaml': ['.yaml', '.yml'] } }],
      });
    } catch { return; }
    const f = await h.getFile();
    if (!ingest(await f.text(), f.name)) return;
    S.handle = h;
    S.mtime = f.lastModified;
    rememberHandle(h);
    render();
  } else {
    const inp = el('input', { type: 'file', accept: '.yaml,.yml' });
    inp.onchange = async () => { const f = inp.files[0]; if (f) ingest(await f.text(), f.name); };
    inp.click();
  }
}

function ingest(text, name) {
  let inv;
  try { inv = Core.parse(text, name); }
  catch (e) { alertDlg('Could not parse', String(e.message || e)); return false; }
  S.inv = inv; S.name = name; S.dirty = false; S.loaded = true;
  refreshFields();   // the file may carry its own field specs
  const wanted = hashToSel(location.hash);
  S.sel = (wanted && wanted.kind === 'node' && inv.nodes.some(n => n.id === wanted.id))
    ? wanted
    : { kind: 'view', id: 'problems' };
  resetHistory(); hideBanner(); saveDraft(); render();
  toast(`loaded ${inv.nodes.length} nodes`);
  return true;
}

async function doSave() {
  let text;
  try { text = currentYaml(); }
  catch (e) { alertDlg('Not saved', String(e.message || e)); return; }

  if (!canFS) { download(text); return; }
  if (!S.handle) { return saveAs(text); }

  const choice = await choose('Save', `Overwrite ${S.name}, or write a new file?`, [
    { id: 'over', label: `Overwrite ${S.name}`, primary: true },
    { id: 'new', label: 'Create new file' },
  ]);
  if (choice === 'over') await writeHandle(S.handle, text);
  else if (choice === 'new') await saveAs(text);
}

async function saveAs(text) {
  try {
    const h = await window.showSaveFilePicker({
      suggestedName: S.name,
      types: [{ description: 'YAML', accept: { 'text/yaml': ['.yaml', '.yml'] } }],
    });
    // Set these BEFORE writing: writeHandle saves the draft and re-renders, and
    // both read S.name, so doing it after recorded the draft under the old name.
    S.handle = h; S.name = h.name;
    S.mtime = 0;                 // fresh target, nothing to be stale against
    await writeHandle(h, text);
  } catch { /* cancelled */ }
}

// Something else may have written the file since we read it: `inv fmt -w`, a git
// pull, or an editor. Overwriting silently would throw that away.
async function staleCheck(h) {
  let f;
  try { f = await h.getFile(); } catch { return true; }   // gone or revoked; let the write fail loudly
  if (!S.mtime || f.lastModified <= S.mtime) return true;
  const when = new Date(f.lastModified).toTimeString().slice(0, 8);
  const c = await choose('File changed on disk',
    `${h.name} was modified at ${when}, after you opened it. Saving now would ` +
    'discard those changes. Reloading discards yours instead, which Ctrl+Z cannot undo.',
    [{ id: 'over', label: 'Overwrite the file', primary: true },
     { id: 'reload', label: 'Discard mine and reload' }]);
  if (c === 'reload') {
    if (ingest(await f.text(), f.name)) { S.mtime = f.lastModified; render(); }
    return false;
  }
  return c === 'over';
}

async function writeHandle(h, text) {
  if (!(await staleCheck(h))) return;
  try {
    const w = await h.createWritable();
    await w.write(text); await w.close();
    S.dirty = false;
    S.savedAt = new Date().toTimeString().slice(0, 5);
    try { S.mtime = (await h.getFile()).lastModified; } catch { /* keep the old stamp */ }
    rememberHandle(h);
    saveDraft(); render(); toast(`saved ${h.name}`);
  } catch (e) { alertDlg('Write failed', String(e.message || e)); }
}

function download(text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
  const a = el('a', { href: url, download: S.name });
  a.click();
  // Revoking synchronously after click() races the download and can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  // Deliberately NOT clearing S.dirty: nothing here can confirm a file was
  // actually written, and clearing it would silence the unsaved-work warning.
  saveDraft(); render();
  toast('downloaded to your downloads folder, dirty flag kept');
}

/* ---- dialogs ------------------------------------------------------------ */
// A <dialog> closes on Escape without running any button handler, so a promise
// created by choose() would hang forever. One close listener settles it.
let dlgResolve = null;
function settleDlg(v) { const r = dlgResolve; dlgResolve = null; if (r) r(v); }
function closeDlg() { $('dlg').close(); }
function openDlg() {
  const d = $('dlg');
  if (d.open) d.close();   // showModal() on an open dialog throws
  d.showModal();
}
function alertDlg(head, body) {
  $('dlgHead').textContent = head;
  $('dlgBody').replaceChildren(el('div', { class: 'muted' }, body));
  $('dlgFoot').replaceChildren(el('button', { class: 'btn-primary', onclick: closeDlg }, 'OK'));
  openDlg();
}
function choose(head, body, opts) {
  return new Promise(res => {
    dlgResolve = res;
    $('dlgHead').textContent = head;
    $('dlgBody').replaceChildren(el('div', { class: 'muted' }, body));
    $('dlgFoot').replaceChildren(
      ...opts.map(o => el('button', {
        class: o.primary ? 'btn-primary' : '',
        onclick: () => { settleDlg(o.id); closeDlg(); },
      }, o.label)),
      el('button', { onclick: () => { settleDlg(null); closeDlg(); } }, 'Cancel'),
    );
    openDlg();
  });
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

/* ---- mutations ---------------------------------------------------------- */
function nodeById(id) { return S.inv.nodes.find(n => n.id === id); }

function addNode(kind) {
  const ns = kind === 'location' ? 'loc' : 'new';
  let i = 1, id;
  do { id = `${ns}/item-${i++}`; } while (nodeById(id));
  S.inv.nodes.push({
    id, label: '', type: kind === 'location' ? 'location' : '',
    parent: '', note: '', meta: null, pluggables: [], src: S.name,
  });
  S.sel = { kind: 'node', id };
  touched();
}

function deleteNode(id, reparentTo) {
  const n = nodeById(id); if (!n) return;
  const refs = new Set(n.pluggables.map(p => id + ':' + p.id));
  S.inv.nodes = S.inv.nodes.filter(x => x !== n);
  S.inv.links = S.inv.links.filter(l => !refs.has(l.a) && !refs.has(l.b));
  for (const m of S.inv.nodes) {
    if (m.parent === id) m.parent = reparentTo || '';
    for (const p of m.pluggables) if (refs.has(p.connected_with)) p.connected_with = '';
  }
  for (const l of S.inv.links) l.blocks = l.blocks.filter(b => !refs.has(b));
  S.sel = { kind: 'view', id: 'problems' };
  touched();
}

function renameNode(oldId, newId) {
  if (!newId || newId === oldId) return;
  if (nodeById(newId)) { alertDlg('Cannot rename', `"${newId}" already exists.`); return; }
  const n = nodeById(oldId); if (!n) return;
  const remap = r => { const [nd, pt] = Core.splitRef(r); return nd === oldId ? newId + ':' + pt : r; };
  n.id = newId;
  for (const m of S.inv.nodes) {
    if (m.parent === oldId) m.parent = newId;
    for (const p of m.pluggables) if (p.connected_with) p.connected_with = remap(p.connected_with);
  }
  for (const l of S.inv.links) {
    l.a = remap(l.a); l.b = remap(l.b); l.blocks = l.blocks.map(remap);
  }
  S.sel = { kind: 'node', id: newId };
  touched();
}

// Renaming a port must carry every reference with it. Editing the field
// directly used to orphan the cable, and validate only *warns* about a missing
// port, so it hid among the ordinary mid-entry warnings until the next save.
function renamePort(node, port, newId) {
  const from = node.id + ':' + port.id, to = node.id + ':' + newId;
  port.id = newId;
  for (const m of S.inv.nodes) for (const q of m.pluggables) {
    if (q.connected_with === from) q.connected_with = to;
  }
  for (const l of S.inv.links) {
    if (l.a === from) l.a = to;
    if (l.b === from) l.b = to;
    l.blocks = l.blocks.map(b => (b === from ? to : b));
  }
  if (S.openPorts) { S.openPorts.delete(from); S.openPorts.add(to); }
  touched();
}

// Adding ports one at a time was the bulk of data entry: an 8-outlet PDU was 8
// clicks plus ~32 field edits. This does the whole strip in one go, and defaults
// to the naming the templates use rather than p0/p1.
function addPortsBulk(node) {
  $('dlgHead').textContent = 'Add pluggables to ' + node.id;
  const body = $('dlgBody'); body.replaceChildren();
  const count = el('input', { type: 'number', value: '4', min: '1', max: '96', style: 'width:80px' });
  const prefix = el('input', { value: 'out', style: 'width:120px' });
  const start = el('input', { type: 'number', value: '1', style: 'width:80px' });
  const type = select(PORT_TYPES, 'power', () => {});
  const dir = select(['', 'in', 'out'], 'out', () => {}, x => x || '—');
  const preview = el('div', { class: 'faint' });
  const names = () => {
    const n = Math.max(1, Math.min(96, parseInt(count.value, 10) || 1));
    const s = parseInt(start.value, 10) || 0;
    return Array.from({ length: n }, (_, i) => prefix.value.trim() + (s + i));
  };
  const refresh = () => {
    const ids = names();
    const clash = ids.filter(x => node.pluggables.some(p => p.id === x));
    preview.textContent = ids.slice(0, 6).join(', ') + (ids.length > 6 ? `, … (${ids.length})` : '') +
      (clash.length ? `  — ${clash.length} already exist and will be skipped` : '');
  };
  for (const i of [count, prefix, start]) i.oninput = refresh;
  body.append(rawHint('Names are <code>prefix</code> + a number, so <code>out</code> from 1 gives ' +
    '<code>out1…out4</code>. Existing ids are skipped rather than overwritten.'),
    el('div', { class: 'grid2' },
      el('label', {}, 'how many'), count,
      el('label', {}, 'id prefix'), prefix,
      el('label', {}, 'start at'), start,
      el('label', {}, 'type'), type,
      el('label', {}, 'dir'), dir),
    preview);
  refresh();
  $('dlgFoot').replaceChildren(
    el('button', {
      class: 'btn-primary',
      onclick: () => {
        let added = 0;
        for (const id of names()) {
          if (node.pluggables.some(p => p.id === id)) continue;
          node.pluggables.push({
            id, type: type.value, dir: dir.value, connected_with: '', fanout: 0,
            mac: '', ips: [], untagged: 0, tagged: [], label: '', note: '', meta: null,
          });
          added++;
        }
        closeDlg();
        if (added) { touched(); toast(`added ${added} pluggable(s)`); }
      },
    }, 'Add'),
    el('button', { onclick: closeDlg }, 'Cancel'));
  openDlg();
  queueMicrotask(() => count.select());
}

// Cables are NOT copied: they are per-instance by definition, and a duplicate
// that claimed the original's cables would immediately be over capacity.
function duplicateNode(node) {
  const bump = id => {
    const m = /^(.*?)(\d+)$/.exec(id);
    if (!m) return id + '-copy';
    let n = +m[2];
    let candidate;
    do { candidate = m[1] + ++n; } while (nodeById(candidate));
    return candidate;
  };
  let id = bump(node.id);
  if (nodeById(id)) { let i = 2; while (nodeById(id + '-' + i)) i++; id = id + '-' + i; }
  const copy = JSON.parse(JSON.stringify({
    id, label: node.label, type: node.type, hostname: '', parent: node.parent,
    note: node.note, meta: node.meta,
    pluggables: node.pluggables.map(p => ({
      ...p, connected_with: '', mac: '', ips: [],
    })),
  }));
  copy.src = S.name;
  S.inv.nodes.push(copy);
  S.sel = { kind: 'node', id };
  touched();
  toast('duplicated as ' + id);
}

function addPort(node) {
  let i = 0, id;
  do { id = 'p' + i++; } while (node.pluggables.some(p => p.id === id));
  node.pluggables.push({ id, type: 'eth', dir: '', connected_with: '', label: '', note: '', meta: null });
  touched();
}

function removePort(node, port) {
  const ref = node.id + ':' + port.id;
  node.pluggables = node.pluggables.filter(p => p !== port);
  disconnect(ref, true);
  // deleteNode did this; removePort did not, leaving a permanent dangling warning
  for (const l of S.inv.links) l.blocks = l.blocks.filter(b => b !== ref);
  touched();
}

function connect(refA, refB) {
  S.inv.links.push({ a: refA, b: refB, label: '', note: '', poe: false, blocks: [], meta: null, src: S.name });
  touched();
}

function disconnect(ref, quiet) {
  S.inv.links = S.inv.links.filter(l => l.a !== ref && l.b !== ref);
  const [nd, pt] = Core.splitRef(ref);
  for (const n of S.inv.nodes) for (const p of n.pluggables) {
    if (p.connected_with === ref) p.connected_with = '';
    if (n.id === nd && p.id === pt) p.connected_with = '';
  }
  if (!quiet) touched();
}

function linkFor(ref) { return S.inv.links.find(l => l.a === ref || l.b === ref); }

// Removes one specific cable. disconnect(ref) drops every cable touching a
// port, which is wrong on a fanout port carrying several.
function removeLink(l) {
  S.inv.links = S.inv.links.filter(x => x !== l);
  for (const n of S.inv.nodes) for (const p of n.pluggables) {
    const ref = n.id + ':' + p.id;
    if ((ref === l.a && p.connected_with === l.b) || (ref === l.b && p.connected_with === l.a)) {
      p.connected_with = '';
    }
  }
  touched();
}

/* ---- templates ---------------------------------------------------------- */
let TPLS = [];

function pickTemplate() {
  $('dlgHead').textContent = 'New from template';
  const body = $('dlgBody'); body.replaceChildren();
  body.append(el('div', { class: 'hint' },
    'Templates carry the port layout so you do not retype five ports for the second Flex Mini. ' +
    'Built any node you own more than one of? Open it and hit "save as template".'));
  const groups = new Map();
  for (const t of TPLS) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group).push(t);
  }
  for (const g of [...groups.keys()].sort()) {
    body.append(el('h3', { style: 'margin:10px 0 4px' }, g));
    for (const t of groups.get(g).sort((a, b) => a.label < b.label ? -1 : 1)) {
      body.append(el('div', { class: 'opt', onclick: () => { closeDlg(); templateForm(t); } },
        t.label,
        el('span', { class: 'faint' }, '  ' + t.id),
        t.builtin ? null : el('span', { class: 'chip' }, 'saved')));
    }
  }
  $('dlgFoot').replaceChildren(el('button', { onclick: closeDlg }, 'Cancel'));
  openDlg();
}

function templateForm(tpl) {
  $('dlgHead').textContent = tpl.label;
  const body = $('dlgBody'); body.replaceChildren();
  const inputs = new Map();
  const grid = el('div', { class: 'grid2' });
  for (const v of tpl.vars) {
    let start = v.default;
    // Every numeric template ships default "1", so a second Flex Mini always
    // collided. Walk the number forward to the first id that is free.
    if (/^\d+$/.test(start)) {
      for (let i = 0; i < 400; i++) {
        const probe = {};
        for (const w of tpl.vars) probe[w.name] = w.name === v.name ? String(+start + i) : w.default;
        let id = '';
        try { id = Core.fromTemplate(tpl, probe, 'probe').id; } catch { break; }
        if (!id || !nodeById(id)) { start = String(+start + i); break; }
      }
    }
    const inp = el('input', { value: start });
    inputs.set(v.name, inp);
    grid.append(el('label', {}, v.label), inp);
  }
  if (!tpl.vars.length) body.append(el('div', { class: 'muted' }, 'No placeholders. Creates as-is.'));
  const preview = el('pre', {
    style: 'margin-top:10px;background:var(--panel2);padding:8px;border-radius:5px;max-height:220px;overflow:auto',
  });
  let createBtn = null;
  const problem = el('div', { class: 'prob e', style: 'display:none' });
  const refresh = () => {
    const vars = {};
    for (const [k, inp] of inputs) vars[k] = inp.value;
    try {
      const node = Core.fromTemplate(tpl, vars, 'template');
      preview.textContent = Core.emit(Core.canonical({ nodes: [node], links: [] }));
      // say so before the click, not after it fails
      let msg = '';
      if (!node.id) msg = 'The template produced an empty id.';
      else if (node.id.includes('{{')) msg = 'Unfilled placeholder in the id: ' + node.id;
      else if (nodeById(node.id)) msg = node.id + ' already exists.';
      problem.textContent = msg;
      problem.style.display = msg ? '' : 'none';
      if (createBtn) createBtn.disabled = !!msg;
    } catch (e) { preview.textContent = String(e.message || e); }
  };
  for (const inp of inputs.values()) inp.oninput = refresh;
  body.append(grid, problem, preview);

  const create = () => {
    const vars = {};
    for (const [k, inp] of inputs) vars[k] = inp.value;
    const node = Core.fromTemplate(tpl, vars, S.name);
    if (!node.id) { alertDlg('Cannot create', 'The template produced an empty id.'); return; }
    if (nodeById(node.id)) { alertDlg('Cannot create', `"${node.id}" already exists.`); return; }
    closeDlg();
    S.inv.nodes.push(node);
    S.sel = { kind: 'node', id: node.id };
    touched();
    toast('created ' + node.id);
  };
  createBtn = el('button', { class: 'btn-primary', onclick: create }, 'Create');
  $('dlgFoot').replaceChildren(createBtn, el('button', { onclick: closeDlg }, 'Cancel'));
  refresh();
  openDlg();
  const first = [...inputs.values()][0];
  if (first) { first.focus(); first.select(); }
}

function saveAsTemplate(node) {
  $('dlgHead').textContent = 'Save as template';
  const body = $('dlgBody'); body.replaceChildren();
  const idIn = el('input', { value: slugOf(node.id), style: 'width:100%' });
  const grpIn = el('input', { value: node.id.includes('/') ? node.id.split('/')[0] : 'saved', style: 'width:100%' });
  body.append(el('div', { class: 'muted', style: 'margin-bottom:8px' },
    'Cables are not saved. A trailing number in the id becomes {{n}} so the next one is a two-field job.'),
    el('div', { class: 'grid2' },
      el('label', {}, 'template id'), idIn,
      el('label', {}, 'group'), grpIn));
  $('dlgFoot').replaceChildren(
    el('button', {
      class: 'btn-primary',
      onclick: async () => {
        const id = idIn.value.trim();
        if (!id) return;
        const clash = TPLS.find(x => x.id === id);
        if (clash && await choose('Replace template',
          `A template called "${id}" already exists${clash.builtin ? ' (built in)' : ''}. Replace it?`,
          [{ id: 'yes', label: 'Replace', primary: true }]) !== 'yes') return;
        const t = Core.toTemplate(node, id, grpIn.value.trim() || 'saved');
        TPLS = [...TPLS.filter(x => x.id !== id), { ...t, builtin: false }];
        persistSettings(); closeDlg(); render(); toast('template saved');
      },
    }, 'Save'),
    el('button', { onclick: closeDlg }, 'Cancel'));
  openDlg();
}

function slugOf(id) { return (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id).replace(/\d+$/, '') .replace(/-$/, '') || 'template'; }

/* ---- settings: field specs + templates ---------------------------------- */
const LS_SET = 'wirebook:templates';
let FIELDS = [];             // shipped defaults merged with whatever the inventory carries
let FIELD_BY_ID = new Map();
let SHIPPED = [];            // defaults only, so we know what does NOT need embedding
let SETTINGS_SOURCE = 'built in';

// Field specs are NOT kept in browser storage. They describe the user's data, so
// they live in the inventory file: backing up that one file has to be enough, and
// anything held only in localStorage would vanish the first time site data was
// cleared, leaving values nobody could interpret.
function applySettings(text, source) {
  let parsed;
  try { parsed = Core.parseSettings(text); }
  catch (e) { toast('settings could not be read: ' + (e.message || e)); return; }
  SHIPPED = parsed.fields.map(x => ({ ...x, shipped: true }));
  SETTINGS_SOURCE = source;

  const tm = new Map();
  for (const x of parsed.templates) tm.set(x.id, { ...x, builtin: true });
  for (const x of parsed.templates) tm.set(x.id, { ...x, builtin: true });
  TPLS = [...tm.values()];

  refreshFields();
}

// The inventory's own specs win, so a field you tuned locally is not silently
// reverted by whatever the server happens to be serving.
function refreshFields() {
  const m = new Map();
  for (const x of SHIPPED) m.set(x.id, x);
  for (const x of (S.inv.fields || [])) m.set(x.id, { ...x, shipped: false });
  FIELDS = [...m.values()];
  FIELD_BY_ID = new Map(FIELDS.map(x => [x.id, x]));
}

// Where the shipped defaults come from, in order:
//
//   1. your own copy in this browser, once you have changed something
//   2. otherwise the copy built into this page, which is the repo default
//
// Nothing is server-side. There is no mode to pick, and settings.yaml is never
// fetched: a served copy could only ever do what the built-in copy already does,
// since the browser cannot write back to it anyway.
//
// localStorage is written ONLY when you actually change something. Pre-seeding it
// would mean a stale local copy silently shadowing new shipped defaults from a
// future version, forever.
//
// Losing this is harmless: it holds reproducible defaults, not your data. Your own
// field definitions live in your inventory file.
const LS_SETTINGS = 'wirebook:settings';

const inlineSettings = () => document.getElementById('builtinSettings').textContent;

function storedSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    return raw && raw.trim() ? raw : null;
  } catch { return null; }
}

function initSettings() {
  const mine = storedSettings();
  if (mine) {
    try { applySettings(mine, 'your copy in this browser'); return; }
    catch { /* fall through to the built-in defaults */ }
  }
  applySettings(inlineSettings(), 'repo default, built in');
}

function saveSettings(text) {
  try { Core.parseSettings(text); }   // refuse to store something unreadable
  catch (e) { alertDlg('Not a settings file', String(e.message || e)); return false; }
  try { localStorage.setItem(LS_SETTINGS, text); }
  catch { toast('could not store settings: browser storage is full'); return false; }
  initSettings(); render();
  return true;
}

function resetSettings() {
  try { localStorage.removeItem(LS_SETTINGS); } catch { /* ignore */ }
  initSettings(); render();
  toast('back to the repo defaults');
}

// A saved template is a change to your settings, so it lands in the same place.
function persistTemplatesOnly() {
  const keep = Core.parseSettings(storedSettings() || inlineSettings());
  const text = Core.settingsDoc(keep.fields, TPLS.filter(x => !x.builtin));
  try { localStorage.setItem(LS_SETTINGS, text); } catch { toast('could not save templates: storage full'); }
  initSettings();
}
const persistSettings = persistTemplatesOnly;

// Any field actually in use that the shipped settings do not provide gets written
// into the inventory, so the file stands alone. Nothing is pruned: a spec you
// declared but have not used yet is intent, not litter.
function embedUsedFields() {
  const used = new Set();
  for (const n of S.inv.nodes) {
    for (const k of Object.keys(n.meta || {})) used.add(k);
    for (const p of n.pluggables) for (const k of Object.keys(p.meta || {})) used.add(k);
  }
  for (const l of S.inv.links) for (const k of Object.keys(l.meta || {})) used.add(k);
  for (const v of (S.inv.vlans || [])) for (const k of Object.keys(v.meta || {})) used.add(k);

  const shipped = new Map(SHIPPED.map(f => [f.id, f]));
  const embedded = new Map((S.inv.fields || []).map(f => [f.id, f]));
  let added = 0;
  for (const id of used) {
    if (embedded.has(id)) continue;
    const spec = FIELD_BY_ID.get(id);
    if (!spec) continue;                       // undeclared, and that is allowed
    const ship = shipped.get(id);
    if (ship && Core.emit(Core.fieldOut(ship)) === Core.emit(Core.fieldOut(spec))) continue;
    S.inv.fields = [...(S.inv.fields || []), { ...spec, shipped: false }];
    added++;
  }
  return added;
}

// Every path that turns the model into bytes goes through here, so a field can
// never be in use in a file that does not define it.
function currentYaml() {
  embedUsedFields();
  return Core.serializeChecked(S.inv);
}

function specsFor(scope) {
  return FIELDS.filter(f => !f.applies_to.length || f.applies_to.includes(scope));
}
function unitSuffix(spec) {
  return spec && spec.unit ? el('span', { class: 'faint', style: 'margin-left:4px' }, spec.unit) : null;
}

/* ---- meta editor, driven by field specs --------------------------------- */
function metaEditor(holder, scope) {
  const wrap = el('div', {});
  const meta = holder.meta || {};
  const setKey = (k, v) => {
    const next = { ...(holder.meta || {}) };
    if (v === undefined || v === '' || v === null) delete next[k]; else next[k] = v;
    holder.meta = Object.keys(next).length ? next : null;
  };

  const rows = el('div', {});
  for (const k of Object.keys(meta).sort()) {
    const spec = FIELD_BY_ID.get(k);
    const row = el('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:wrap' });

    row.append(el('span', {
      style: 'min-width:150px;color:var(--dim)',
      title: spec ? (spec.description || spec.id) : 'not declared in settings',
    }, spec ? spec.label : k));

    if (!spec) {
      // Undeclared is legal; meta is open. Flag it and offer to declare it, so a
      // typo is visible without half-entered data being rejected.
      const kIn = el('input', { value: k, style: 'width:130px' });
      kIn.onchange = () => {
        const nk = kIn.value.trim();
        if (!nk || nk === k) { kIn.value = k; return; }
        if (Object.prototype.hasOwnProperty.call(holder.meta || {}, nk)) {
          kIn.value = k; alertDlg('Key already used', `"${nk}" already exists here.`); return;
        }
        const next = { ...holder.meta }; next[nk] = next[k]; delete next[k];
        holder.meta = next; touched();
      };
      const vIn = el('input', { value: String(meta[k]), style: 'width:200px' });
      vIn.onchange = () => { setKey(k, coerce(vIn.value)); touchedSoft(); };
      row.replaceChildren(
        el('span', { class: 'chip', title: 'not declared in settings' }, 'ad hoc'),
        kIn, vIn,
        el('button', { title: 'declare this as a field', onclick: () => declareField(k, meta[k], scope) }, 'declare'),
        el('button', { onclick: () => { setKey(k, undefined); touched(); } }, '×'));
      rows.append(row);
      continue;
    }

    row.append(metaControl(spec, meta[k], v => { setKey(k, v); touchedSoft(); }));
    const u = unitSuffix(spec);
    if (u) row.append(u);
    row.append(el('button', { onclick: () => { setKey(k, undefined); touched(); } }, '×'));
    rows.append(row);
  }
  wrap.append(rows);

  // add: pick from the specs that apply here and are not already set
  const avail = specsFor(scope).filter(f => !(f.id in meta));
  const pick = el('select', { style: 'max-width:230px' });
  pick.append(el('option', { value: '' }, avail.length ? '+ add field…' : 'all fields set'));
  for (const f of avail.sort((a, b) => (a.label < b.label ? -1 : 1))) {
    pick.append(el('option', { value: f.id }, f.label + (f.unit ? ` (${f.unit})` : '')));
  }
  pick.onchange = () => {
    const id = pick.value; if (!id) return;
    const spec = FIELD_BY_ID.get(id);
    setKey(id, blankValue(spec));
    touched();
  };
  wrap.append(el('div', { style: 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap' },
    pick,
    el('button', {
      onclick: () => {
        let i = 1, k = 'custom'; while ((holder.meta || {})[k] !== undefined) k = 'custom' + ++i;
        setKey(k, ''); touched();
      },
    }, '+ ad hoc key')));
  return wrap;
}

function blankValue(spec) {
  if (!spec) return '';
  if (spec.type === 'boolean') return false;
  if (spec.type === 'composite') return {};
  if (spec.type === 'number' || spec.type === 'integer') return 0;
  if (spec.type === 'enum' && spec.enum.length) return spec.enum[0];
  return '';
}

// One widget per control kind. `onset` receives the typed value, never a string
// for a numeric field, so numbers stay sortable in the file.
function metaControl(spec, value, onset) {
  switch (spec.control) {
    case 'checkbox': {
      const c = el('input', { type: 'checkbox' });
      c.checked = value === true;
      c.onchange = () => onset(c.checked);
      return c;
    }
    case 'number': {
      const n = el('input', { type: 'number', style: 'width:110px', step: spec.type === 'integer' ? '1' : 'any' });
      n.value = value === undefined || value === null ? '' : String(value);
      if (spec.min !== null) n.min = spec.min;
      if (spec.max !== null) n.max = spec.max;
      n.onchange = () => {
        if (n.value.trim() === '') { onset(''); return; }
        const num = Number(n.value);
        onset(Number.isFinite(num) ? (spec.type === 'integer' ? Math.round(num) : num) : n.value);
      };
      return n;
    }
    case 'select': {
      const sel = el('select');
      const opts = spec.enum.map(String);
      if (!opts.includes(String(value))) sel.append(el('option', { value: String(value) }, String(value)));
      for (const o of opts) sel.append(el('option', { value: o, selected: String(value) === o }, o));
      sel.onchange = () => onset(sel.value);
      return sel;
    }
    case 'combo': {
      // a dropdown that still accepts anything, which is what `open: true` means
      const listId = 'combo-' + spec.id;
      if (!document.getElementById(listId)) {
        const dl = el('datalist', { id: listId });
        for (const o of spec.enum) dl.append(el('option', { value: String(o) }));
        document.body.append(dl);
      }
      const i = el('input', { list: listId, value: value === undefined ? '' : String(value), style: 'width:190px' });
      i.onchange = () => onset(i.value);
      return i;
    }
    case 'composite': {
      const box = el('div', { style: 'display:flex;gap:5px;flex-wrap:wrap' });
      const cur = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
      for (const part of spec.parts) {
        const numeric = part.type === 'number' || part.type === 'integer';
        const inp = el('input', {
          type: numeric ? 'number' : 'text', placeholder: part.label,
          style: numeric ? 'width:88px' : 'width:120px',
          value: cur[part.id] === undefined ? '' : String(cur[part.id]),
        });
        inp.onchange = () => {
          const next = { ...cur };
          if (inp.value.trim() === '') delete next[part.id];
          else next[part.id] = numeric ? Number(inp.value) : inp.value;
          onset(Object.keys(next).length ? next : {});
        };
        box.append(el('span', { style: 'display:inline-flex;align-items:center;gap:3px' },
          inp, part.unit ? el('span', { class: 'faint' }, part.unit) : null));
      }
      return box;
    }
    case 'textarea': {
      const ta = el('textarea', { rows: 2, style: 'width:260px' });
      ta.value = value === undefined ? '' : String(value);
      ta.onchange = () => onset(ta.value);
      return ta;
    }
    default: {
      const i = el('input', { value: value === undefined ? '' : String(value), style: 'width:220px' });
      i.onchange = () => onset(i.value);
      return i;
    }
  }
}

// Promote an ad hoc key into a declared field without leaving the page.
function declareField(id, sample, scope) {
  $('dlgHead').textContent = 'Declare field';
  const body = $('dlgBody'); body.replaceChildren();
  const guessType = typeof sample === 'boolean' ? 'boolean'
    : typeof sample === 'number' ? (Number.isInteger(sample) ? 'integer' : 'number') : 'string';
  const idIn = el('input', { value: id, style: 'width:100%' });
  const labelIn = el('input', { value: id.replace(/_/g, ' '), style: 'width:100%' });
  const typeIn = select(['string', 'number', 'integer', 'boolean', 'enum', 'composite'], guessType, () => {});
  const unitIn = el('input', { placeholder: 'V, W, gbps, GB…', style: 'width:100%' });
  const enumIn = el('input', { placeholder: 'comma separated, for enum', style: 'width:100%' });
  const openIn = el('input', { type: 'checkbox' });
  body.append(el('div', { class: 'hint' },
    'The id is the meta key, so declaring it applies to every place that key is already used. ' +
    'Units go here, not in the value.'),
    el('div', { class: 'grid2' },
      el('label', {}, 'id'), idIn,
      el('label', {}, 'label'), labelIn,
      el('label', {}, 'type'), typeIn,
      el('label', {}, 'unit'), unitIn,
      el('label', {}, 'options'), enumIn,
      el('label', {}, 'allow off-list'), openIn));
  $('dlgFoot').replaceChildren(
    el('button', {
      class: 'btn-primary',
      onclick: () => {
        const fid = idIn.value.trim();
        if (!/^[a-z][a-z0-9_]*$/.test(fid)) {
          alertDlg('Not a valid id', 'Lowercase letters, digits and underscores, starting with a letter.');
          return;
        }
        const vals = enumIn.value.split(',').map(x => x.trim()).filter(Boolean);
        const spec = {
          id: fid, label: labelIn.value.trim() || fid, type: typeIn.value,
          unit: unitIn.value.trim(), enum: vals, open: openIn.checked,
          min: null, max: null, applies_to: scope ? [scope] : [], description: '', parts: [],
          builtin: false,
        };
        spec.control = vals.length ? (spec.open ? 'combo' : 'select')
          : spec.type === 'boolean' ? 'checkbox'
          : (spec.type === 'number' || spec.type === 'integer') ? 'number'
          : spec.type === 'composite' ? 'composite' : 'text';
        S.inv.fields = [...(S.inv.fields || []).filter(f => f.id !== fid), spec];
        refreshFields();
        closeDlg(); touched(); toast('field declared, saved with your inventory');
      },
    }, 'Declare'),
    el('button', { onclick: closeDlg }, 'Cancel'));
  openDlg();
}

/* ---- settings view ------------------------------------------------------ */
function renderSettings(v) {
  v.append(el('h2', {}, 'Settings'));
  v.append(el('h3', {}, 'where defaults come from'));
  v.append(rawHint(
    'The shipped defaults come from <b>the copy built into this page</b> until you change something, ' +
    'after which <b>your copy in this browser</b> is used. Nothing is fetched from a server: a served copy ' +
    'could only do what the built-in one already does, since the browser cannot write back to it.<br>' +
    'This only covers the <i>shipped defaults</i> such as labels and units. Your own field definitions live in ' +
    'your inventory file and none of this touches them, so losing this costs you nothing you cannot regenerate.'));
  const srcRow = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0 12px' });
  srcRow.append(el('span', { class: 'chip' }, 'active: ' + SETTINGS_SOURCE));
  srcRow.append(el('button', {
    onclick: () => {
      const inp = el('input', { type: 'file', accept: '.yaml,.yml' });
      inp.onchange = async () => { const f = inp.files[0]; if (f && saveSettings(await f.text())) toast('settings loaded'); };
      inp.click();
    },
  }, 'load a settings.yaml'));
  if (storedSettings()) {
    srcRow.append(el('button', {
      onclick: async () => {
        if (await choose('Reset settings',
          'Discard your settings and go back to the defaults built into this page? ' +
          'Your inventory and its field definitions are not touched.',
          [{ id: 'yes', label: 'Reset', primary: true }]) === 'yes') resetSettings();
      },
    }, 'reset to repo default'));
  }
  v.append(srcRow);

  v.append(el('h3', {}, 'fields and templates'));
  v.append(rawHint(
    'Field definitions are stored <b>inside your inventory file</b>, not in the browser, so backing up that one ' +
    'file keeps them. Only the ones the shipped defaults do not already cover are written, and the editor adds ' +
    'them automatically as soon as you use them. Templates are a convenience for creating nodes and live in ' +
    'browser storage; export them if you want to keep them.'));
  v.append(rawHint(
    'Two things live here: <b>fields</b>, which define what you can track, and <b>templates</b>, which define ' +
    'reusable node shapes. Neither holds inventory data. A field spec\'s <code>id</code> <i>is</i> the meta key, ' +
    'so declaring <code>speed</code> applies to every port that already has a <code>speed</code>. ' +
    '<b>Units belong on the spec, never in the value</b>: <code>speed: 2.5</code> with unit gbps stays sortable, ' +
    'where <code>"2.5 gbps"</code> is prose you would have to parse back.'));

  v.append(el('div', { style: 'margin:10px 0;display:flex;gap:8px;flex-wrap:wrap' },
    el('button', { class: 'btn-primary', onclick: () => declareField('new_field', '', 'node') }, '+ field'),
    el('button', { onclick: pickTemplate }, 'new from template'),
    el('button', {
      onclick: () => {
        const text = Core.settingsDoc((S.inv.fields || []), TPLS.filter(t => !t.builtin));
        const url = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
        const a = el('a', { href: url, download: 'settings.yaml' });
        a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
        toast('exported your additions');
      },
    }, 'export settings.yaml'),
    el('button', {
      onclick: () => {
        const inp = el('input', { type: 'file', accept: '.yaml,.yml' });
        inp.onchange = async () => {
          const f = inp.files[0]; if (!f) return;
          try {
            const got = Core.parseSettings(await f.text());
            const fm = new Map((S.inv.fields || []).map(x => [x.id, x]));
            for (const x of got.fields) fm.set(x.id, { ...x, shipped: false });
            S.inv.fields = [...fm.values()];
            refreshFields();
            const tm = new Map(TPLS.map(x => [x.id, x]));
            for (const x of got.templates) tm.set(x.id, { ...x, builtin: false });
            TPLS = [...tm.values()];
            persistTemplatesOnly(); touched();
            toast(`imported ${got.fields.length} fields, ${got.templates.length} templates`);
          } catch (e) { alertDlg('Import failed', String(e.message || e)); }
        };
        inp.click();
      },
    }, 'import settings.yaml')));

  // which meta keys are in use but undeclared? that is the typo detector
  const used = new Map();
  const note = (k, where) => { if (!used.has(k)) used.set(k, []); used.get(k).push(where); };
  for (const n of S.inv.nodes) {
    for (const k of Object.keys(n.meta || {})) note(k, n.id);
    for (const p of n.pluggables) for (const k of Object.keys(p.meta || {})) note(k, `${n.id}:${p.id}`);
  }
  for (const l of S.inv.links) for (const k of Object.keys(l.meta || {})) note(k, `${l.a} <-> ${l.b}`);
  const undeclared = [...used.keys()].filter(k => !FIELD_BY_ID.has(k)).sort();
  if (undeclared.length) {
    v.append(el('h3', {}, `undeclared keys in use (${undeclared.length})`));
    v.append(hint('Legal, since meta is open, but a typo looks exactly like this. Declare it or fix it.'));
    v.append(el('table', {}, el('tbody', {}, ...undeclared.map(k => el('tr', {},
      el('td', {}, el('span', { class: 'chip' }, 'ad hoc'), ' ', k),
      el('td', { class: 'faint' }, used.get(k).slice(0, 4).join(', ') + (used.get(k).length > 4 ? ` +${used.get(k).length - 4}` : '')),
      el('td', { class: 'right' }, el('button', { onclick: () => declareField(k, '', 'node') }, 'declare')),
    )))));
  }

  v.append(el('h3', {}, `fields (${FIELDS.length})`));
  const rows = FIELDS.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map(f => el('tr', {},
    el('td', {}, f.id, f.shipped ? null : el('span', { class: 'chip' }, 'in inventory')),
    el('td', {}, f.label),
    el('td', { class: 'faint' }, f.type + (f.control && f.control !== f.type ? ` / ${f.control}` : '')),
    el('td', {}, f.unit || el('span', { class: 'faint' }, '—')),
    el('td', { class: 'faint' }, f.enum.length ? f.enum.slice(0, 4).join(', ') + (f.open ? ' (open)' : '') : ''),
    el('td', { class: 'faint' }, f.applies_to.join(', ') || 'any'),
    el('td', { class: 'faint' }, used.has(f.id) ? `${used.get(f.id).length} use(s)` : ''),
    el('td', { class: 'right' }, f.shipped ? null : el('button', {
      onclick: () => {
        S.inv.fields = (S.inv.fields || []).filter(x => x.id !== f.id);
        refreshFields(); touched();
      },
    }, '×')),
  ));
  v.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['id', 'label', 'type', 'unit', 'options', 'applies to', 'in use', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, ...rows)));

  v.append(el('h3', {}, `templates (${TPLS.length})`));
  v.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['id', 'group', 'label', 'vars', 'ports', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, ...TPLS.slice().sort((a, b) => (a.group + a.id < b.group + b.id ? -1 : 1)).map(t => el('tr', {},
      el('td', {}, t.id, t.builtin ? null : el('span', { class: 'chip' }, 'custom')),
      el('td', { class: 'faint' }, t.group),
      el('td', {}, t.label),
      el('td', { class: 'faint' }, t.vars.map(x => x.name).join(', ')),
      el('td', { class: 'faint' }, String((t.node.pluggables || []).length)),
      el('td', { class: 'right' },
        el('button', { onclick: () => templateForm(t) }, 'use'),
        t.builtin ? null : el('button', {
          onclick: () => { TPLS = TPLS.filter(x => x !== t); persistSettings(); render(); },
        }, '×')),
    )))));
}

/* ---- render ------------------------------------------------------------- */
// The selection lives in the URL, so a node or view can be bookmarked, shared, or
// reached with the back button. Node ids contain slashes, which is legal in a
// fragment, so no encoding games are needed.
function selToHash(sel) {
  return sel.kind === 'node' ? '#node/' + sel.id : '#view/' + sel.id;
}
function hashToSel(hash) {
  const h = (hash || '').replace(/^#/, '');
  if (h.startsWith('node/')) return { kind: 'node', id: h.slice(5) };
  if (h.startsWith('view/')) return { kind: 'view', id: h.slice(5) };
  return null;
}

// replaceState, not pushState: every sidebar click becoming a history entry makes
// the back button useless for actually leaving the app.
let suppressHash = false;
function syncHash() {
  const want = selToHash(S.sel);
  if (location.hash === want) return;
  suppressHash = true;
  try { history.replaceState(null, '', want); } catch { location.hash = want; }
  suppressHash = false;
}

window.addEventListener('hashchange', () => {
  if (suppressHash) return;
  const sel = hashToSel(location.hash);
  if (!sel) return;
  // a link to a node that is not in this file should say so, not blank the view
  if (sel.kind === 'node' && !nodeById(sel.id)) { toast(sel.id + ' is not in this inventory'); return; }
  S.sel = sel;
  render();
});

function render() {
  syncHash();
  const ix = Core.index(S.inv);
  const probs = Core.validate(S.inv, FIELD_BY_ID);
  renderHeader(probs);
  renderNav(ix);
  renderView(ix, probs);
}

function renderHeader(probs) {
  $('hFile').textContent = (S.loaded ? S.name : 'no file') +
    (S.loaded && canFS && !S.handle ? '  (not linked to a file)' : '');
  $('hDirty').hidden = !S.dirty;
  $('hDirty').title = S.dirty ? 'unsaved changes' : '';
  $('bUndo').disabled = !S.undo.length;
  $('bRedo').disabled = !S.redo.length;
  $('bSave').textContent = S.dirty ? 'Save*' : 'Save';
  const ports = S.inv.nodes.reduce((a, n) => a + n.pluggables.length, 0);
  $('hStat').textContent = `${S.inv.nodes.length} nodes / ${ports} ports / ${S.inv.links.length} cables`;
  const e = probs.filter(p => !p.warn).length, w = probs.length - e;
  const box = $('hProb'); box.replaceChildren();
  if (e) box.append(el('span', { class: 'pill err' }, `${e} error${e > 1 ? 's' : ''}`));
  if (w) box.append(el('span', { class: 'pill warn' }, `${w} warning${w > 1 ? 's' : ''}`));
  if (!e && !w && S.loaded) box.append(el('span', { class: 'pill ok' }, 'clean'));
  if (S.savedAt) box.append(el('span', { class: 'stat' }, ' saved ' + S.savedAt));
}

function navRow(label, sel, count, depth = 0, twist = '') {
  const on = S.sel.kind === sel.kind && S.sel.id === sel.id;
  // an <a> so it is keyboard reachable and copy-link-able, styled as a row
  return el('a', {
    class: 'row' + (on ? ' on' : ''),
    href: selToHash(sel),
    style: `padding-left:${10 + depth * 13}px`,
    onclick: e => { e.preventDefault(); S.sel = sel; render(); },
  },
    el('span', { class: 'tw' }, twist),
    el('span', { class: 'lbl' }, label),
    count == null ? null : el('span', { class: 'count' }, String(count)),
  );
}

function renderNav(ix) {
  const nav = $('nav'); nav.replaceChildren();

  const q = (S.navQ || '').toLowerCase();
  const find = el('input', {
    placeholder: 'filter…  (ctrl+k)', value: S.navQ || '',
    style: 'width:calc(100% - 20px);margin:0 10px 6px',
  });
  find.oninput = () => {
    S.navQ = find.value;
    renderNav(ix);
    const box = $('nav').querySelector('input');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  };
  nav.append(find);
  // matches id, label, hostname, or any ip, so pasting an address from a DHCP
  // lease finds the port that owns it
  const hit = n => {
    if (!q) return true;
    if ((n.id + ' ' + (n.label || '') + ' ' + (n.hostname || '')).toLowerCase().includes(q)) return true;
    return n.pluggables.some(p =>
      (p.ips || []).some(a => a.toLowerCase().includes(q)) ||
      (p.mac || '').toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q));
  };

  nav.append(el('h4', {}, 'Views'));
  nav.append(navRow('Problems', { kind: 'view', id: 'problems' }));
  nav.append(navRow('Free ports', { kind: 'view', id: 'free' }));
  nav.append(navRow('Cables', { kind: 'view', id: 'cables' }, S.inv.links.length));
  nav.append(navRow('Tree', { kind: 'view', id: 'tree' }));
  nav.append(navRow('Graph', { kind: 'view', id: 'graph' }));
  nav.append(navRow('VLANs', { kind: 'view', id: 'vlans' }, S.inv.vlans.length || null));
  nav.append(navRow('YAML', { kind: 'view', id: 'yaml' }));

  // location tree, any depth
  const locs = S.inv.nodes.filter(n => n.type === 'location' && (!q || hit(n) ||
    S.inv.nodes.some(x => x.parent === n.id && hit(x))));
  if (locs.length) {
    nav.append(el('h4', {}, 'Locations'));
    const byId = new Map(locs.map(l => [l.id, l]));
    const walk = (parent, depth) => {
      for (const l of locs.filter(x => (byId.has(x.parent) ? x.parent : '') === parent)) {
        const inside = S.inv.nodes.filter(n => n.parent === l.id && n.type !== 'location').length;
        nav.append(navRow(l.label || l.id, { kind: 'node', id: l.id }, inside || null, depth, '▪'));
        walk(l.id, depth + 1);
      }
    };
    walk('', 0);
  }

  // everything else, grouped by namespace prefix
  const groups = new Map();
  for (const n of S.inv.nodes) {
    if (n.type === 'location' || !hit(n)) continue;
    const ns = n.id.includes('/') ? n.id.slice(0, n.id.indexOf('/')) : '(none)';
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns).push(n);
  }
  for (const ns of [...groups.keys()].sort()) {
    nav.append(el('h4', {}, ns));
    for (const n of groups.get(ns).sort((a, b) => a.id < b.id ? -1 : 1)) {
      nav.append(navRow(n.label || n.id, { kind: 'node', id: n.id }, n.pluggables.length || null, 0));
    }
  }

  nav.append(el('h4', {}, 'Settings'));
  nav.append(navRow('Settings', { kind: 'view', id: 'settings' }, FIELDS.length + TPLS.length));
  nav.append(el('div', { class: 'row', onclick: pickTemplate },
    el('span', { class: 'tw' }, '+'), el('span', { class: 'lbl' }, 'New from template')));

  nav.append(el('h4', {}, 'Add'));
  nav.append(el('div', { class: 'row', onclick: () => addNode('device') },
    el('span', { class: 'tw' }, '+'), el('span', { class: 'lbl' }, 'Node')));
  nav.append(el('div', { class: 'row', onclick: () => addNode('location') },
    el('span', { class: 'tw' }, '+'), el('span', { class: 'lbl' }, 'Location')));
}

function renderView(ix, probs) {
  const v = $('view'); v.replaceChildren();
  if (!S.loaded && !S.inv.nodes.length) {
    v.append(el('div', { class: 'empty' }, 'Open an inventory.yaml, or add a node to start a new one.'));
    return;
  }
  if (S.sel.kind === 'node') return renderNode(v, ix, nodeById(S.sel.id));
  if (S.sel.id === 'problems') return renderProblems(v, probs);
  if (S.sel.id === 'free') return renderFree(v, ix);
  if (S.sel.id === 'cables') return renderCables(v, ix);
  if (S.sel.id === 'yaml') return renderYaml(v);
  if (S.sel.id === 'settings') return renderSettings(v);
  if (S.sel.id === 'graph') return renderGraph(v, ix);
  if (S.sel.id === 'tree') return renderTree(v, ix);
  if (S.sel.id === 'vlans') return renderVlans(v);
}

// Refs are rendered in accent blue everywhere; make them behave like the links
// they look like, otherwise tracing a cable means hunting the sidebar by hand.
function refLink(ref) {
  const [nid] = Core.splitRef(ref);
  return el('a', {
    href: selToHash({ kind: 'node', id: nid }), class: 'link-to', title: 'open ' + nid,
    onclick: e => {
      e.preventDefault();
      if (!nodeById(nid)) { toast(nid + ' does not exist'); return; }
      S.openPorts = S.openPorts || new Set();
      S.openPorts.add(ref);
      S.sel = { kind: 'node', id: nid };
      render();
    },
  }, ref);
}

let fieldSeq = 0;
// `type` is free text and carries no semantics anywhere EXCEPT the exact value
// `location`, which drives the Locations tree, the Tree ordering and the Graph
// columns. Typing `Location` or `room` silently produces a node that never
// becomes a column, with nothing to explain why.
// Marks something with no physical presence. Its ports drop out of the free
// report and the graph, which is the point: a VM's vNIC is not somewhere you can
// plug a cable in, and listing it forever would make that report useless.
function virtualToggle(n) {
  const wrap = el('span', { style: 'display:inline-flex;align-items:center;gap:6px' });
  const cb = el('input', { type: 'checkbox' });
  cb.checked = !!n.virtual;
  cb.onchange = () => { n.virtual = cb.checked; touched(); };
  wrap.append(cb, el('span', { class: 'faint' },
    'a VM or container; set parent to the machine it runs on'));
  return wrap;
}

function typeInput(n) {
  const seen = new Set(['location']);
  for (const x of S.inv.nodes) if (x.type) seen.add(x.type);
  for (const tpl of TPLS) if (tpl.node && tpl.node.type) seen.add(tpl.node.type);
  const listId = 'node-types';
  let dl = document.getElementById(listId);
  if (dl) dl.remove();
  dl = el('datalist', { id: listId });
  for (const v of [...seen].sort()) dl.append(el('option', { value: v }));
  document.body.append(dl);
  const i = el('input', { value: n.type || '', list: listId });
  i.onchange = () => { n.type = i.value; touched(); };   // full render: changes nav grouping
  return i;
}

function field(label, input) {
  const id = 'f' + (++fieldSeq);
  if (!input.id) input.id = id;
  return [el('label', { for: input.id }, label), input];
}
// Text by default. rawHint is for the handful of literal constants that want
// <b> and <code>; keeping them separate means no future edit can accidentally
// pipe a node label into innerHTML while the app holds a file write handle.
const hint = text => el('div', { class: 'hint' }, text);
const rawHint = html => el('div', { class: 'hint', html });

function renderNode(v, ix, n) {
  if (!n) { v.append(el('div', { class: 'empty' }, 'Gone.')); return; }

  v.append(el('h2', {}, n.label || n.id, ' ', el('span', { class: 'sub' }, n.id)));
  v.append(rawHint(
    '<b>id</b> should be guessable while you are standing in front of the hardware. Renaming one here rewrites every cable that points at it, so it is safe, but avoid putting an IP or a shelf position in it since those change. ' +
    '<b>parent</b> is containment, not a cable: a drive inside a server, a switch inside a room. Nest as deep as you like. ' +
    '<b>label</b> is what is physically written on the thing; <b>note</b> is the why. ' +
    '<b>type</b> is free text with one exception: the exact value <code>location</code> is ' +
    'load-bearing, and is what makes a node act as a place in the Locations tree and as a ' +
    'column in the Graph. <code>Location</code> or <code>room</code> will not.'));

  const parents = ['', ...S.inv.nodes.filter(x => x !== n && !isDescendant(x.id, n.id)).map(x => x.id).sort()];
  const idIn = el('input', { value: n.id });
  idIn.onchange = () => {
    const want = idIn.value.trim();
    if (want === n.id) return;
    // A colon would break every ref, since a ref is node:port split on the
    // first colon. Uppercase and spaces just make ids unguessable.
    if (!/^[a-z0-9][a-z0-9._/-]*$/.test(want)) {
      idIn.value = n.id;
      alertDlg('Not a valid id',
        'Use lowercase letters, digits, dot, dash, underscore, and / for namespacing. ' +
        'A colon is not allowed: refs are written node:port and would break.');
      return;
    }
    if (nodeById(want)) { idIn.value = n.id; alertDlg('Already exists', `"${want}" is taken.`); return; }
    renameNode(n.id, want);
  };

  v.append(el('div', { class: 'grid2' },
    field('id', idIn),
    field('label', bind(n, 'label')),
    field('type', typeInput(n)),
    field('virtual', virtualToggle(n)),
    field('hostname', bind(n, 'hostname')),
    field('parent', select(parents, n.parent, val => { n.parent = val; touched(); }, id => {
      const p = nodeById(id); return p ? `${p.label || p.id} (${id})` : '(none)';
    })),
    field('note', bind(n, 'note')),
  ));

  v.append(el('h3', {}, 'meta'));
  v.append(rawHint(
    'Anything you want, never validated. Useful here: <code>vendor</code> <code>model</code> <code>serial</code> ' +
    '<code>watts</code> <code>volts_in</code> <code>volts_out</code> <code>speed</code> <code>pcie_gen</code> ' +
    '<code>resolution</code> <code>poe_standard</code> <code>capacity</code> <code>purchased</code> ' +
    '<code>ansible_host</code>. Numbers stay numbers. Put facts here rather than in the label, so ' +
    '"12V 3A" is greppable instead of buried in prose.'));
  v.append(metaEditor(n, 'node'));

  v.append(el('h3', {}, `pluggables (${n.pluggables.length})`));
  v.append(rawHint(
    'Ports where a cable can land. <b>type</b> is load-bearing: a cable is only allowed between two ports of the same type. ' +
    '<b>dir</b> is for one-way connectors, where <code>out</code> is the providing side. A UPS outlet, a motherboard SATA port ' +
    'and a PSU brick tip are all <code>out</code>; a device inlet is <code>in</code>. Leave dir blank for symmetric things like ethernet. ' +
    'Getting dir right is what stops the connect picker offering you a socket you cannot actually use.'));
  if (!n.pluggables.length) v.append(el('div', { class: 'faint' }, 'none'));
  else {
    const rows = n.pluggables.map(p => {
      const ref = n.id + ':' + p.id;
      const cables = Core.cablesAt(ix, ref);
      const blocked = ix.blockedBy.get(ref);
      const left = Core.slotsLeft(ix, n.id, p);
      const statusCell = el('td', {});
      for (const l of cables) {
        statusCell.append(el('div', {},
          refLink(Core.peerOf(l, ref)), ' ',
          el('button', { title: 'unplug just this cable', onclick: () => removeLink(l) }, 'unplug')));
      }
      if (blocked && !cables.length) {
        statusCell.append(el('span', { class: 'chip blocked' }, 'blocked'), ' ',
          el('span', { class: 'faint' }, 'by '), refLink(blocked.a), el('span', { class: 'faint' }, ' ↔ '), refLink(blocked.b));
      } else if (left > 0) {
        statusCell.append(el('div', {},
          el('span', { class: 'chip free' }, cables.length ? `${left} of ${Core.capacity(p)} free` : 'free'), ' ',
          el('button', { onclick: () => pickPeer(ix, ref, p) }, 'connect'), ' ',
          el('button', { title: 'a plug physically covers this socket', onclick: () => markBlocked(ix, n, p) }, 'blocked?')));
      }
      S.openPorts = S.openPorts || new Set();
      const open = S.openPorts.has(ref);
      const extras = [];
      if (p.mac) extras.push('mac');
      if ((p.ips || []).length) extras.push(`${p.ips.length} ip`);
      if (p.untagged) extras.push('vlan ' + p.untagged);
      if ((p.tagged || []).length) extras.push(`+${p.tagged.length} tagged`);
      if (p.fanout > 1) extras.push('fanout ' + p.fanout);
      if (p.meta) extras.push('meta');

      const idCell = el('input', { value: p.id, style: 'width:70px' });
      idCell.onchange = () => {
        const want = idCell.value.trim();
        if (want === p.id) return;
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(want)) {
          idCell.value = p.id;
          alertDlg('Not a valid port id', 'Letters, digits, dot, dash and underscore. No colon: a ref is node:port.');
          return;
        }
        if (n.pluggables.some(q => q !== p && q.id === want)) {
          idCell.value = p.id;
          alertDlg('Already exists', `${n.id} already has a port called "${want}".`);
          return;
        }
        renamePort(n, p, want);
      };
      const main = el('tr', {},
        el('td', {}, idCell),
        el('td', {}, select(PORT_TYPES, p.type, val => { p.type = val; touched(); })),
        el('td', {}, select(['', 'in', 'out'], p.dir, val => { p.dir = val; touched(); }, x => x || '—')),
        statusCell,
        el('td', {}, inline(p, 'label', 90)),
        el('td', {},
          el('button', {
            onclick: () => { open ? S.openPorts.delete(ref) : S.openPorts.add(ref); render(); },
          }, open ? '▾ less' : '▸ more'),
          extras.length ? el('span', { class: 'faint' }, ' ' + extras.join(', ')) : null),
        el('td', { class: 'right' }, el('button', {
        title: 'remove this pluggable',
        onclick: async () => {
          const loses = [];
          if (ix.usedBy.has(ref)) loses.push('its cable');
          if (p.mac || (p.ips || []).length) loses.push('mac/ip');
          if (p.untagged || (p.tagged || []).length) loses.push('vlan membership');
          if (p.meta) loses.push('meta');
          if (loses.length && await choose('Remove pluggable',
            `${ref} would also lose ${loses.join(', ')}. Ctrl+Z undoes this.`,
            [{ id: 'yes', label: 'Remove', primary: true }]) !== 'yes') return;
          removePort(n, p);
        },
      }, '×')),
      );
      if (!open) return [main];

      const csv = (obj, key, width, parse) => {
        const inp = el('input', { value: (obj[key] || []).join(', '), style: `width:${width}px` });
        inp.onchange = () => {
          obj[key] = inp.value.split(',').map(x => x.trim()).filter(Boolean)
            .map(parse || (x => x)).filter(x => x !== 0);
          touchedSoft();
        };
        return inp;
      };
      const numIn = (obj, key, width) => {
        const inp = el('input', { value: obj[key] ? String(obj[key]) : '', style: `width:${width}px` });
        inp.onchange = () => { obj[key] = parseInt(inp.value, 10) || 0; touchedSoft(); };
        return inp;
      };
      const vlanNote = S.inv.vlans.length ? '' : ' (define VLANs first in the VLANs view)';
      const detail = el('tr', {}, el('td', { colspan: 7, style: 'padding:8px 0 14px 12px' },
        el('div', { class: 'grid2' },
          field('mac', inline(p, 'mac', 170)),
          field('ips', csv(p, 'ips', 260)),
          field('untagged vlan', vlanPicker(p, 'untagged')),
          field('tagged vlans', vlanPicker(p, 'tagged')),
          field('fanout', numIn(p, 'fanout', 70)),
          field('note', inline(p, 'note', 300)),
        ),
        el('div', { class: 'hint' },
          'mac and ips belong here rather than on the device, since a multi-NIC box has one of each per port. ' +
          'fanout above 1 lets this port carry that many cables, for a splitter you would rather not model as a node.' + vlanNote),
        el('div', { class: 'faint', style: 'margin:6px 0 2px' }, 'port meta'),
        metaEditor(p, 'pluggable')));
      return [main, detail];
    });
    v.append(el('table', {},
      el('thead', {}, el('tr', {}, ...['id', 'type', 'dir', 'connected', 'label', 'detail', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, ...rows.flat()),
    ));
  }
  v.append(el('div', { style: 'margin-top:10px;display:flex;gap:8px' },
    el('button', { onclick: () => addPort(n) }, '+ pluggable'),
    el('button', { onclick: () => addPortsBulk(n) }, '+ many…'),
    el('button', { onclick: () => duplicateNode(n) }, 'duplicate'),
    el('button', { onclick: () => saveAsTemplate(n) }, 'save as template'),
    el('button', {
      onclick: async () => {
        const cables = S.inv.links.filter(l =>
          n.pluggables.some(p => l.a === n.id + ':' + p.id || l.b === n.id + ':' + p.id)).length;
        const children = S.inv.nodes.filter(x => x.parent === n.id);
        const blocks = S.inv.links.filter(l =>
          l.blocks.some(b => n.pluggables.some(p => b === n.id + ':' + p.id))).length;
        const parts = [`${n.pluggables.length} port(s)`];
        if (cables) parts.push(`${cables} cable(s)`);
        if (blocks) parts.push(`${blocks} blocks entry(s)`);
        const opts = [];
        if (children.length && n.parent) {
          opts.push({ id: 'reparent', label: `Delete, move ${children.length} child(ren) up`, primary: true });
        }
        opts.push({ id: 'yes', label: children.length ? `Delete, orphan ${children.length} child(ren)` : 'Delete', primary: !children.length || !n.parent });
        const msg = `Deleting ${n.id} also removes ${parts.join(', ')}.` +
          (children.length ? ` ${children.length} node(s) live inside it and would lose their parent.` : '') +
          ' Ctrl+Z undoes this.';
        const c = await choose('Delete node', msg, opts);
        if (c === 'reparent') deleteNode(n.id, n.parent);
        else if (c === 'yes') deleteNode(n.id);
      },
    }, 'delete node'),
  ));

  const kids = S.inv.nodes.filter(x => x.parent === n.id);
  if (kids.length) {
    v.append(el('h3', {}, `contains (${kids.length})`));
    v.append(el('table', {}, el('tbody', {}, ...kids.map(k => el('tr', {},
      el('td', {}, el('a', { href: '#', onclick: e => { e.preventDefault(); S.sel = { kind: 'node', id: k.id }; render(); } }, k.label || k.id)),
      el('td', { class: 'faint' }, k.type),
      el('td', { class: 'faint' }, k.id),
    )))));
  }
}

function isDescendant(candidate, ancestor) {
  let cur = nodeById(candidate), guard = 0;
  while (cur && cur.parent && guard++ < 10000) {
    if (cur.parent === ancestor) return true;
    cur = nodeById(cur.parent);
  }
  return false;
}

// A plain text edit changes no structure, so it must NOT rebuild the view: a
// synchronous re-render on blur destroys the element the browser was about to
// focus, which makes Tab-through data entry impossible and resets scroll.
function touchedSoft() {
  if (lastSnap !== null) {
    S.undo.push(lastSnap);
    if (S.undo.length > UNDO_MAX) S.undo.shift();
    S.redo = [];
  }
  lastSnap = snapshot();
  S.dirty = true;
  saveDraft();
  renderHeader(Core.validate(S.inv, FIELD_BY_ID));
}

function bind(obj, key, tag = 'input') {
  const n = el(tag, tag === 'input' ? { value: obj[key] || '' } : { rows: 2 });
  if (tag === 'textarea') n.value = obj[key] || '';
  n.onchange = () => { obj[key] = n.value; touchedSoft(); };
  return n;
}
function inline(obj, key, width) {
  const n = el('input', { value: obj[key] || '', style: `width:${width}px` });
  n.onchange = () => { obj[key] = n.value; touchedSoft(); };
  return n;
}
function select(opts, cur, onchange, fmt = x => x || '—') {
  const s = el('select');
  const list = opts.includes(cur) ? opts : [cur, ...opts];
  for (const o of list) s.append(el('option', { value: o, selected: o === cur }, fmt(o)));
  s.onchange = () => onchange(s.value);
  return s;
}

// keep numbers as numbers so `volts: 12` does not become a string
function coerce(v) {
  const t = v.trim();
  // Only when the round trip is exact, so "0123456" stays the serial it is and
  // does not silently become 123456.
  if (t !== '' && /^[-+]?[\d.]+$/.test(t) && String(Number(t)) === t) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  return v;
}

// Typing vlan ids into a comma-separated box turned a slip into vlan 0, which
// then vanished on reload. Offer only the VLANs that exist.
function vlanPicker(port, which) {
  const defined = S.inv.vlans.slice().sort((a, b) => a.id - b.id);
  if (!defined.length) {
    return el('span', { class: 'faint' },
      'no VLANs defined yet — add them in the VLANs view');
  }
  if (which === 'untagged') {
    const sel = el('select');
    sel.append(el('option', { value: '0', selected: !port.untagged }, '— none —'));
    for (const v of defined) {
      sel.append(el('option', { value: String(v.id), selected: port.untagged === v.id },
        v.id + (v.name ? ' ' + v.name : '')));
    }
    sel.onchange = () => { port.untagged = parseInt(sel.value, 10) || 0; touchedSoft(); };
    return sel;
  }
  const box = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
  for (const v of defined) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = (port.tagged || []).includes(v.id);
    cb.onchange = () => {
      const set = new Set(port.tagged || []);
      if (cb.checked) set.add(v.id); else set.delete(v.id);
      port.tagged = [...set].sort((a, b) => a - b);
      touchedSoft();
    };
    box.append(el('label', { style: 'display:inline-flex;align-items:center;gap:3px' },
      cb, el('span', {}, v.id + (v.name ? ' ' + v.name : ''))));
  }
  return box;
}

// Marking a dead socket used to mean: go to Cables, find the right row among
// dozens, then scroll an unfiltered list of every port in the inventory. This
// does it from the port you are already looking at.
function markBlocked(ix, node, port) {
  const ref = node.id + ':' + port.id;
  const cables = S.inv.links.filter(l => ix.portByRef.has(l.a) || ix.portByRef.has(l.b));
  const near = cables.filter(l =>
    Core.splitRef(l.a)[0] === node.id || Core.splitRef(l.b)[0] === node.id);
  const rest = cables.filter(l => !near.includes(l));

  $('dlgHead').textContent = 'What blocks ' + ref + '?';
  const body = $('dlgBody'); body.replaceChildren();
  body.append(rawHint(
    'Pick the cable whose plug physically covers this socket. It gets recorded on that ' +
    'cable, because the obstruction belongs to the connection rather than to either end. ' +
    'Cables on <b>this</b> node are listed first, which is the answer almost every time.'));
  const list = el('div', {});
  const add = (l, tag) => list.append(el('div', {
    class: 'opt',
    onclick: () => {
      l.blocks = [...new Set([...l.blocks, ref])];
      closeDlg(); touched(); toast('marked blocked');
    },
  }, `${l.a} <-> ${l.b}`, tag ? el('span', { class: 'faint' }, '  ' + tag) : null));
  for (const l of near) add(l, 'this node');
  for (const l of rest) add(l, '');
  if (!cables.length) body.append(el('div', { class: 'faint' }, 'No cables recorded yet.'));
  body.append(list);
  $('dlgFoot').replaceChildren(el('button', { onclick: closeDlg }, 'Cancel'));
  openDlg();
}

function pickPeer(ix, ref, port) {
  const cands = [];
  for (const n of S.inv.nodes) {
    for (const p of n.pluggables) {
      const r = n.id + ':' + p.id;
      if (r === ref || ix.blockedBy.has(r)) continue;
      if (Core.slotsLeft(ix, n.id, p) <= 0) continue;
      if (!Core.compatible(port, p)) continue;
      cands.push({ ref: r, node: n, port: p });
    }
  }
  $('dlgHead').textContent = `Connect ${ref}`;
  const body = $('dlgBody'); body.replaceChildren();
  body.append(el('div', { class: 'hint' },
    'Only ports that are free and physically compatible are listed, so anything you can click here is a cable you could actually plug in.'));
  if (!cands.length) {
    body.append(el('div', { class: 'muted' },
      `Nothing compatible and free. Needs type "${port.type}"` +
      (port.dir ? ` with dir "${port.dir === 'in' ? 'out' : 'in'}"` : ' with no dir') + '.'));
  } else {
    const search = el('input', { placeholder: 'filter…', style: 'width:100%;margin-bottom:8px' });
    const list = el('div', {});
    const paint = () => {
      const q = search.value.toLowerCase();
      list.replaceChildren(...cands
        .filter(c => !q || c.ref.toLowerCase().includes(q) || (c.node.label || '').toLowerCase().includes(q))
        .map(c => el('div', {
          class: 'opt',
          onclick: () => { closeDlg(); connect(ref, c.ref); },
        }, c.ref, c.node.label ? el('span', { class: 'faint' }, `  ${c.node.label}`) : null)));
    };
    search.oninput = paint; paint();
    body.append(search, list);
    queueMicrotask(() => search.focus());
  }
  $('dlgFoot').replaceChildren(el('button', { onclick: closeDlg }, 'Cancel'));
  openDlg();
}

function renderProblems(v, probs) {
  v.append(el('h2', {}, 'Problems'));
  const errs = probs.filter(p => !p.warn), warns = probs.filter(p => p.warn);
  if (!probs.length) { v.append(el('div', { class: 'empty' }, 'Nothing wrong.')); return; }
  v.append(el('div', { class: 'muted', style: 'margin-bottom:10px' },
    'Errors are contradictions and cannot be fixed by adding more data. Warnings are things that finishing your entry will resolve.'));
  for (const p of [...errs, ...warns]) {
    v.append(el('div', { class: 'prob ' + (p.warn ? 'w' : 'e') },
      el('span', { class: 'k' }, p.warn ? 'warn' : 'error'), p.msg));
  }
}

function renderFree(v, ix) {
  v.append(el('h2', {}, 'Free ports'));
  v.append(rawHint(
    'The answer to "I am holding a cable, where can it go". <b>Blocked</b> means physically unusable rather than ' +
    'occupied, which is the wall-wart case: a brick plugged into outlet 1 overhangs and eats outlet 2. Record that on the cable ' +
    'in the Cables view and the dead socket stops being offered to you here.'));
  const rows = [];
  let nfree = 0, nblocked = 0;
  for (const n of S.inv.nodes) {
    if (n.virtual) continue;   // a vNIC is not a socket a cable can go into
    const byKind = new Map();
    for (const p of n.pluggables) {
      const ref = n.id + ':' + p.id;
      const left = Core.slotsLeft(ix, n.id, p);
      if (ix.blockedBy.has(ref) && !Core.cablesAt(ix, ref).length) { nblocked++; continue; }
      if (left <= 0) continue;
      nfree++;
      const k = Core.kind(p);
      if (!byKind.has(k)) byKind.set(k, []);
      const tag = (p.label && p.label !== p.id ? `${p.id} ("${p.label}")` : p.id) +
        (Core.capacity(p) > 1 ? ` [${left}/${Core.capacity(p)}]` : '');
      byKind.get(k).push(tag);
    }
    for (const [k, list] of byKind) {
      rows.push(el('tr', {},
        el('td', {}, el('a', { href: '#', onclick: e => { e.preventDefault(); S.sel = { kind: 'node', id: n.id }; render(); } }, n.id)),
        el('td', {}, el('span', { class: 'chip ' + k.split('/')[0] }, k)),
        el('td', {}, list.join(', ')),
      ));
    }
  }
  v.append(el('div', { class: 'muted' }, `${nfree} free, ${nblocked} blocked`));
  if (!rows.length) v.append(el('div', { class: 'empty' }, 'Everything is plugged in.'));
  else v.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['node', 'kind', 'ports'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...rows)));

  const bl = [];
  for (const [ref, l] of ix.blockedBy) bl.push(el('tr', {},
    el('td', {}, ref), el('td', { class: 'faint' }, `${l.a} ↔ ${l.b}`), el('td', { class: 'faint' }, l.note || '')));
  if (bl.length) {
    v.append(el('h3', {}, 'blocked, not free'));
    v.append(el('table', {}, el('thead', {}, el('tr', {}, ...['port', 'blocked by', 'why'].map(h => el('th', {}, h)))),
      el('tbody', {}, ...bl)));
  }
}

function renderCables(v, ix) {
  v.append(el('h2', {}, 'Cables'));
  v.append(rawHint(
    'One row per physical cable. <b>label</b> is the tag on the cable itself, so put it here rather than on both ports where it ' +
    'would drift. <b>poe</b> marks an ethernet run that also carries power, which is how "what feeds the AP" stays answerable. ' +
    '<b>blocks</b> lists sockets this connection makes unusable, typically a brick overhanging its neighbour.'));
  if (!S.inv.links.length) { v.append(el('div', { class: 'empty' }, 'None yet.')); return; }
  const rows = S.inv.links
    .slice()
    .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0))
    .map(l => {
      const poe = el('input', { type: 'checkbox' });
      poe.checked = l.poe;
      poe.onchange = () => { l.poe = poe.checked; touched(); };
      return el('tr', {},
        el('td', {}, l.a), el('td', {}, l.b),
        el('td', {}, inline(l, 'label', 110)),
        el('td', {}, poe),
        el('td', {}, el('button', { onclick: () => blocksEditor(l) }, `blocks (${l.blocks.length})`)),
        el('td', {}, inline(l, 'note', 170)),
        el('td', { class: 'right' }, el('button', {
          title: 'unplug this cable',
          onclick: () => { removeLink(l); },
        }, '×')),
      );
    });
  v.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['a', 'b', 'label', 'poe', 'blocks', 'note', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, ...rows)));
}

function blocksEditor(l) {
  $('dlgHead').textContent = 'Ports this cable makes unusable';
  const body = $('dlgBody'); body.replaceChildren();
  body.append(el('div', { class: 'muted', style: 'margin-bottom:8px' },
    'Typically a brick overhanging the next outlet. Anything ticked is reported as blocked rather than free.'));
  const all = [];
  for (const n of S.inv.nodes) for (const p of n.pluggables) all.push(n.id + ':' + p.id);
  const used = new Set(S.inv.links.flatMap(x => [x.a, x.b]));
  const ends = new Set([Core.splitRef(l.a)[0], Core.splitRef(l.b)[0]]);
  const eligible = all.filter(r => !used.has(r) || l.blocks.includes(r));
  body.append(el('div', { class: 'faint', style: 'margin-bottom:6px' },
    `${used.size} port(s) already carry a cable and so cannot also be blocked; ` +
    'they are not listed. Ports on this cable\'s own nodes are shown first.'));
  const search = el('input', { placeholder: 'filter…', style: 'width:100%;margin-bottom:8px' });
  const list = el('div', {});
  const paint = () => {
    const q = search.value.toLowerCase();
    const shown = eligible.filter(r => !q || r.toLowerCase().includes(q));
    shown.sort((a, b) => {
      const na = ends.has(Core.splitRef(a)[0]) ? 0 : 1;
      const nb = ends.has(Core.splitRef(b)[0]) ? 0 : 1;
      return na - nb || (a < b ? -1 : 1);
    });
    list.replaceChildren(...shown.slice(0, 200).map(ref => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = l.blocks.includes(ref);
      cb.onchange = () => {
        l.blocks = cb.checked ? [...l.blocks, ref] : l.blocks.filter(x => x !== ref);
        touched();
      };
      return el('label', { class: 'opt', style: 'display:block' }, cb, ' ', ref,
        ends.has(Core.splitRef(ref)[0]) ? el('span', { class: 'faint' }, '  same node') : null);
    }));
    if (shown.length > 200) list.append(el('div', { class: 'faint' }, `showing 200 of ${shown.length}, filter to narrow`));
  };
  search.oninput = paint; paint();
  body.append(search, list);
  $('dlgFoot').replaceChildren(el('button', { class: 'btn-primary', onclick: closeDlg }, 'Done'));
  openDlg();
}

function renderYaml(v) {
  v.append(el('h2', {}, 'YAML', ' ', el('span', { class: 'sub' }, 'exactly what Save writes')));
  let text;
  try { text = currentYaml(); }
  catch (e) { v.append(el('div', { class: 'prob e' }, String(e.message || e))); return; }
  v.append(el('div', { style: 'margin:8px 0' },
    el('button', { onclick: () => { navigator.clipboard?.writeText(text); toast('copied'); } }, 'copy')));
  v.append(el('pre', { style: 'white-space:pre-wrap;background:var(--panel);padding:10px;border:1px solid var(--line);border-radius:6px' }, text));
}

/* ---- vlans -------------------------------------------------------------- */
function renderVlans(v) {
  v.append(el('h2', {}, 'VLANs'));
  v.append(rawHint(
    'Defined once here, then referenced from a port as <b>untagged</b> (native) or <b>tagged</b> (trunked). ' +
    'A VLAN never creates a second cable: one cable stays one cable, and the logical connections riding it are worked ' +
    'out from what both ends carry. That is why a tag on one end and not the other shows up as a warning instead of ' +
    'quietly looking fine.'));

  if (!S.inv.vlans.length) v.append(el('div', { class: 'empty' }, 'None defined.'));
  else {
    const rows = S.inv.vlans.slice().sort((a, b) => a.id - b.id).map(vl => {
      const idIn = el('input', { value: String(vl.id), style: 'width:70px' });
      idIn.onchange = () => {
        const next = parseInt(idIn.value, 10);
        if (!Number.isFinite(next) || next < 1 || next > 4094) {
          idIn.value = String(vl.id);
          alertDlg('Not a VLAN id', 'Must be a whole number between 1 and 4094.');
          return;
        }
        if (next !== vl.id && S.inv.vlans.some(x => x !== vl && x.id === next)) {
          idIn.value = String(vl.id);
          alertDlg('Already in use', `VLAN ${next} is already defined.`);
          return;
        }
        // remap every port that referenced the old id, the same way renameNode
        // remaps refs. Without this the ports silently orphan.
        const from = vl.id;
        vl.id = next;
        for (const n of S.inv.nodes) for (const p of n.pluggables) {
          if (p.untagged === from) p.untagged = next;
          p.tagged = (p.tagged || []).map(x => (x === from ? next : x));
        }
        touched();
      };
      const users = [];
      for (const n of S.inv.nodes) for (const p of n.pluggables) {
        if (p.untagged === vl.id) users.push(`${n.id}:${p.id} (untagged)`);
        else if ((p.tagged || []).includes(vl.id)) users.push(`${n.id}:${p.id}`);
      }
      return el('tr', {},
        el('td', {}, idIn),
        el('td', {}, inline(vl, 'name', 110)),
        el('td', {}, inline(vl, 'subnet', 130)),
        el('td', {}, inline(vl, 'note', 170)),
        el('td', { class: 'faint' }, users.length ? `${users.length} port${users.length > 1 ? 's' : ''}` : 'unused'),
        el('td', { class: 'right' }, el('button', {
          onclick: async () => {
            if (users.length && await choose('Delete VLAN',
              `vlan ${vl.id} is referenced by ${users.length} port(s). Delete it anyway? Those ports keep the id and will warn.`,
              [{ id: 'yes', label: 'Delete', primary: true }]) !== 'yes') return;
            S.inv.vlans = S.inv.vlans.filter(x => x !== vl); touched();
          },
        }, '×')),
      );
    });
    v.append(el('table', {},
      el('thead', {}, el('tr', {}, ...['id', 'name', 'subnet', 'note', 'used by', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, ...rows)));
  }
  v.append(el('button', {
    style: 'margin-top:10px',
    onclick: () => {
      let id = 10; while (S.inv.vlans.some(x => x.id === id)) id++;
      S.inv.vlans.push({ id, name: '', subnet: '', note: '', meta: null, src: S.name });
      touched();
    },
  }, '+ vlan'));
}

/* ---- containment tree --------------------------------------------------- */
function renderTree(v, ix) {
  v.append(el('h2', {}, 'Tree'));
  v.append(rawHint(
    'Containment at any depth: places hold devices, devices hold cards and drives. This is the <b>parent</b> relation, ' +
    'not cabling, so a drive shows under its server even though the cable is a separate thing. Use it to answer ' +
    '"what is physically inside this"; use Graph to answer "what is plugged into this". ' +
    'Guests marked <b>virtual</b> appear under the machine they run on, which answers "what dies if this host ' +
    'dies", but are left out of the free-port report and the graph since they have no sockets.'));

  const kids = new Map();
  for (const n of S.inv.nodes) {
    const k = ix.nodeById.has(n.parent) ? n.parent : '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(n);
  }
  for (const list of kids.values()) list.sort((a, b) => (a.type === 'location' ? 0 : 1) - (b.type === 'location' ? 0 : 1) || (a.id < b.id ? -1 : 1));

  S.collapsed = S.collapsed || new Set();
  const box = el('div', {});
  let shown = 0;

  const summarise = n => {
    const bits = [];
    if (n.hostname) bits.push(n.hostname);
    const ips = n.pluggables.flatMap(p => p.ips || []);
    if (ips.length) bits.push(ips.join(', '));
    for (const k of ['cpu', 'ram', 'storage', 'gpu', 'model', 'watts', 'volts', 'capacity', 'resolution']) {
      const val = n.meta && n.meta[k];
      if (val !== undefined && val !== '' && String(val) !== 'TODO') bits.push(`${k} ${val}`);
    }
    const ports = n.pluggables.length;
    if (ports) {
      const free = n.pluggables.filter(p =>
        Core.slotsLeft(ix, n.id, p) > 0 && !ix.blockedBy.has(n.id + ':' + p.id)).length;
      bits.push(`${ports} port${ports > 1 ? 's' : ''}, ${free} free`);
    }
    return bits;
  };

  const walk = (parent, depth) => {
    for (const n of (kids.get(parent) || [])) {
      shown++;
      const children = kids.get(n.id) || [];
      const open = !S.collapsed.has(n.id);
      const row = el('div', {
        style: `display:flex;gap:8px;align-items:baseline;padding:2px 0 2px ${depth * 18}px;border-bottom:1px solid #22252c`,
      });
      row.append(el('span', {
        style: 'width:14px;color:var(--dim2);cursor:pointer;user-select:none',
        onclick: () => {
          if (!children.length) return;
          if (open) S.collapsed.add(n.id); else S.collapsed.delete(n.id);
          render();
        },
      }, children.length ? (open ? '▾' : '▸') : '·'));
      row.append(el('a', {
        href: '#', style: 'text-decoration:none',
        onclick: e => { e.preventDefault(); S.sel = { kind: 'node', id: n.id }; render(); },
      }, n.label || n.id));
      if (n.type) row.append(el('span', { class: 'chip' }, n.type));
      if (n.virtual) row.append(el('span', { class: 'chip', title: 'no physical presence' }, 'virtual'));
      const bits = summarise(n);
      if (bits.length) row.append(el('span', { class: 'faint' }, bits.join(' · ')));
      box.append(row);
      if (open) walk(n.id, depth + 1);
    }
  };
  walk('', 0);
  v.append(box);
  if (!shown) v.append(el('div', { class: 'empty' }, 'Nothing yet.'));
  else v.append(el('div', { class: 'faint', style: 'margin-top:8px' }, `${shown} of ${S.inv.nodes.length} nodes shown`));
}

/* ---- graph -------------------------------------------------------------- */
// Laid out by containment rather than force-directed: one column per location,
// nodes stacked inside it, cables as curves between the actual ports. A force
// layout on 30 nodes looks like spaghetti; this stays readable because the data
// already has a hierarchy to lean on.
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, val] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), val);
    else if (val != null) n.setAttribute(k, val);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};
const WIRE = { eth: '#6ea8fe', power: '#f0c674', usb: '#b8a2e3', hdmi: '#5dd39e', dp: '#5dd39e', sata: '#e08a5f', pcie: '#e08a5f' };
const GFONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const BOX_W = 196, HEAD_H = 24, ROW_H = 15, PAD_Y = 26, COL_GAP = 118;
const BG = '#1b1e24';

function renderGraph(v, ix) {
  v.append(el('h2', {}, 'Graph'));
  v.append(rawHint(
    'One column per location, nodes stacked inside. Every line is a real cable between two real ports, so a chain like ' +
    'outlet -> PSU brick -> device reads left to right. Dashed thick lines carry PoE. Scroll to zoom, drag to pan, ' +
    'click a node to open it. Zoom is <b>ctrl+wheel</b>, so a plain scroll still moves the page.'));

  S.gfilter = S.gfilter || 'all';
  const bar = el('div', { style: 'display:flex;gap:6px;margin:8px 0;align-items:center;flex-wrap:wrap' });
  for (const f of ['all', 'eth', 'power', 'other']) {
    bar.append(el('button', {
      class: S.gfilter === f ? 'btn-primary' : '',
      onclick: () => { S.gfilter = f; render(); },
    }, f));
  }
  bar.append(el('span', { class: 'faint', style: 'margin-left:6px' }, 'legend'));
  for (const k of ['eth', 'power', 'usb', 'hdmi']) {
    bar.append(el('span', { class: 'chip', style: 'color:' + WIRE[k] + ';border-color:' + WIRE[k] + '55' }, k));
  }

  // which location does a node live in
  const locOf = n => {
    let cur = n, guard = 0;
    while (cur && guard++ < 10000) {
      if (cur.type === 'location') return cur.id;
      cur = ix.nodeById.get(cur.parent);
    }
    return '';
  };

  const locs = S.inv.nodes.filter(n => n.type === 'location');
  const isLoc = id => locs.some(l => l.id === id);
  const order = [];
  (function walk(parent) {
    for (const l of locs) {
      const p = isLoc(l.parent) ? l.parent : '';
      if (p === parent && !order.includes(l)) { order.push(l); walk(l.id); }
    }
  })('');
  for (const l of locs) if (!order.includes(l)) order.push(l);
  const colIds = [...order.map(l => l.id), ''];

  const wanted = l => {
    if (S.gfilter === 'all') return true;
    const p = ix.portByRef.get(l.a);
    const t = p ? p.port.type : '';
    if (S.gfilter === 'other') return t !== 'eth' && t !== 'power';
    return t === S.gfilter;
  };
  const links = S.inv.links.filter(l => ix.portByRef.has(l.a) && ix.portByRef.has(l.b) && wanted(l));
  const live = new Set(links.flatMap(l => [l.a, l.b]));

  const place = new Map();
  let maxY = 0;
  colIds.forEach((cid, ci) => {
    const members = S.inv.nodes.filter(n => n.type !== 'location' && !n.virtual && locOf(n) === cid);
    let y = 46;
    for (const n of members) {
      const shown = n.pluggables.filter(p => live.has(n.id + ':' + p.id));
      const h = HEAD_H + Math.max(shown.length, 1) * ROW_H + 8;
      place.set(n.id, { n, x: ci * (BOX_W + COL_GAP) + 12, y, h, shown });
      y += h + PAD_Y;
    }
    maxY = Math.max(maxY, y);
  });

  if (!place.size) {
    v.append(bar);
    v.append(el('div', { class: 'empty' }, 'Nothing to draw yet. Add some nodes and cables.'));
    return;
  }

  const width = colIds.length * (BOX_W + COL_GAP) + 24;
  const height = Math.max(maxY + 20, 240);

  const g = svgEl('g');
  for (const l of links) {
    const A = anchorOf(place, l.a), B = anchorOf(place, l.b);
    if (!A || !B) continue;
    const t = ix.portByRef.get(l.a).port.type;
    const from = B.x >= A.x ? A.right : A.left;
    const to = B.x >= A.x ? B.left : B.right;
    const dx = Math.max(40, Math.abs(to - from) * 0.42);
    const dir = B.x >= A.x ? 1 : -1;
    const d = 'M' + from + ',' + A.y + ' C' + (from + dx * dir) + ',' + A.y +
      ' ' + (to - dx * dir) + ',' + B.y + ' ' + to + ',' + B.y;
    g.append(svgEl('path', {
      d, fill: 'none', stroke: WIRE[t] || '#7f8794',
      'stroke-width': l.poe ? 2.4 : 1.4,
      'stroke-dasharray': l.poe ? '5 3' : null,
      opacity: '0.85',
    }, svgEl('title', {}, l.a + ' <-> ' + l.b + (l.poe ? ' (PoE)' : '') + (l.label ? ' | ' + l.label : ''))));
  }

  colIds.forEach((cid, ci) => {
    const loc = ix.nodeById.get(cid);
    g.append(svgEl('text', {
      x: ci * (BOX_W + COL_GAP) + 12, y: 26,
      fill: '#6b7482', 'font-size': '11', 'font-family': GFONT,
    }, (loc ? (loc.label || loc.id) : 'no location').toUpperCase()));
  });

  for (const b of place.values()) {
    const { n, x, y, h, shown } = b;
    const selected = S.sel.kind === 'node' && S.sel.id === n.id;
    const box = svgEl('g', {
      style: 'cursor:pointer',
      onclick: () => { S.sel = { kind: 'node', id: n.id }; render(); },
    });
    box.append(svgEl('rect', {
      x, y, width: BOX_W, height: h, rx: '6',
      fill: selected ? '#24405f' : '#21252d', stroke: selected ? '#6ea8fe' : '#2c313b',
    }));
    box.append(svgEl('text', {
      x: x + 9, y: y + 16, fill: '#e4e7ec', 'font-size': '12', 'font-family': GFONT,
    }, trunc(n.label || n.id, 24)));
    const freeCount = n.pluggables.filter(pp => Core.slotsLeft(ix, n.id, pp) > 0).length;
    if (freeCount > 0) {
      box.append(svgEl('text', {
        x: x + BOX_W - 9, y: y + 16, fill: '#5dd39e', 'font-size': '10',
        'font-family': GFONT, 'text-anchor': 'end',
      }, freeCount + ' free'));
    }
    shown.forEach((p, i) => {
      const py = y + HEAD_H + i * ROW_H + 8;
      box.append(svgEl('text', {
        x: x + 12, y: py + 3, fill: '#9aa3b2', 'font-size': '10', 'font-family': GFONT,
      }, trunc(p.id + (p.label && p.label !== p.id ? ' (' + p.label + ')' : ''), 28)));
      for (const cx of [x + 5, x + BOX_W - 5]) {
        box.append(svgEl('circle', { cx, cy: py, r: '2.6', fill: WIRE[p.type] || '#7f8794' }));
      }
    });
    g.append(box);
  }

  const z = S.gz || { k: 1, tx: 0, ty: 0 };
  const apply = () => g.setAttribute('transform', 'translate(' + S.gz.tx + ',' + S.gz.ty + ') scale(' + S.gz.k + ')');
  S.gz = z; apply();

  const root = svgEl('svg', {
    width: '100%', height: Math.min(height, 720),
    viewBox: '0 0 ' + width + ' ' + height,
    style: 'background:' + BG + ';border:1px solid var(--line);border-radius:6px;touch-action:none;display:block',
  }, g);

  // Require a modifier: swallowing every wheel event meant the page could not be
  // scrolled past the diagram.
  root.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    S.gz = { ...S.gz, k: Math.min(4, Math.max(0.25, S.gz.k * (e.deltaY < 0 ? 1.12 : 0.89))) };
    apply();
  }, { passive: false });
  let drag = null;
  root.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, tx: S.gz.tx, ty: S.gz.ty };
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove', e => {
    if (!drag) return;
    const s = width / (root.clientWidth || width);
    S.gz = { k: S.gz.k, tx: drag.tx + (e.clientX - drag.x) * s, ty: drag.ty + (e.clientY - drag.y) * s };
    apply();
  });
  // Without pointercancel a drag interrupted by a context menu left `drag` set,
  // and the graph then panned on plain mouse movement with no button held.
  root.addEventListener('pointerup', () => { drag = null; });
  root.addEventListener('pointercancel', () => { drag = null; });
  root.addEventListener('pointerleave', () => { drag = null; });

  bar.append(el('button', { style: 'margin-left:6px', onclick: () => { S.gz = { k: 1, tx: 0, ty: 0 }; apply(); } }, 'reset view'));
  bar.append(el('button', { onclick: () => exportSvg(root, width, height) }, 'SVG'));
  bar.append(el('button', { onclick: () => exportPng(root, width, height) }, 'PNG'));

  v.append(bar);
  v.append(root);
  v.append(el('div', { class: 'faint', style: 'margin-top:6px' },
    place.size + ' nodes, ' + links.length + ' cables shown' +
    (S.gfilter === 'all' ? '' : ' (filtered to ' + S.gfilter + ')')));
}

function anchorOf(place, ref) {
  const parts = Core.splitRef(ref);
  const b = place.get(parts[0]);
  if (!b) return null;
  const i = b.shown.findIndex(p => p.id === parts[1]);
  if (i < 0) return null;
  const y = b.y + HEAD_H + i * ROW_H + 8;
  return { x: b.x, y, left: b.x + 5, right: b.x + BOX_W - 5 };
}
function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Standalone copy: drop the pan/zoom transform, bake in a background, and use a
// literal font stack, so the file renders the same anywhere rather than relying
// on this page's CSS variables.
function standaloneSvg(root, width, height) {
  const clone = root.cloneNode(true);
  clone.setAttribute('xmlns', SVGNS);
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);
  clone.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  clone.removeAttribute('style');
  clone.setAttribute('font-family', GFONT);
  const inner = clone.querySelector('g');
  if (inner) inner.removeAttribute('transform');
  clone.insertBefore(
    svgEl('rect', { x: 0, y: 0, width, height, fill: BG }),
    clone.firstChild);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}

function stamp() {
  return (S.name || 'inventory').replace(/\.ya?ml$/, '');
}

function exportSvg(root, width, height) {
  const blob = new Blob([standaloneSvg(root, width, height)], { type: 'image/svg+xml' });
  const a = el('a', { href: URL.createObjectURL(blob), download: stamp() + '.svg' });
  a.click(); URL.revokeObjectURL(a.href);
  toast('saved svg');
}

function exportPng(root, width, height) {
  const scale = 2; // retina-ish, keeps the 10px port labels legible
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(standaloneSvg(root, width, height));
  const img = new Image();
  img.onload = () => {
    const c = el('canvas');
    c.width = width * scale; c.height = height * scale;
    const cx = c.getContext('2d');
    cx.fillStyle = BG; cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(img, 0, 0, c.width, c.height);
    c.toBlob(b => {
      const a = el('a', { href: URL.createObjectURL(b), download: stamp() + '.png' });
      a.click(); URL.revokeObjectURL(a.href);
      toast('saved png');
    }, 'image/png');
  };
  img.onerror = () => alertDlg('PNG failed', 'The browser refused to rasterise the diagram. The SVG export always works.');
  img.src = src;
}

/* ---- boot --------------------------------------------------------------- */
$('bOpen').onclick = doOpen;
$('bSave').onclick = doSave;
$('bUndo').onclick = doUndo;
$('bLink').onclick = () => {
  const url = location.href.split('#')[0] + selToHash(S.sel);
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('link copied'));
  else alertDlg('Link', url);
};
$('bRedo').onclick = doRedo;

// Another tab writing the draft means two editors on one document.
window.addEventListener('storage', e => {
  if (e.key === LS_KEY && S.dirty) {
    showBanner([
      el('span', { class: 'grow' },
        'Another tab just autosaved this inventory. Two tabs editing one file will overwrite ' +
        'each other. Close one before saving.'),
      el('button', { onclick: hideBanner }, 'Dismiss'),
    ]);
  }
});
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
$('dlg').addEventListener('close', () => settleDlg(null));

window.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); quickSave(); }
  else if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); }
  else if (k === 'k') {
    e.preventDefault();
    const box = $('nav').querySelector('input');
    if (box) { box.focus(); box.select(); }
  }
});

// Ctrl+S writes straight to the file already open. The overwrite-or-new prompt
// is for the toolbar button; asking on every keystroke-save would be absurd.
async function quickSave() {
  if (!S.loaded) return;
  let text;
  try { text = currentYaml(); }
  catch (err) { alertDlg('Not saved', String(err.message || err)); return; }
  if (canFS && S.handle) await writeHandle(S.handle, text);
  else await doSave();
}

// The handle is remembered but its permission is not, so this offers a one-click
// reconnect instead of making the first Save re-ask where to write.
async function offerReconnect() {
  if (!canFS) return;
  const h = await recallHandle();
  if (!h || typeof h.queryPermission !== 'function') return;
  let state = 'prompt';
  try { state = await h.queryPermission({ mode: 'readwrite' }); } catch { return; }

  const open = async () => {
    try {
      if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        toast('permission declined'); return;
      }
      const f = await h.getFile();
      if (!ingest(await f.text(), f.name)) return;
      S.handle = h; S.mtime = f.lastModified;
      hideBanner(); render(); toast(`reopened ${f.name}`);
    } catch (e) {
      alertDlg('Could not reopen', String(e.message || e) +
        '\n\nThe file may have moved or been deleted. Use Open to pick it again.');
      forgetHandle();
    }
  };

  if (state === 'granted') { await open(); return; }
  showBanner([
    el('span', { class: 'grow' },
      `Last time you were editing ${h.name}. Browsers drop file permission on reload, ` +
      'so it needs one click to reconnect.'),
    el('button', { class: 'btn-primary', onclick: open }, `Reopen ${h.name}`),
    el('button', { onclick: () => { forgetHandle(); hideBanner(); } }, 'Forget it'),
  ]);
}

(function boot() {
  initSettings();
  resetHistory();
  const fromUrl = hashToSel(location.hash);
  const d = loadDraft();
  if (d && d.corrupt) {
    showBanner([
      el('span', { class: 'grow' },
        'An autosaved draft could not be read (' + d.corrupt + '). It has been kept under the ' +
        'localStorage key "' + LS_KEY + ':corrupt" in case you want to recover it by hand.'),
      el('button', { onclick: hideBanner }, 'Dismiss'),
    ]);
  } else if (d && d.yaml) {
    // Deliberately NOT auto-loaded. A draft can be older than the file on disk,
    // and quietly restoring it would make the next save overwrite newer work.
    showBanner([
      el('span', { class: 'grow' },
        `Unsaved draft for ${d.name || 'inventory.yaml'} from ${ago(d.at || Date.now())}. ` +
        'It may be older than the file on disk, so nothing has been loaded yet.'),
      el('button', {
        class: 'btn-primary',
        onclick: () => {
          try {
            S.inv = Core.parse(d.yaml, d.name || 'inventory.yaml');
            S.name = d.name || 'inventory.yaml';
            S.loaded = true; S.dirty = true;
            resetHistory(); hideBanner(); render(); toast('draft restored');
          } catch (e) { alertDlg('Could not restore', String(e.message || e)); }
        },
      }, 'Restore draft'),
      el('button', {
        onclick: async () => {
          if (await choose('Discard draft', 'Throw away the autosaved draft? This cannot be undone.',
            [{ id: 'yes', label: 'Discard', primary: true }]) === 'yes') { discardDraft(); hideBanner(); }
        },
      }, 'Discard'),
      el('button', { onclick: hideBanner }, 'Later'),
    ]);
  }
  // A node link can only resolve once something is loaded, so apply it after.
  if (fromUrl && (fromUrl.kind === 'view' || nodeById(fromUrl.id))) S.sel = fromUrl;
  render();
  // only offer the file if there is no unsaved draft competing for attention
  if (!(d && (d.yaml || d.corrupt))) offerReconnect();
})();
