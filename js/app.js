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
// Free-form types are legal; this is only the list the picker offers. atx is the
// front panel power header, which is what an IP KVM closes to power a machine on
// and off.
const PORT_TYPES = ['eth', 'power', 'usb', 'sata', 'pcie', 'm2', 'sfp', 'hdmi', 'dp', 'dvi',
  'vga', 'atx', 'audio', 'coax', 'serial'];

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

// Record a history entry only if the document actually changed. Pushing
// unconditionally meant an edit that emits the same bytes (adding an empty
// placeholder field, or a change event fired twice for one keystroke) left a
// duplicate on the stack, and the first press of undo then did nothing visible.
function pushHistory() {
  const cur = snapshot();
  if (lastSnap !== null && lastSnap !== cur) {
    S.undo.push(lastSnap);
    if (S.undo.length > UNDO_MAX) S.undo.shift();
    S.redo = [];
  }
  lastSnap = cur;
}

function touched() {
  pushHistory();
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

// Why this page cannot write to a file, in the user's terms. Silently falling
// back to a download every time, with no explanation, reads as the save button
// being broken.
function whyNoFileWrite() {
  if (canFS) return '';
  return location.protocol === 'file:'
    ? 'This page was opened straight off disk as a file:// URL, and browsers do not let those write files.'
    : 'This page is not on a secure origin, and browsers only allow writing files from https or localhost.';
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
  if (!canFS && !download.explained) {
    download.explained = true;
    alertDlg('Saved as a download',
      whyNoFileWrite()
      + ' So Save has put the file in your downloads folder instead, and the copy you opened is untouched.'
      + ' To overwrite the file in place, open this editor over https, then use Open once so the browser'
      + ' gives the page permission to that file.');
  } else {
    toast('downloaded ' + S.name);
  }
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

// Clipboard writes need a secure context and can be refused outright, which is
// the normal case when this is served over plain http on a LAN address or through
// a port-forward. The two call sites got this wrong in opposite directions: one
// said "copied" unconditionally, the other had no catch at all, so a refusal
// became an uncaught error and the user was told nothing. Fall back to showing
// the text pre-selected, so ctrl+c still works.
async function copyText(text, okMsg, title) {
  try {
    if (!navigator.clipboard) throw new Error('no clipboard api');
    await navigator.clipboard.writeText(text);
    toast(okMsg);
    return true;
  } catch {
    $('dlgHead').textContent = title;
    const ta = el('textarea', {
      readonly: true, rows: String(Math.min(18, text.split('\n').length + 1)),
      style: 'width:100%;font:inherit',
    });
    ta.value = text;
    $('dlgBody').replaceChildren(
      el('div', { class: 'hint' },
        'The browser refused clipboard access, which it does unless the page is on ' +
        'https or localhost. The text is selected below, so ctrl+c still works.'),
      ta);
    $('dlgFoot').replaceChildren(el('button', { class: 'btn-primary', onclick: closeDlg }, 'OK'));
    openDlg();
    ta.focus(); ta.select();
    return false;
  }
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
  // Nearly thirty templates across seven groups, so it needs a filter like every
  // other long list here. Enter takes the only remaining match, which makes
  // "new from template, type psu, enter" a three-second job.
  const search = el('input', {
    placeholder: 'filter templates…', autocomplete: 'off', style: 'width:100%;margin:8px 0',
  });
  const list = el('div', {});
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const hits = TPLS.filter(t =>
      !q || (t.label + ' ' + t.id + ' ' + t.group).toLowerCase().includes(q));
    const groups = new Map();
    for (const t of hits) {
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group).push(t);
    }
    list.replaceChildren();
    for (const g of [...groups.keys()].sort()) {
      list.append(el('h3', { style: 'margin:10px 0 4px' }, g));
      for (const t of groups.get(g).sort((a, b) => a.label < b.label ? -1 : 1)) {
        list.append(el('div', { class: 'opt', onclick: () => { closeDlg(); templateForm(t); } },
          t.label,
          el('span', { class: 'faint' }, '  ' + t.id),
          t.builtin ? null : el('span', { class: 'chip' }, 'saved')));
      }
    }
    if (!hits.length) list.append(el('div', { class: 'muted' }, `Nothing matches "${search.value}".`));
    return hits;
  };
  search.oninput = paint;
  search.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const hits = paint();
    if (hits.length === 1) { closeDlg(); templateForm(hits[0]); }
  };
  body.append(search, list);
  paint();
  $('dlgFoot').replaceChildren(el('button', { onclick: closeDlg }, 'Cancel'));
  openDlg();
  search.focus();
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
        try { id = Core.fromTemplate(tpl, probe, 'probe', FIELD_BY_ID).id; } catch { break; }
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
      const node = Core.fromTemplate(tpl, vars, 'template', FIELD_BY_ID);
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
    const node = Core.fromTemplate(tpl, vars, S.name, FIELD_BY_ID);
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
// Scans `doc`, which is the pruned document about to be written, so an unfilled
// placeholder does not drag a field spec into the file alongside no data.
function embedUsedFields(doc) {
  const src = doc || S.inv;
  const used = new Set();
  for (const n of src.nodes) {
    for (const k of Object.keys(n.meta || {})) used.add(k);
    for (const p of n.pluggables) for (const k of Object.keys(p.meta || {})) used.add(k);
  }
  for (const l of src.links) for (const k of Object.keys(l.meta || {})) used.add(k);
  for (const v of (src.vlans || [])) for (const k of Object.keys(v.meta || {})) used.add(k);

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
// A meta key with an empty value is an editor placeholder, not data. Dropping it
// here rather than in Core keeps the browser and the CLI byte-identical on any
// file a human wrote by hand.
//
// This MUST return a copy and leave S.inv alone. An earlier version pruned in
// place, and because touched() calls saveDraft() -> currentYaml() before it
// re-renders, adding a field deleted it again before the row could be drawn:
// every string, number and enum field in the picker appeared to do nothing.
function prunedForOutput(inv) {
  const clean = holder => {
    if (!holder.meta) return holder;
    const next = {};
    for (const [k, v] of Object.entries(holder.meta)) {
      if (v === '' || v === null || v === undefined) continue;
      // an untouched composite is a placeholder too, and would emit `k: {}`
      if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
      next[k] = v;
    }
    return { ...holder, meta: Object.keys(next).length ? next : null };
  };
  return {
    ...inv,
    nodes: inv.nodes.map(n => ({ ...clean(n), pluggables: n.pluggables.map(clean) })),
    links: inv.links.map(clean),
    vlans: (inv.vlans || []).map(clean),
  };
}

function currentYaml() {
  embedUsedFields();
  return Core.serializeChecked(prunedForOutput(S.inv));
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
  // An empty value must NOT mean delete. Adding a key creates it empty so the
  // row exists to type into; treating that as a removal made "+ ad hoc key" and
  // every string field in the picker do nothing at all.
  //
  // Empty values are pruned on the way out (see pruneEmptyMeta), so a key you
  // added and never filled simply is not written to the file.
  const setKey = (k, v) => {
    holder.meta = { ...(holder.meta || {}), [k]: v === undefined || v === null ? '' : v };
  };
  const removeKey = (k) => {
    const next = { ...(holder.meta || {}) };
    delete next[k];
    holder.meta = Object.keys(next).length ? next : null;
  };

  const rows = el('div', {});
  for (const k of Object.keys(meta).sort()) {
    const spec = FIELD_BY_ID.get(k);
    // class and data-key are load bearing for the browser tests: they let a test
    // address one meta row exactly instead of guessing at its label text.
    const row = el('div', {
      class: 'metarow', 'data-key': k,
      style: 'display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:wrap',
    });

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
        el('button', { onclick: () => { removeKey(k); touched(); } }, '×'));
      rows.append(row);
      continue;
    }

    row.append(metaControl(spec, meta[k], v => { setKey(k, v); touchedSoft(); }));
    const u = unitSuffix(spec);
    if (u) row.append(u);
    row.append(el('button', { onclick: () => { removeKey(k); touched(); } }, '×'));
    rows.append(row);
  }
  wrap.append(rows);

  // add: pick from the specs that apply here and are not already set
  // A combo box, not a plain <select>: there are seventy-odd shipped fields and
  // scrolling a native dropdown to find "volts_out" is miserable. Type to filter,
  // Enter takes the first match.
  const avail = specsFor(scope)
    .filter(f => !(f.id in meta))
    .sort((a, b) => (a.label < b.label ? -1 : 1));
  const label = id => {
    if (!id) return avail.length ? '+ add field…' : 'all fields set';
    const f = FIELD_BY_ID.get(id);
    return f ? f.label + (f.unit ? ` (${f.unit})` : '') : id;
  };
  const pick = el('span', { class: 'metapick' },
    combo(avail.map(f => f.id), '', id => {
      if (!id) return;
      setKey(id, blankValue(FIELD_BY_ID.get(id)));
      touched();
    }, label));
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

// Deliberately empty, not zero and not the first enum member. Inventing 0 for a
// numeric field writes a measurement the user never took, and it looks identical
// to a real reading.
function blankValue(spec) {
  if (spec && spec.type === 'boolean') return false;
  if (spec && spec.type === 'composite') return {};
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
      sel.append(el('option', { value: '', selected: value === '' || value === undefined }, '— not set —'));
      const opts = spec.enum.map(String);
      if (value !== '' && value !== undefined && !opts.includes(String(value))) {
        sel.append(el('option', { value: String(value), selected: true }, String(value) + ' (off list)'));
      }
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
// `prior` is an existing spec being edited; omit it to declare a new field.
function declareField(id, sample, scope, prior) {
  $('dlgHead').textContent = prior ? 'Edit field' : 'Declare field';
  const body = $('dlgBody'); body.replaceChildren();
  const guessType = typeof sample === 'boolean' ? 'boolean'
    : typeof sample === 'number' ? (Number.isInteger(sample) ? 'integer' : 'number') : 'string';
  const p = prior || {};
  const idIn = el('input', { value: id, style: 'width:100%' });
  const labelIn = el('input', { value: p.label || id.replace(/_/g, ' '), style: 'width:100%' });
  const typeIn = select(['string', 'number', 'integer', 'boolean', 'enum', 'composite'],
    p.type || guessType, () => {});
  const unitIn = el('input', { value: p.unit || '', placeholder: 'V, W, gbps, GB…', style: 'width:100%' });
  const enumIn = el('input', {
    value: (p.enum || []).join(', '), placeholder: 'comma separated, for enum', style: 'width:100%',
  });
  const openIn = el('input', { type: 'checkbox' });
  openIn.checked = !!p.open;
  // The shipped fields all carry a description and the UI shows it as the input's
  // tooltip, so a field you declare yourself needs somewhere to say what it is
  // for. Without this every custom field was an unexplained box six months later.
  const descIn = el('textarea', {
    value: p.description || '', rows: 2, style: 'width:100%',
    placeholder: 'What this is for, and when to fill it in. Shown as the tooltip on the input.',
  });
  descIn.value = p.description || '';

  // Parts editor. A composite is a value made of several named numbers, such as
  // dimensions w/h/d. Without this, choosing "composite" produced parts: [] and
  // the control rendered NOTHING at all: a row you could never type into.
  let parts = (p.parts || []).map(q => ({ ...q }));
  let declareBtn = null;      // assigned below; preview() disables it when unusable
  const partsBox = el('div', {});
  const paintParts = () => {
    partsBox.replaceChildren();
    for (const [i, q] of parts.entries()) {
      const idI = el('input', { value: q.id || '', placeholder: 'id, e.g. w', style: 'width:90px' });
      const laI = el('input', { value: q.label || '', placeholder: 'label', style: 'width:110px' });
      const unI = el('input', { value: q.unit || '', placeholder: 'unit', style: 'width:70px' });
      const tyI = select(['number', 'integer', 'string'], q.type || 'number', val => { q.type = val; preview(); });
      idI.onchange = () => { q.id = idI.value.trim(); preview(); };
      laI.onchange = () => { q.label = laI.value.trim(); preview(); };
      unI.onchange = () => { q.unit = unI.value.trim(); preview(); };
      partsBox.append(el('div', { style: 'display:flex;gap:4px;margin-bottom:4px;flex-wrap:wrap' },
        idI, laI, unI, tyI,
        el('button', { onclick: () => { parts.splice(i, 1); paintParts(); preview(); } }, '×')));
    }
    partsBox.append(el('button', {
      onclick: () => { parts.push({ id: '', label: '', unit: '', type: 'number' }); paintParts(); preview(); },
    }, '+ part'));
  };

  const specNow = () => {
    const vals = enumIn.value.split(',').map(x => x.trim()).filter(Boolean);
    const sp = {
      id: idIn.value.trim(), label: labelIn.value.trim() || idIn.value.trim(),
      type: typeIn.value, unit: unitIn.value.trim(), enum: vals, open: openIn.checked,
      min: null, max: null,
      applies_to: prior ? (prior.applies_to || []) : (scope ? [scope] : []),
      description: descIn.value.trim(),
      parts: typeIn.value === 'composite' ? parts.filter(q => q.id) : [],
      builtin: false,
    };
    sp.control = vals.length ? (sp.open ? 'combo' : 'select')
      : sp.type === 'boolean' ? 'checkbox'
      : (sp.type === 'number' || sp.type === 'integer') ? 'number'
      : sp.type === 'composite' ? 'composite' : 'text';
    return sp;
  };

  // Showing the actual control answers "what does composite do", "what does
  // allow off-list change", and "why is my unit not appearing" far better than
  // any amount of prose above the form.
  const previewRow = el('div', { style: 'display:flex;gap:6px;align-items:center;min-height:28px' });
  const problem = el('div', { class: 'prob e', style: 'display:none;margin-top:6px' });
  const partsRow = el('div', {});
  const preview = () => {
    const sp = specNow();
    partsRow.style.display = sp.type === 'composite' ? '' : 'none';
    previewRow.replaceChildren();
    try {
      previewRow.append(metaControl(sp, blankValue(sp), () => {}));
      if (sp.unit) previewRow.append(el('span', { class: 'faint' }, sp.unit));
    } catch (e) { previewRow.append(el('span', { class: 'faint' }, String(e.message || e))); }

    let msg = '';
    if (!/^[a-z][a-z0-9_]*$/.test(sp.id)) {
      msg = 'The id must be lowercase letters, digits and underscores, starting with a letter. '
        + 'It is the key written into your file.';
    } else if (sp.type === 'composite' && !sp.parts.length) {
      msg = 'A composite needs at least one part, or this field renders no input at all.';
    } else if (sp.enum.length && (sp.type === 'number' || sp.type === 'integer')) {
      msg = 'Options on a numeric field are compared as text, so 2.50 and 2.5 are different entries.';
    } else if (sp.open && !sp.enum.length) {
      msg = '"allow off-list" does nothing without options: with none, this is already a free text box.';
    }
    problem.textContent = msg;
    problem.style.display = msg ? '' : 'none';
    // Disable rather than alert. alertDlg replaces #dlgBody, so raising the
    // problem after the click destroyed every box the user had just filled in.
    // Only the first two messages are fatal; the rest are advice.
    const fatal = !/^[a-z][a-z0-9_]*$/.test(sp.id)
      || (sp.type === 'composite' && !sp.parts.length);
    if (declareBtn) declareBtn.disabled = fatal;
  };
  for (const inp of [idIn, labelIn, unitIn, enumIn, descIn]) inp.oninput = preview;
  typeIn.onchange = preview;
  openIn.onchange = preview;
  paintParts();

  body.append(
    el('div', { class: 'hint' },
      'A field spec turns a bare meta key into a typed input with a unit and, if you want, a fixed list of choices. '
      + 'It is stored in your inventory file, so it travels with the data.'),
    el('div', { class: 'grid2' },
      field('id', idIn,
        'The meta key itself, written into your file. Declaring it applies to every place that key is '
        + 'already used, so no migration is needed.'),
      field('label', labelIn, 'What the form calls it. Cosmetic; change it whenever.'),
      field('type', typeIn,
        'string is free text. number and integer keep the value sortable and comparable. boolean is a '
        + 'checkbox. composite is several named numbers in one value, like width/height/depth.'),
      field('unit', unitIn,
        'The unit the value is stored in, as a symbol: V, W, A, GB, gbps. It is shown next to the input '
        + 'and never written into the value, so 2.5 stays a number instead of becoming "2.5 gbps".'),
      field('options', enumIn,
        'Comma separated. Give a list and the input becomes a dropdown. Leave empty for a plain box.'),
      field('allow off-list', openIn,
        'Only matters with options. Ticked, the dropdown also lets you type a value that is not listed.'),
      field('note', descIn,
        'For your future self: what this means and when it applies. Shown as the tooltip on the input '
        + 'and in the fields table.'),
    ),
    partsRow);
  partsRow.append(
    el('div', { class: 'faint', style: 'margin:8px 0 4px' }, 'parts'),
    el('div', { class: 'subhelp' },
      'One row per component: id, label, unit, type. A dimensions field would have w, h and d in mm.'),
    partsBox);
  body.append(
    el('div', { class: 'faint', style: 'margin:10px 0 4px' }, 'preview'),
    previewRow,
    problem);

  declareBtn = el('button', {
    class: 'btn-primary',
    onclick: () => {
      // Nothing is validated here: the button stays disabled while the spec is
      // unusable, and the reason sits inline under the preview.
      const spec = specNow();
      S.inv.fields = [...(S.inv.fields || []).filter(f => f.id !== spec.id), spec];
      refreshFields();
      closeDlg(); touched(); toast('field declared, saved with your inventory');
    },
  }, prior ? 'Save' : 'Declare');
  $('dlgFoot').replaceChildren(declareBtn, el('button', { onclick: closeDlg }, 'Cancel'));
  preview();            // after declareBtn exists, so it can set disabled
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
    el('td', { class: 'faint', title: f.description || '' },
      f.description
        ? trunc(f.description, 60)
        : el('span', { class: 'faint', title: 'no note; say what this field is for' }, '—')),
    el('td', { class: 'faint' }, used.has(f.id) ? `${used.get(f.id).length} use(s)` : ''),
    el('td', { class: 'right' }, f.shipped ? null : el('span', {},
      // editing an existing spec is the only way to add a note to a field you
      // declared before there was anywhere to put one
      el('button', { title: 'edit this field', onclick: () => declareField(f.id, '', null, f) }, 'edit'),
      ' ',
      el('button', {
        onclick: () => {
          S.inv.fields = (S.inv.fields || []).filter(x => x.id !== f.id);
          refreshFields(); touched();
        },
      }, '×'))),
  ));
  v.append(el('table', {},
    el('thead', {}, el('tr', {},
      ...['id', 'label', 'type', 'unit', 'options', 'applies to', 'note', 'in use', ''].map(h => el('th', {}, h)))),
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
  if (sel.kind === 'node') return '#node/' + sel.id;
  if (sel.kind === 'link') return '#link/' + sel.a + '~' + sel.b;
  return '#view/' + sel.id;
}
function hashToSel(hash) {
  const h = (hash || '').replace(/^#/, '');
  if (h.startsWith('node/')) return { kind: 'node', id: h.slice(5) };
  if (h.startsWith('link/')) {
    const [a, b] = h.slice(5).split('~');
    return a && b ? { kind: 'link', a, b } : null;
  }
  if (h.startsWith('view/')) return { kind: 'view', id: h.slice(5) };
  return null;
}
const linkOf = sel => S.inv.links.find(l => l.a === sel.a && l.b === sel.b);

// pushState, so Back walks back through the views and nodes you visited. This
// used to be replaceState, on the theory that history entries would make Back
// useless for leaving the app; in practice that traded a thing people do
// constantly for a thing they do once, and Back appearing to do nothing reads as
// the app being broken.
//
// The first entry is replaced rather than pushed, so the very first view does not
// leave a duplicate behind and one Back still leaves.
let suppressHash = false;
let pushedOnce = false;
function syncHash() {
  const want = selToHash(S.sel);
  if (location.hash === want) return;
  suppressHash = true;
  try {
    if (pushedOnce) history.pushState({ sel: S.sel }, '', want);
    else { history.replaceState({ sel: S.sel }, '', want); pushedOnce = true; }
  } catch { location.hash = want; }
  suppressHash = false;
}

// Both events: popstate fires for pushState/back, hashchange for a hash typed or
// pasted into the address bar.
const applyLocation = () => {
  const sel = hashToSel(location.hash);
  if (!sel) return;
  // a link to a node that is not in this file should say so, not blank the view
  if (sel.kind === 'node' && !nodeById(sel.id)) { toast(sel.id + ' is not in this inventory'); return; }
  if (sel.kind === 'link' && !linkOf(sel)) { toast('that cable is not in this inventory'); return; }
  if (selToHash(S.sel) === selToHash(sel)) return;
  S.sel = sel;
  render();
};
window.addEventListener('popstate', () => { if (!suppressHash) applyLocation(); });
window.addEventListener('hashchange', () => { if (!suppressHash) applyLocation(); });

function render() {
  if (S.sel.kind === 'view') S.lastView = S.sel.id;
  syncHash();
  const ix = Core.index(S.inv);
  const probs = Core.validate(S.inv, FIELD_BY_ID);
  renderHeader(probs);
  renderMenu();
  renderNav(ix);
  renderView(ix, probs);
  // synchronously, so render() actually finishes rendering. Scheduling this in a
  // microtask meant anything that read the DOM right after a render saw the
  // previous contents of the editor.
  if (S.sel.kind === 'node' || S.sel.kind === 'link') paintEditor(ix);
  else if ($('nodeDlg').open) $('nodeDlg').close();
}

function renderHeader(probs) {
  $('hFile').textContent = (S.loaded ? S.name : 'no file')
    + (!canFS ? '  (downloads only)'
      : (S.loaded && !S.handle ? '  (not linked to a file)' : ''));
  $('hFile').title = canFS ? '' : whyNoFileWrite();
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

/* ---- menu bar ------------------------------------------------------------
 * The views, Settings and the create actions used to sit in the sidebar next to
 * the inventory, so a node called "View" with a child called "Problems" looked
 * exactly like the application's own navigation. Chrome belongs on a menu bar;
 * the sidebar below is now nothing but your data.
 */
let openMenu = null;
function closeMenus() {
  openMenu = null;
  for (const d of document.querySelectorAll('#menubar .menu.on')) d.classList.remove('on');
  for (const d of document.querySelectorAll('#menubar .drop')) d.hidden = true;
}
document.addEventListener('click', e => {
  if (!openMenu) return;
  if (e.target && e.target.closest && e.target.closest('#menubar')) return;
  closeMenus();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && openMenu) closeMenus(); });

function renderMenu() {
  const bar = $('menubar');
  if (!bar) return;
  bar.replaceChildren();

  const go = id => { S.sel = { kind: 'view', id }; render(); };
  const here = id => S.sel.kind === 'view' && S.sel.id === id;

  // Actions are buttons, not menu items. Creating a node is the thing you do
  // most often in an inventory editor, so burying it one click deep behind a
  // menu was backwards.
  const group = () => {
    const gp = el('div', { class: 'tgroup' });
    bar.append(gp);
    return gp;
  };

  const adds = group();
  adds.append(el('button', {
    class: 'tbtn', title: 'An empty device you fill in by hand',
    onclick: () => addNode('device'),
  }, el('span', { class: 'plus' }, '+'), 'Node'));
  adds.append(el('button', {
    class: 'tbtn', title: 'A room, rack or shelf that other things sit in',
    onclick: () => addNode('location'),
  }, el('span', { class: 'plus' }, '+'), 'Location'));
  adds.append(el('button', {
    class: 'tbtn', title: 'A pre-shaped node: switch, PSU, PDU, wall outlet and so on',
    onclick: pickTemplate,
  }, el('span', { class: 'plus' }, '+'), 'Template'));

  // Views as tabs. Seven of them, all worth reaching in one click.
  const tabs = el('div', { class: 'tabs' });
  for (const [id, label] of [['problems', 'Problems'], ['free', 'Free ports'],
    ['cables', 'Cables'], ['tree', 'Tree'], ['graph', 'Graph'],
    ['vlans', 'VLANs'], ['yaml', 'YAML']]) {
    tabs.append(el('button', {
      class: 'tab' + (here(id) ? ' on' : ''),
      onclick: () => go(id),
    }, label));
  }
  bar.append(tabs);

  const right = el('div', { class: 'tright' });
  if (S.sel.kind === 'node') {
    // a node is not one of the tabs, so say where you are instead
    right.append(el('span', { class: 'where' }, (nodeById(S.sel.id) || {}).label || S.sel.id));
  }
  right.append(el('button', {
    class: 'tbtn icon' + (here('settings') ? ' on' : ''),
    title: 'Settings: field definitions and templates',
    onclick: () => go('settings'),
  }, '\u2699'));
  bar.append(right);
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

  // `tally` goes in through here rather than being fished back out with
  // querySelector: re-finding an element you just built is fragile, and it
  // returned null outright under the stubbed DOM the smoke tests use.
  const region = (title, cls, tally) => {
    const box = el('div', { class: 'navsec ' + (cls || '') });
    if (title) {
      box.append(el('h4', {}, title,
        tally == null ? null : el('span', { class: 'tally' }, String(tally))));
    }
    nav.append(box);
    return box;
  };

  // Nothing but the inventory lives here. The views, Settings and the create
  // actions moved to the menu bar, because a node called "View" with a child
  // called "Problems" rendered identically to the application's own navigation
  // and there was no way to tell your data from the chrome.
  const locs = S.inv.nodes.filter(n => n.type === 'location' && (!q || hit(n) ||
    S.inv.nodes.some(x => x.parent === n.id && hit(x))));
  const groups = new Map();
  for (const n of S.inv.nodes) {
    if (n.type === 'location' || !hit(n)) continue;
    const ns = n.id.includes('/') ? n.id.slice(0, n.id.indexOf('/')) : 'ungrouped';
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns).push(n);
  }
  const total = S.inv.nodes.filter(hit).length;

  if (locs.length || groups.size) {
    const inv = region('Inventory', 'navinv', total);

    if (locs.length) {
      inv.append(el('h5', {}, 'places'));
      const byId = new Map(locs.map(l => [l.id, l]));
      const walk = (parent, depth) => {
        for (const l of locs.filter(x => (byId.has(x.parent) ? x.parent : '') === parent)) {
          const inside = S.inv.nodes.filter(n => n.parent === l.id && n.type !== 'location').length;
          inv.append(navRow(l.label || l.id, { kind: 'node', id: l.id }, inside || null, depth, '▪'));
          walk(l.id, depth + 1);
        }
      };
      walk('', 0);
    }
    for (const ns of [...groups.keys()].sort()) {
      inv.append(el('h5', {}, ns));
      for (const n of groups.get(ns).sort((a, b) => a.id < b.id ? -1 : 1)) {
        inv.append(navRow(n.label || n.id, { kind: 'node', id: n.id }, n.pluggables.length || null, 0));
      }
    }
  } else {
    const inv = region('Inventory', 'navinv');
    inv.append(el('div', { class: 'navnote' },
      q ? 'Nothing matches "' + S.navQ + '".' : 'Empty. Add something from the Add menu.'));
  }

  // Creating things stays reachable from here as well as from the Add menu, but
  // as buttons pinned to the bottom, so an action can never be mistaken for a
  // node in the list above it.
  const add = region(null, 'navadd');
  const action = (label, fn, title) => el('button', { class: 'navbtn', title: title || '', onclick: fn },
    el('span', { class: 'plus' }, '+'), label);
  add.append(el('div', { class: 'navbtns' },
    action('Node', () => addNode('device'), 'An empty device you fill in by hand'),
    action('Location', () => addNode('location'), 'A room, rack or shelf that other things sit in'),
    action('From template', pickTemplate, 'A pre-shaped node: a switch, PSU, PDU, wall outlet and so on')));
}

function renderView(ix, probs) {
  const v = $('view'); v.replaceChildren();
  const blank = !S.loaded && !S.inv.nodes.length;

  // Settings describes the editor, not your data: field specs and templates
  // exist before any inventory does. Gating it behind "open a file first" meant
  // /#view/settings on a fresh load showed one line of prose, and the only way
  // to reach it was to create a node and navigate back.
  if (blank && S.sel.kind === 'view' && S.sel.id === 'settings') return renderSettings(v);

  if (blank) {
    // Keep the heading. Replacing the whole pane left no clue which view you had
    // asked for, so a bookmarked link looked broken rather than empty.
    const title = ({
      problems: 'Problems', free: 'Free ports', cables: 'Cables', tree: 'Tree',
      graph: 'Graph', vlans: 'VLANs', yaml: 'YAML',
    })[S.sel.id];
    if (title) v.append(el('h2', {}, title));
    v.append(el('div', { class: 'empty' },
      'Nothing to show here yet: this view reads your inventory, and none is open. ',
      el('a', {
        href: '#', onclick: e => { e.preventDefault(); doOpen(); },
      }, 'Open an inventory.yaml'),
      ', add a node in the sidebar to start a new one, or look at ',
      el('a', {
        href: '#view/settings',
        onclick: e => { e.preventDefault(); S.sel = { kind: 'view', id: 'settings' }; render(); },
      }, 'Settings'),
      ', which works without one.'));
    return;
  }
  // A node is edited in a dialog on top of the view you were reading, rather
  // than replacing it. S.sel still addresses the node, so deep links, the back
  // button and "copy link" are unchanged; only where it is drawn moved.
  const view = S.sel.kind === 'view' ? S.sel.id : (S.lastView || 'problems');
  if (view === 'problems') return renderProblems(v, probs);
  if (view === 'free') return renderFree(v, ix);
  if (view === 'cables') return renderCables(v, ix);
  if (view === 'yaml') return renderYaml(v);
  if (view === 'settings') return renderSettings(v);
  if (view === 'graph') return renderGraph(v, ix);
  if (view === 'tree') return renderTree(v, ix);
  if (view === 'vlans') return renderVlans(v);
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

// A labelled row for .grid2. `help` is a one-line explanation shown under the
// control, not only as a tooltip: all the guidance used to sit in one paragraph
// at the top of a view, which left every individual box unexplained and meant
// nobody could tell what "unit" or "composite" wanted.
//
// Returns exactly two children, because .grid2 is a two-column grid.
function field(label, input, help) {
  const id = 'f' + (++fieldSeq);
  if (!input.id) input.id = id;
  const lab = el('label', { for: input.id, title: help || '' }, label);
  if (!help) return [lab, input];
  return [lab, el('div', {},
    input,
    el('div', { class: 'subhelp' }, help))];
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
    field('id', idIn,
      'How cables refer to this thing, so renaming it here rewrites every reference. '
      + 'Lowercase, and / to namespace, as in power/ups-1.'),
    field('label', bind(n, 'label'),
      'The human name, shown everywhere in place of the id. Change it freely; nothing points at it.'),
    field('type', typeInput(n),
      'What kind of thing this is. It only groups the sidebar and picks the icon in reports, '
      + 'so pick the nearest and move on. Use location for a room, rack or shelf.'),
    field('virtual', virtualToggle(n),
      'A VM or container: it nests under the host it runs on so you can see what dies with that host, '
      + 'but it is left out of the free-port report and the graph, because it has no sockets to plug into.'),
    field('hostname', bind(n, 'hostname'),
      'What the machine calls itself. Names it has in other systems, such as a cluster node name, '
      + 'belong in whatever sets them, not here.'),
    field('parent', select(parents, n.parent, val => { n.parent = val; touched(); }, id => {
      const p = nodeById(id); return p ? `${p.label || p.id} (${id})` : '(none)';
    }), 'What physically contains this: the room for a device, the server for a drive. '
      + 'This is containment, not cabling.'),
    field('note', bind(n, 'note'),
      'Free text for whatever does not fit a field. Anything you want to search for later is better as meta.'),
  ));

  v.append(el('h3', {}, 'meta'));
  v.append(rawHint(
    'Anything you want; <code>meta</code> is open, so an undeclared key is legal and just marked ' +
    '<i>ad hoc</i>. Declared fields get a typed input and their unit shown. ' +
    '<b>Record hardware facts here, not configuration</b>: things like vendor, model, serial, ' +
    'watts and connector types, which do not change unless the hardware does. Addresses, ' +
    'hostnames and cluster names belong in whatever system sets them.'));
  v.append(metaEditor(n, 'node'));

  v.append(el('h3', {}, `pluggables (${n.pluggables.length})`));
  v.append(rawHint(
    'Every port is in one of three states. <b>used</b>: something is plugged in. ' +
    '<b>blocked</b>: nothing is plugged in and you still cannot use it, because a wide plug in the ' +
    'socket next door is sitting over it. <b>free</b>: empty and actually usable. Only free ports are ' +
    'offered when you go looking for somewhere to put a cable, which is the entire reason the middle ' +
    'state exists. Use <b>blocked by…</b> to name the cable that is in the way.<br>' +
    'Two small plugs really do fit in one universal socket, so a full port offers <b>+ another cable</b>. ' +
    'That sets <b>fanout</b>, meaning this one hole carries that many cables. Note which way round this is: ' +
    '<i>fanout</i> is one hole carrying several, <i>blocks</i> is one plug covering a different hole.<br>' +
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
      if (p.reserved && !cables.length) {
        // Kept free on purpose. Say so where the port's state is shown, or the
        // note only exists in the file and the report, and gets forgotten.
        statusCell.append(el('div', {},
          el('span', { class: 'chip', title: 'kept free on purpose' }, 'reserved'), ' ',
          el('span', { class: 'faint' }, p.reserved)));
      }
      if (blocked && !cables.length) {
        statusCell.append(el('span', { class: 'chip blocked' }, 'blocked'), ' ',
          el('span', { class: 'faint' }, 'by '), refLink(blocked.a), el('span', { class: 'faint' }, ' ↔ '), refLink(blocked.b));
      } else if (left > 0) {
        statusCell.append(el('div', {},
          el('span', { class: 'chip free' }, cables.length ? `${left} of ${Core.capacity(p)} free` : 'free'), ' ',
          el('button', { onclick: () => pickPeer(ix, ref, p) }, 'connect'), ' ',
          S.inv.links.length
            ? el('button', { title: 'a plug on another cable physically covers this socket',
                onclick: () => markBlocked(ix, n, p) }, 'blocked by…')
            : null));
      } else if (cables.length) {
        // A full port used to offer nothing at all, so plugging a second thing
        // into one socket meant knowing the word `fanout` and finding it behind
        // "more". The model always allowed it; only the editor did not.
        statusCell.append(el('div', {},
          el('button', {
            title: 'Plug another cable into this same socket, for two small plugs sharing one hole, '
              + 'or a splitter you would rather not model as its own node. '
              + 'This raises fanout, which is how many cables this one socket carries.',
            onclick: () => {
              p.fanout = cables.length + 1;
              touchedSoft();
              toast(`fanout ${p.fanout}: ${ref} now carries up to ${p.fanout} cables`);
              pickPeer(Core.index(S.inv), ref, p);
            },
          }, '+ another cable')));
      }
      S.openPorts = S.openPorts || new Set();
      const open = S.openPorts.has(ref);
      const extras = [];
      if (p.mac) extras.push('mac');
      if ((p.ips || []).length) extras.push(`${p.ips.length} ip`);
      if (p.untagged) extras.push('vlan ' + p.untagged);
      if ((p.tagged || []).length) extras.push(`+${p.tagged.length} tagged`);
      if (p.fanout > 1) extras.push('fanout ' + p.fanout);
      if (p.reserved) extras.push('reserved');
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
      // Full render: fanout decides how many cables the port will accept, so the
      // connect button has to reappear the moment it is raised.
      const numIn = (obj, key, width) => {
        const inp = el('input', {
          type: 'number', min: '0', value: obj[key] ? String(obj[key]) : '',
          style: `width:${width}px`,
        });
        inp.onchange = () => { obj[key] = parseInt(inp.value, 10) || 0; touched(); };
        return inp;
      };
      const vlanNote = S.inv.vlans.length ? '' : ' (define VLANs first in the VLANs view)';
      const detail = el('tr', {}, el('td', { colspan: 7, style: 'padding:8px 0 14px 12px' },
        el('div', { class: 'grid2' },
          field('mac', inline(p, 'mac', 170),
            'Burned into this port, so it lives here and not on the device: a multi-NIC box has one per port.'),
          field('ips', csv(p, 'ips', 260),
            'Comma separated. Only addresses that are pinned to the hardware; anything DHCP hands out belongs '
            + 'wherever DHCP is configured.'),
          field('untagged vlan', vlanPicker(p, 'untagged'),
            'The one VLAN this port carries with no tag, the access VLAN.' + vlanNote),
          field('tagged vlans', vlanPicker(p, 'tagged'),
            'VLANs this port carries tagged, on top of the untagged one. A trunk lists several.' + vlanNote),
          field('fanout', numIn(p, 'fanout', 70),
            'How many cables this one socket can carry. Leave empty for the normal case of one. '
            + 'Set 3 when a splitter is plugged in and you would rather not model the splitter as its own node.'),
          field('reserved for', inline(p, 'reserved', 300, true),
            'Why you are keeping this port empty on purpose, such as "second NAS uplink". It stays connectable '
            + 'and still counts as free; this only records the intent so a later you does not quietly take it.'),
          field('note', inline(p, 'note', 300),
            'Anything else about this socket specifically. Notes about the whole device go on the device.'),
        ),
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
  pushHistory();
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
// `full` forces a whole re-render on change. touchedSoft only repaints the
// header, which is right while typing a note but wrong for a value that changes
// what the row offers: setting fanout left the port still showing no connect
// button, so the extra capacity looked like it had not applied.
function inline(obj, key, width, full) {
  const n = el('input', { value: obj[key] || '', style: `width:${width}px` });
  n.onchange = () => { obj[key] = n.value; if (full) touched(); else touchedSoft(); };
  return n;
}
// Short lists stay a native <select>: it is keyboard-friendly already and a
// filter box over four options is noise. Anything longer becomes a combo box you
// can type into, because scrolling a native dropdown of fifty node ids to find a
// parent is miserable.
const COMBO_AT = 8;
function select(opts, cur, onchange, fmt = x => x || '—') {
  const list = opts.includes(cur) ? opts : [cur, ...opts];
  if (list.length <= COMBO_AT) {
    const s = el('select');
    for (const o of list) s.append(el('option', { value: o, selected: o === cur }, fmt(o)));
    s.onchange = () => onchange(s.value);
    return s;
  }
  return combo(list, cur, onchange, fmt);
}

// A text input that filters a list under it. Deliberately not a datalist: those
// cannot show a label different from the value, which the parent picker needs
// ("Mini PC (compute/srv-1)"), and their filtering is inconsistent across
// browsers.
function combo(list, cur, onchange, fmt = x => x || '—') {
  const wrap = el('span', { class: 'combo' });
  const inp = el('input', {
    value: fmt(cur), placeholder: 'type to filter…', autocomplete: 'off',
    'data-value': cur,
  });
  const menu = el('div', { class: 'combomenu', hidden: true });
  let active = -1;

  const matches = () => {
    const q = inp.value.trim().toLowerCase();
    const typed = inp.value !== fmt(inp.dataset.value || '');
    if (!q || !typed) return list;
    return list.filter(o => (o + ' ' + fmt(o)).toLowerCase().includes(q));
  };
  const paint = () => {
    const hits = matches();
    active = Math.min(active, hits.length - 1);
    menu.replaceChildren(...hits.map((o, i) => el('div', {
      class: 'opt' + (i === active ? ' active' : '') + (o === inp.dataset.value ? ' cur' : ''),
      'data-value': o,
      onmousedown: e => { e.preventDefault(); choose(o); },
    }, fmt(o))));
    if (!hits.length) menu.append(el('div', { class: 'navnote' }, 'nothing matches'));
  };
  const openList = () => { menu.hidden = false; paint(); };
  const shut = () => { menu.hidden = true; active = -1; };
  const choose = o => {
    inp.dataset.value = o;
    inp.value = fmt(o);
    shut();
    onchange(o);
  };

  inp.onfocus = () => { inp.select(); openList(); };
  inp.oninput = () => { active = -1; openList(); };
  inp.onblur = () => {
    // reverting on blur, so a half-typed filter never silently becomes the value
    inp.value = fmt(inp.dataset.value || '');
    shut();
  };
  inp.onkeydown = e => {
    const hits = matches();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (menu.hidden) openList();
      active += e.key === 'ArrowDown' ? 1 : -1;
      if (active < 0) active = hits.length - 1;
      if (active >= hits.length) active = 0;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hits.length) choose(active >= 0 ? hits[active] : hits[0]);
    } else if (e.key === 'Escape') {
      e.preventDefault(); inp.blur();
    }
  };
  wrap.append(inp, menu);
  return wrap;
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

  $('dlgHead').textContent = 'What is in the way of ' + ref + '?';
  const body = $('dlgBody'); body.replaceChildren();
  body.append(rawHint(
    'Nothing is plugged into this socket, but something is in the way of it: usually a wide ' +
    'power brick in the socket next door.<br>Pick the cable that brick belongs to. It is recorded ' +
    'against that cable, so unplugging it makes this socket usable again without you having to ' +
    'remember. Cables on <b>this</b> node come first, which is the answer almost every time.'));
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
  if (!cables.length) {
    body.append(el('div', { class: 'faint' },
      'No cables recorded yet. A blocked socket is blocked BY something: record the cable '
      + 'whose plug covers it first, then come back and attribute it.'));
  }
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
        // same wording as `inv free`, so the report and the view do not
        // spell the same fact two different ways
        (Core.capacity(p) > 1 ? ` [${left} of ${Core.capacity(p)} free]` : '');
      // A reserved port is free but spoken for. Showing it as plain free here,
      // of all places, hides the reason you kept it empty from the one screen
      // you look at when deciding where to put a cable.
      byKind.get(k).push(p.reserved
        ? el('span', {},
          tag, ' ',
          el('span', { class: 'chip', title: 'kept free on purpose' }, 'reserved'),
          ' ', el('span', { class: 'faint' }, p.reserved))
        : tag);
    }
    for (const [k, list] of byKind) {
      rows.push(el('tr', {},
        el('td', {}, el('a', { href: '#', onclick: e => { e.preventDefault(); S.sel = { kind: 'node', id: n.id }; render(); } }, n.id)),
        el('td', {}, el('span', { class: 'chip ' + k.split('/')[0] }, k)),
        el('td', {}, ...list.flatMap((x, i) => (i ? [', ', x] : [x]))),
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

// One cable editor, used by the Cables table and by the panel the graph opens.
// Two copies would drift, and the copy you were looking at would be the one
// missing the field you wanted.
function cableEditor(l) {
  const box = el('div', {});
  const flag = (key, label, help) => {
    const c = el('input', { type: 'checkbox' });
    c.checked = !!l[key];
    c.onchange = () => { l[key] = c.checked; touched(); };
    return field(label, c, help);
  };
  box.append(el('div', { class: 'grid2' },
    field('from', el('span', {}, refLink(l.a)), 'One end of the run. Click to open that device.'),
    field('to', el('span', {}, refLink(l.b)), 'The other end.'),
    field('label', inline(l, 'label', 200),
      'What is written on the cable itself. Put it here rather than on both ports, where it would drift.'),
    flag('poe', 'poe', 'An ethernet run that also carries power, which is how "what feeds the AP" stays answerable.'),
    flag('planned', 'planned',
      'Intended but not run. It stays as a reminder without occupying either port, so both ends still count as free.'),
    field('blocks', el('button', { onclick: () => blocksEditor(l) }, `${l.blocks.length} socket(s)`),
      'Sockets this connection makes unusable, typically a brick overhanging its neighbour.'),
    field('note', inline(l, 'note', 300), 'Anything else about this cable.'),
  ));
  box.append(el('div', { class: 'faint', style: 'margin:10px 0 4px' }, 'cable meta'));
  box.append(rawHint('Facts about the cable itself, not about either end. <b>carries</b> is the one to reach for '
    + 'when the connector cannot say what a lead does: a USB lead may be power, data or both, and the graph '
    + 'buckets it accordingly instead of filing a charger next to HDMI.'));
  box.append(metaEditor(l, 'link'));
  return box;
}

function renderCables(v, ix) {
  v.append(el('h2', {}, 'Cables'));
  v.append(rawHint(
    'One row per physical cable. <b>label</b> is the tag on the cable itself, so put it here rather than on both ports where it ' +
    'would drift. <b>poe</b> marks an ethernet run that also carries power, which is how "what feeds the AP" stays answerable. ' +
    '<b>planned</b> is a cable you intend to run but have not: it stays in the file as a reminder without occupying either port, ' +
    'so both ends still count as free. <b>blocks</b> lists sockets this connection makes unusable, typically a brick ' +
    'overhanging its neighbour.'));
  if (!S.inv.links.length) { v.append(el('div', { class: 'empty' }, 'None yet.')); return; }
  const rows = S.inv.links
    .slice()
    .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0))
    .map(l => {
      const poe = el('input', { type: 'checkbox' });
      poe.checked = l.poe;
      poe.onchange = () => { l.poe = poe.checked; touched(); };
      // `planned` was honoured by the validator and by `inv free`, which skips
      // planned cables when counting capacity, but there was no way to set it
      // from the editor at all: you had to hand-edit the YAML.
      const planned = el('input', { type: 'checkbox', title: 'intended, not run yet' });
      planned.checked = l.planned;
      planned.onchange = () => { l.planned = planned.checked; touched(); };
      // A cable has meta too, and without this every link-scoped field was
      // unreachable from the editor: `carries`, cable length, colour, PoE watts.
      // They existed in the settings and in the file and nowhere on screen.
      S.openLinks = S.openLinks || new Set();
      const key = l.a + '|' + l.b;
      const open = S.openLinks.has(key);
      const extras = [];
      if (l.meta) extras.push(Object.keys(l.meta).length + ' meta');
      const main = el('tr', { style: l.planned ? 'opacity:.72' : '' },
        el('td', {}, l.a), el('td', {}, l.b),
        el('td', {}, inline(l, 'label', 110)),
        el('td', {}, poe),
        el('td', {}, planned),
        el('td', {}, el('button', { onclick: () => blocksEditor(l) }, `blocks (${l.blocks.length})`)),
        el('td', {}, inline(l, 'note', 170)),
        el('td', {},
          el('button', {
            onclick: () => { open ? S.openLinks.delete(key) : S.openLinks.add(key); render(); },
          }, open ? '▾ less' : '▸ more'),
          extras.length ? el('span', { class: 'faint' }, ' ' + extras.join(', ')) : null),
        el('td', { class: 'right' }, el('button', {
          title: 'unplug this cable',
          onclick: () => { removeLink(l); },
        }, '×')),
      );
      if (!open) return [main];
      return [main, el('tr', {}, el('td', { colspan: 9, style: 'padding:8px 0 14px 12px' },
        cableEditor(l)))];
    }).flat();
  v.append(el('table', {},
    el('thead', {}, el('tr', {},
      ...['a', 'b', 'label', 'poe', 'planned', 'blocks', 'note', 'detail', ''].map(h => el('th', {}, h)))),
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
    el('button', { onclick: () => copyText(text, 'copied', 'Copy this YAML') }, 'copy')));
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
      // a VLAN carries meta like everything else, and a field declared for every
      // scope had nowhere to go here, so it round tripped through the file
      // invisibly instead of being editable
      S.openVlans = S.openVlans || new Set();
      const open = S.openVlans.has(vl.id);
      const main = el('tr', {},
        el('td', {}, idIn),
        el('td', {}, inline(vl, 'name', 110)),
        el('td', {}, (() => {
          // one row per prefix: dual stack means at least two, and a ULA and a
          // GUA alongside the v4 range means four is ordinary
          const box = el('div', {});
          const paint = () => {
            box.replaceChildren();
            const list = vl.subnets || [];
            for (const [i, sn] of list.entries()) {
              const inp = el('input', { value: sn, style: 'width:190px' });
              inp.onchange = () => {
                const next = inp.value.trim();
                if (next) vl.subnets[i] = next;
                else vl.subnets.splice(i, 1);
                touched();
              };
              box.append(el('div', { style: 'display:flex;gap:4px;margin-bottom:3px' }, inp,
                el('button', { title: 'remove this prefix', onclick: () => { vl.subnets.splice(i, 1); touched(); } }, '×')));
            }
            box.append(el('button', {
              onclick: () => { vl.subnets = [...(vl.subnets || []), '']; paint(); },
            }, '+ prefix'));
          };
          paint();
          return box;
        })()),
        el('td', {}, inline(vl, 'note', 170)),
        el('td', { class: 'faint' }, users.length ? `${users.length} port${users.length > 1 ? 's' : ''}` : 'unused'),
        el('td', {},
          el('button', {
            onclick: () => { open ? S.openVlans.delete(vl.id) : S.openVlans.add(vl.id); render(); },
          }, open ? '▾ less' : '▸ more'),
          vl.meta ? el('span', { class: 'faint' }, ` ${Object.keys(vl.meta).length} meta`) : null),
        el('td', { class: 'right' }, el('button', {
          onclick: async () => {
            if (users.length && await choose('Delete VLAN',
              `vlan ${vl.id} is referenced by ${users.length} port(s). Delete it anyway? Those ports keep the id and will warn.`,
              [{ id: 'yes', label: 'Delete', primary: true }]) !== 'yes') return;
            S.inv.vlans = S.inv.vlans.filter(x => x !== vl); touched();
          },
        }, '×')),
      );
      if (!open) return [main];
      return [main, el('tr', {}, el('td', { colspan: 7, style: 'padding:8px 0 14px 12px' },
        metaEditor(vl, 'vlan')))];
    }).flat();
    v.append(el('table', {},
      el('thead', {}, el('tr', {}, ...['id', 'name', 'subnets', 'note', 'used by', 'detail', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, ...rows)));
  }
  v.append(el('button', {
    style: 'margin-top:10px',
    onclick: () => {
      let id = 10; while (S.inv.vlans.some(x => x.id === id)) id++;
      S.inv.vlans.push({ id, name: '', subnets: [], note: '', meta: null, src: S.name });
      touched();
    },
  }, '+ vlan'));
}

/* ---- containment tree --------------------------------------------------- */
/* ---- tree: drag to re-parent, delete, peek ------------------------------- */
let dragId = null;

// Refuse a drop that would make a node its own ancestor. Without this, dragging
// a parent onto its own child produces a loop, which strands both of them.
function isAncestor(maybeAncestor, id) {
  let cur = nodeById(id), guard = 0;
  while (cur && guard++ < 10000) {
    if (cur.id === maybeAncestor) return true;
    cur = nodeById(cur.parent);
  }
  return false;
}
function canDropOn(dragging, target) {
  if (!dragging || dragging === target) return false;
  const n = nodeById(dragging);
  if (!n || n.parent === target) return false;      // already there
  return !isAncestor(dragging, target);
}
function markDrop(row) {
  clearDrop();
  row.classList.add('dropinto');
}
function clearDrop() {
  for (const r of document.querySelectorAll('.dropinto')) r.classList.remove('dropinto');
}
function reparent(id, parentId) {
  const n = nodeById(id);
  if (!n || !canDropOn(id, parentId)) return;
  n.parent = parentId;
  touched();
  toast(`${n.label || n.id} moved into ${parentId || 'the top level'}`);
}

// Deleting is the one action with no undo prompt of its own, so it says exactly
// what else goes with it before doing anything.
async function confirmDelete(n, children) {
  const ix = Core.index(S.inv);
  const refs = new Set(n.pluggables.map(p => n.id + ':' + p.id));
  const cables = S.inv.links.filter(l => refs.has(l.a) || refs.has(l.b)).length;
  const kids = (children || []).length;
  const loses = [];
  if (n.pluggables.length) loses.push(`${n.pluggables.length} port${n.pluggables.length > 1 ? 's' : ''}`);
  if (cables) loses.push(`${cables} cable${cables > 1 ? 's' : ''}`);
  const body = `Delete ${n.label || n.id}?`
    + (loses.length ? ` This also removes ${loses.join(' and ')}.` : '')
    + (kids ? ` Its ${kids} child node${kids > 1 ? 's move' : ' moves'} up to `
      + `${n.parent || 'the top level'} rather than being deleted.` : '')
    + ' Ctrl+Z undoes it.';
  const opts = [{ id: 'yes', label: 'Delete', primary: true }];
  if (await choose('Delete node', body, opts) !== 'yes') return;
  deleteNode(n.id, n.parent);
  S.sel = { kind: 'view', id: 'tree' };
  render();
}

// The node editor, in a dialog on top of whatever view you were reading.
//
// This is the same renderNode used before, not a cut-down "peek": there is one
// node editor and it is reachable from the tree, the graph, the sidebar and a
// deep link. Building a second read-only version would be two things to keep in
// step, and the read-only one would be the wrong one every time you actually
// wanted to change something.
function paintEditor(ix) {
  const dlg = $('nodeDlg');
  const back = () => { S.sel = { kind: 'view', id: S.lastView || 'problems' }; render(); };
  const body = $('nodeBody');

  if (S.sel.kind === 'link') {
    const l = linkOf(S.sel);
    if (!l) { back(); return; }
    $('nodeHead').textContent = 'Cable';
    body.replaceChildren();
    body.append(el('div', { class: 'sub', style: 'margin-bottom:8px' }, l.a + '  <->  ' + l.b));
    body.append(cableEditor(l));
  } else {
    const n = nodeById(S.sel.id);
    if (!n) { back(); return; }
    $('nodeHead').textContent = n.label || n.id;
    body.replaceChildren();
    renderNode(body, ix || Core.index(S.inv), n);
  }

  $('nodeFoot').replaceChildren(
    el('button', {
      title: 'copy a link straight to this node',
      onclick: () => copyText(location.href.split('#')[0] + selToHash(S.sel), 'link copied', 'Link to this node'),
    }, 'link'),
    el('button', {
      class: 'btn-primary',
      onclick: () => { $('nodeDlg').close(); },
    }, 'Done'));

  // show(), not showModal(): a modal makes the toolbar, Save and Undo inert,
  // and you edit a node for minutes at a time.
  if (!dlg.open) dlg.show();
}

// Closing has to put the selection back, or the URL keeps pointing at a node
// that is no longer on screen.
$('nodeDlg').addEventListener('close', () => {
  if (S.sel.kind === 'node' || S.sel.kind === 'link') {
    S.sel = { kind: 'view', id: S.lastView || 'problems' };
    render();
  }
});
// Escape does not close a non-modal dialog by itself.
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (S.gconnect) { S.gconnect = null; render(); return; }
  if ($('nodeDlg').open && !$('dlg').open) $('nodeDlg').close();
});

function renderTree(v, ix) {
  v.append(el('h2', {}, 'Tree'));
  v.append(rawHint(
    'Containment at any depth: places hold devices, devices hold cards and drives. This is the <b>parent</b> relation, ' +
    'not cabling, so a drive shows under its server even though the cable is a separate thing. Use it to answer ' +
    '"what is physically inside this"; use Graph to answer "what is plugged into this". ' +
    'Guests marked <b>virtual</b> appear under the machine they run on, which answers "what dies if this host ' +
    'dies", but are left out of the free-port report since they have no sockets.<br>' +
    '<b>Drag a row onto another</b> to move it inside that one, or onto the strip at the bottom to bring it back ' +
    'to the top level. A drop that would make something its own ancestor is refused. ' +
    'Clicking a node opens it for editing in a dialog, so you never lose your place in the tree.'));

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
      // `val == null` covers null as well as undefined: a null slipped through
      // and every row read "cpu null · ram null · storage null".
      if (val == null || val === '' || String(val) === 'TODO') continue;
      bits.push(`${k} ${val}`);
    }
    const ports = n.pluggables.length;
    if (ports) {
      const free = n.pluggables.filter(p =>
        Core.slotsLeft(ix, n.id, p) > 0 && !ix.blockedBy.has(n.id + ':' + p.id)).length;
      bits.push(`${ports} port${ports > 1 ? 's' : ''}, ${free} free`);
    }
    return bits;
  };

  const rowFor = (n, depth, into) => {
      const dest = into || box;
      shown++;
      const children = kids.get(n.id) || [];
      const open = !S.collapsed.has(n.id);
      const row = el('div', {
        class: 'treerow',
        style: `padding-left:${depth * 18}px`,
      });
      row.append(el('span', {
        style: 'width:14px;color:var(--dim2);cursor:pointer;user-select:none',
        onclick: () => {
          if (!children.length) return;
          if (open) S.collapsed.add(n.id); else S.collapsed.delete(n.id);
          render();
        },
      }, children.length ? (open ? '▾' : '▸') : '·'));
      // A real href, so right-click and "copy link address" give a usable deep
      // link. Modified clicks peek instead of navigating, because opening a new
      // browser tab is not useful here: the inventory lives in a local file the
      // new tab has not opened, so it would land on the restore banner.
      row.append(el('a', {
        href: selToHash({ kind: 'node', id: n.id }),
        style: 'text-decoration:none',
        title: 'open this node; the tree stays behind the dialog',
        onclick: e => { e.preventDefault(); S.sel = { kind: 'node', id: n.id }; render(); },
      }, n.label || n.id));
      if (n.type) row.append(el('span', { class: 'chip' }, n.type));
      if (n.virtual) row.append(el('span', { class: 'chip', title: 'no physical presence' }, 'virtual'));
      const bits = summarise(n);
      if (bits.length) row.append(el('span', { class: 'faint' }, bits.join(' · ')));

      const tools = el('span', { class: 'treetools' });
      tools.append(el('button', {
        title: 'open this node for editing',
        onclick: e => { e.stopPropagation(); S.sel = { kind: 'node', id: n.id }; render(); },
      }, 'edit'));
      tools.append(el('button', {
        title: 'delete this node',
        onclick: e => { e.stopPropagation(); confirmDelete(n, children); },
      }, '×'));
      row.append(tools);

      // ---- drag to re-parent
      row.draggable = true;
      row.dataset.nodeId = n.id;
      row.addEventListener('dragstart', e => {
        dragId = n.id;
        row.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          // some browsers refuse to start a drag with no payload set
          try { e.dataTransfer.setData('text/plain', n.id); } catch { /* ignore */ }
        }
      });
      row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); clearDrop(); });
      row.addEventListener('dragover', e => {
        if (!dragId || !canDropOn(dragId, n.id)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        markDrop(row);
      });
      row.addEventListener('dragleave', () => row.classList.remove('dropinto'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        clearDrop();
        if (!dragId || !canDropOn(dragId, n.id)) return;
        reparent(dragId, n.id);
      });

      dest.append(row);
      return open;
  };

  // Guarded by node identity, not by id: ids can be duplicated, and a node whose
  // id is the empty string lands in its own child list because '' is also the
  // root sentinel. That recursed until the stack blew, and a file as small as
  // `nodes: {}` was enough to do it.
  const drawn = new Set();
  const walk = (parent, depth) => {
    for (const n of (kids.get(parent) || [])) {
      if (drawn.has(n)) continue;
      drawn.add(n);
      if (rowFor(n, depth)) walk(n.id, depth + 1);
    }
  };
  walk('', 0);
  v.append(box);

  // Dropping onto a row nests; there has to be somewhere to drop to un-nest.
  const root = el('div', { class: 'droproot' }, 'drop here to move to the top level');
  root.addEventListener('dragover', e => {
    if (!dragId || !nodeById(dragId) || !nodeById(dragId).parent) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markDrop(root);
  });
  root.addEventListener('dragleave', () => root.classList.remove('dropinto'));
  root.addEventListener('drop', e => {
    e.preventDefault(); clearDrop();
    if (dragId) reparent(dragId, '');
  });
  v.append(root);

  // Reachability ignoring collapse, so a folded subtree is not mistaken for one
  // that cannot be reached at all.
  const reachable = new Set();
  (function mark(parent) {
    for (const n of (kids.get(parent) || [])) {
      if (reachable.has(n)) continue;
      reachable.add(n);
      mark(n.id);
    }
  })('');
  const stranded = S.inv.nodes.filter(n => !reachable.has(n));
  if (stranded.length) {
    // A parent loop used to make these vanish, with nothing but the "n of m
    // shown" line to suggest anything was missing.
    v.append(el('h3', {}, `not reachable from any root (${stranded.length})`));
    v.append(hint('Each of these sits in a parent loop, so there is no path down to it from a '
      + 'top-level node. Problems names the loop; clearing one parent puts them back in the tree.'));
    const loose = el('div', {});
    v.append(loose);
    for (const n of stranded) rowFor(n, 0, loose);
  }

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
// nested children: inset on each side, and the gap above/below the nested block
const KID_INSET = 10, KID_GAP = 6;
const BG = '#1b1e24';

function renderGraph(v, ix) {
  v.append(el('h2', {}, 'Graph'));
  v.append(rawHint(
    'Columns are steps along a cable run, so a wall socket is on the left and whatever it eventually feeds is on the ' +
    'right. Switch to <b>by place</b> if you would rather group by room. A box drawn <b>inside another box</b> is ' +
    'physically inside it: a drive in its server, a guest on its host. Guests are dashed, because they have no ' +
    'sockets of their own. Dashed thick lines carry PoE. ' +
    '<b>Click a cable</b> to trace its run: what feeds it, and what it goes on to feed, with the exact sockets ' +
    'marked and everything else faded. It follows direction, so it will not wander sideways into the other things ' +
    'sharing the same wall socket. <b>Double click</b> a cable to edit it, which is where <code>carries</code> ' +
    'lives, and a node to open it. Click again, or use clear, to stop tracing.<br>' +
    '<b>Click a socket</b>, the small dot beside a port name, to start a cable, then click the socket at the other ' +
    'end. Only compatible, free sockets turn green, so anything you can click is a cable you could really plug in. ' +
    'Escape cancels. Adding a cable can shift the columns, because the columns are worked out from the cables, so ' +
    'the new one stays highlighted afterwards. <b>Drag</b> to pan, ' +
    '<b>ctrl+scroll</b> (or pinch) to zoom toward the pointer, <b>click</b> a node to open it. Zoom needs ctrl held so ' +
    'that a plain scroll still moves the page instead of trapping it here.'));

  S.gfilter = S.gfilter || 'all';
  const bar = el('div', { style: 'display:flex;gap:6px;margin:8px 0;align-items:center;flex-wrap:wrap' });
  for (const f of ['all', 'eth', 'power', 'usb', 'av', 'other']) {
    bar.append(el('button', {
      class: S.gfilter === f ? 'btn-primary' : '',
      title: f === 'power' ? 'mains and DC, plus any cable marked as carrying power'
        : f === 'usb' ? 'USB leads that are not marked as power'
          : f === 'av' ? 'hdmi, dp, dvi, vga, audio' : '',
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
  // Only columns that hold something. A location whose devices all live in child
  // locations drew an empty column, which shoved the diagram hundreds of pixels
  // right and left the frame looking mostly blank.
  const memberCount = cid =>
    S.inv.nodes.filter(n => n.type !== 'location' && !n.virtual && locOf(n) === cid).length;
  const colIds = [...order.map(l => l.id), ''].filter(cid => memberCount(cid) > 0);

  // Bucket by what the cable CARRIES, not only by the connector on the end of
  // it. A USB lead from a charger to a switch is a power cable, but its ports
  // are type usb, so bucketing on connector alone filed it under "other" next to
  // HDMI. The connector genuinely cannot tell you: the same USB port also
  // carries the KVM's keyboard emulation and the Orange Pi's second NIC. Where
  // that is ambiguous, `meta.carries` on the link settles it.
  // A cable can belong to more than one bucket, so this returns a set. A USB-C
  // lead often carries power AND data, and PoE is an ethernet run that also
  // carries power; forcing either into one bucket hides it from the other.
  const AV = ['hdmi', 'dp', 'dvi', 'vga', 'audio'];
  const bucketsOf = l => {
    const p = ix.portByRef.get(l.a);
    const t = p ? p.port.type : '';
    const base = t === 'eth' ? 'eth'
      : t === 'power' ? 'power'
        : t === 'usb' ? 'usb'
          : AV.includes(t) ? 'av' : 'other';
    const out = new Set([base]);
    const says = l.meta && l.meta.carries;
    if (says === 'power') {
      out.add('power');
      if (base !== 'power') out.delete(base);   // a pure power lead is not data
    }
    if (says === 'both') out.add('power');      // stays in its connector bucket too
    if (l.poe) out.add('power');                // PoE: ethernet that also feeds
    return out;
  };
  const wanted = l => S.gfilter === 'all' || bucketsOf(l).has(S.gfilter);
  const links = S.inv.links.filter(l => ix.portByRef.has(l.a) && ix.portByRef.has(l.b) && wanted(l));
  const live = new Set(links.flatMap(l => [l.a, l.b]));

  // Containment, drawn as containment. This used to be one flat stack per
  // location, so a drive inside a server or a VM on a host appeared as a sibling
  // box and the parent relation was invisible. Children are now nested inside
  // their parent's rectangle, at any depth.
  const kidsOf = new Map();
  const isNodeParent = n => {
    const p = ix.nodeById.get(n.parent);
    return p && p.type !== 'location' ? p : null;
  };
  for (const n of S.inv.nodes) {
    if (n.type === 'location') continue;
    const p = isNodeParent(n);
    if (!p) continue;
    if (!kidsOf.has(p.id)) kidsOf.set(p.id, []);
    kidsOf.get(p.id).push(n);
  }
  for (const list of kidsOf.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));

  const place = new Map();
  let maxY = 0;
  // Guards a parent loop: without it a cycle recurses until the stack blows,
  // exactly as it did in the tree.
  const laying = new Set();
  const layout = (n, x, y, w, depth) => {
    if (laying.has(n.id)) return 0;
    laying.add(n.id);
    const shown = n.pluggables.filter(p => live.has(n.id + ':' + p.id));
    // a virtual guest has no sockets, so it gets a header and nothing else
    const rows = n.virtual ? shown.length : Math.max(shown.length, 1);
    const headH = HEAD_H + rows * ROW_H + 8;
    let cy = y + headH;
    const kids = kidsOf.get(n.id) || [];
    for (const k of kids) {
      cy += KID_GAP;
      cy += layout(k, x + KID_INSET, cy, w - KID_INSET * 2, depth + 1);
    }
    const h = (cy - y) + (kids.length ? KID_GAP : 0);
    place.set(n.id, { n, x, y, w, h, headH, shown, depth });
    laying.delete(n.id);
    return h;
  };

  // Columns. Two ways to organise them, because one column per location does
  // nothing when everything lives in one room, which is the common case: you get
  // a single column and cables crossing it in insertion order.
  //
  //   by chain: column = how far along a cable run a thing sits, so the wall
  //             socket is on the left and whatever it eventually feeds is on the
  //             right. This is what the hint above has always promised.
  //   by place: column = location. Useful once there really are several rooms.
  const rootOf = n => {
    let cur = n, guard = 0;
    while (cur && guard++ < 10000) {
      const p = isNodeParent(cur);
      if (!p) return cur;
      cur = p;
    }
    return n;
  };

  let columns;                       // array of arrays of root nodes
  let colTitles;
  if (S.glayout === 'place') {
    columns = colIds.map(cid => S.inv.nodes.filter(n =>
      n.type !== 'location' && locOf(n) === cid && !isNodeParent(n)));
    colTitles = colIds.map(cid => {
      const loc = ix.nodeById.get(cid);
      return (loc ? (loc.label || loc.id) : 'no location').toUpperCase();
    });
  } else {
    const roots = S.inv.nodes.filter(n => n.type !== 'location' && !isNodeParent(n));
    const idx = new Map(roots.map((n, i) => [n.id, i]));
    // Only a cable with a declared direction can order two things. An ethernet
    // run between two switches says nothing about which comes first, so it is
    // drawn but does not constrain the layout.
    const edges = [];
    for (const l of links) {
      const pa = ix.portByRef.get(l.a), pb = ix.portByRef.get(l.b);
      if (!pa || !pb) continue;
      const ra = rootOf(pa.node), rb = rootOf(pb.node);
      if (!idx.has(ra.id) || !idx.has(rb.id) || ra === rb) continue;
      if (pa.port.dir === 'out' && pb.port.dir === 'in') edges.push([ra.id, rb.id]);
      else if (pb.port.dir === 'out' && pa.port.dir === 'in') edges.push([rb.id, ra.id]);
    }
    // longest path from a source, relaxed until it settles
    const rank = new Map(roots.map(n => [n.id, 0]));
    for (let pass = 0; pass < roots.length + 2; pass++) {
      let moved = false;
      for (const [from, to] of edges) {
        if (rank.get(to) < rank.get(from) + 1) { rank.set(to, rank.get(from) + 1); moved = true; }
      }
      if (!moved) break;            // a cycle would otherwise run to the cap
    }
    // things with no directed cable at all sit beside whatever they touch
    const undirected = new Map();
    for (const l of links) {
      const pa = ix.portByRef.get(l.a), pb = ix.portByRef.get(l.b);
      if (!pa || !pb) continue;
      const ra = rootOf(pa.node).id, rb = rootOf(pb.node).id;
      if (ra === rb) continue;
      if (!undirected.has(ra)) undirected.set(ra, []);
      if (!undirected.has(rb)) undirected.set(rb, []);
      undirected.get(ra).push(rb);
      undirected.get(rb).push(ra);
    }
    const touched = new Set(edges.flat());
    for (const n of roots) {
      if (touched.has(n.id)) continue;
      const near = (undirected.get(n.id) || []).filter(x => touched.has(x));
      if (near.length) {
        rank.set(n.id, Math.round(near.reduce((s, x) => s + rank.get(x), 0) / near.length));
      }
    }
    const maxRank = Math.max(0, ...[...rank.values()]);
    columns = Array.from({ length: maxRank + 1 }, () => []);
    for (const n of roots) columns[rank.get(n.id)].push(n);
    // One pass of the barycentre heuristic: put each box next to the average
    // position of what it connects to on the left. Cheap, and it removes most
    // of the crossings a naive order produces.
    const posIn = new Map();
    columns.forEach((col, ci) => {
      if (ci > 0) {
        col.sort((a, b) => {
          const key = n => {
            const near = (undirected.get(n.id) || []).filter(x => posIn.has(x));
            return near.length ? near.reduce((s, x) => s + posIn.get(x), 0) / near.length : 1e9;
          };
          return key(a) - key(b) || (a.id < b.id ? -1 : 1);
        });
      } else {
        col.sort((a, b) => (a.id < b.id ? -1 : 1));
      }
      col.forEach((n, i) => posIn.set(n.id, i));
    });
    columns = columns.filter(c => c.length);
    colTitles = columns.map((_, i) => i === 0 ? 'SOURCES' : 'STEP ' + i);
  }

  columns.forEach((members, ci) => {
    let y = 46;
    for (const n of members) {
      y += layout(n, ci * (BOX_W + COL_GAP) + 12, y, BOX_W, 0) + PAD_Y;
    }
    maxY = Math.max(maxY, y);
  });

  // A parent loop leaves every node in it without a root, so nothing would be
  // laid out and they would silently disappear. Same failure the tree had.
  const orphans = S.inv.nodes.filter(n => n.type !== 'location' && !place.has(n.id));
  if (orphans.length) {
    let y = maxY + PAD_Y;
    for (const n of orphans) y += layout(n, 12, y, BOX_W, 0) + PAD_Y;
    maxY = y;
  }

  if (!place.size) {
    v.append(bar);
    v.append(el('div', { class: 'empty' }, 'Nothing to draw yet. Add some nodes and cables.'));
    return;
  }

  const width = columns.length * (BOX_W + COL_GAP) + 24;
  const height = Math.max(maxY + 20, 240);

  const g = svgEl('g');
  // Following one cable through a full diagram is the thing this view is for, and
  // it was impossible: every line looked the same. Clicking a cable now traces
  // the whole chain it belongs to, so "what feeds the AP" is one click.
  const chain = S.gpick
    ? neighbourhood(links, S.gpick, ix)
    : tracedChain(links, S.gtrace, ix);
  const traced = chain.links;
  const litRefs = chain.refs;
  const litNodes = chain.nodes;

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
    const on = traced.has(l);
    const dim = traced.size > 0 && !on;
    const wire = WIRE[t] || '#7f8794';
    const line = svgEl('g', { style: 'cursor:pointer' });
    // a fat transparent line under the thin one, so a 1.4px cable is clickable
    line.append(svgEl('path', {
      d, fill: 'none', stroke: 'transparent', 'stroke-width': '12',
      // single click traces the run, double click edits the cable: the same
      // pairing as a node box, so one gesture means the same thing everywhere
      onclick: e => {
        if (e.stopPropagation) e.stopPropagation();
        S.gpick = null;
        S.gtrace = (S.gtrace && S.gtrace.a === l.a && S.gtrace.b === l.b)
          ? null                                   // clicking it again clears
          : { a: l.a, b: l.b };
        render();
      },
      ondblclick: e => {
        if (e.stopPropagation) e.stopPropagation();
        S.gtrace = { a: l.a, b: l.b };   // keep it lit while you edit it
        S.sel = { kind: 'link', a: l.a, b: l.b };
        render();
      },
    }, svgEl('title', {}, l.a + ' <-> ' + l.b + (l.poe ? ' (PoE)' : '')
      + (l.label ? ' | ' + l.label : '')
      + (l.meta && l.meta.carries ? ' | carries ' + l.meta.carries : '')
      + '   (click to trace, double click to edit)')));
    if (on) {
      // a halo under the traced line so it reads through a crowd of others
      line.append(svgEl('path', {
        d, fill: 'none', stroke: '#ffffff', 'stroke-width': String((l.poe ? 2.4 : 1.4) + 5),
        opacity: '0.22', 'pointer-events': 'none',
      }));
    }
    line.append(svgEl('path', {
      d, fill: 'none', stroke: on ? '#ffffff' : wire,
      'stroke-width': String(on ? (l.poe ? 3.4 : 2.6) : (l.poe ? 2.4 : 1.4)),
      'stroke-dasharray': l.poe ? '5 3' : null,
      opacity: dim ? '0.12' : '0.85',
      'pointer-events': 'none',
    }));
    g.append(line);
  }

  // Location boundaries, drawn behind everything. In the chain layout a room's
  // devices are spread across columns by how far along a run they sit, so a box
  // round them is the only thing that still shows where they physically are.
  const locBoxes = [];
  for (const loc of S.inv.nodes.filter(n => n.type === 'location')) {
    const inside = [...place.values()].filter(b => b.depth === 0 && locOf(b.n) === loc.id);
    if (!inside.length) continue;
    const x0 = Math.min(...inside.map(b => b.x)) - 10;
    const y0 = Math.min(...inside.map(b => b.y)) - 22;
    const x1 = Math.max(...inside.map(b => b.x + b.w)) + 10;
    const y1 = Math.max(...inside.map(b => b.y + b.h)) + 10;
    locBoxes.push({ loc, x0, y0, x1, y1, n: inside.length });
  }
  // biggest first, so a nested room draws on top of the one containing it
  locBoxes.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  for (const lb of locBoxes) {
    g.append(svgEl('rect', {
      x: lb.x0, y: lb.y0, width: lb.x1 - lb.x0, height: lb.y1 - lb.y0, rx: '8',
      fill: 'none', stroke: '#39414f', 'stroke-dasharray': '6 4', 'pointer-events': 'none',
    }));
    g.append(svgEl('text', {
      x: lb.x0 + 8, y: lb.y0 + 13, fill: '#6b7482', 'font-size': '10', 'font-family': GFONT,
      'pointer-events': 'none',
    }, (lb.loc.label || lb.loc.id).toUpperCase() + '  (' + lb.n + ')'));
  }

  colTitles.forEach((title, ci) => {
    g.append(svgEl('text', {
      x: ci * (BOX_W + COL_GAP) + 12, y: 26,
      fill: '#6b7482', 'font-size': '11', 'font-family': GFONT,
    }, title));
  });

  // Shallowest first, so a nested child paints on top of the parent it sits in.
  for (const b of [...place.values()].sort((a, c) => a.depth - c.depth)) {
    const { n, x, y, w, h, shown, depth } = b;
    const selected = S.sel.kind === 'node' && S.sel.id === n.id;
    const box = svgEl('g', {
      style: 'cursor:pointer',
      // data-node is a testability hook: cables are also cursor:pointer groups,
      // so "the first clickable g" is not reliably a node box.
      'data-node': n.id,
      // Single click selects and lights up what this box is wired to; opening
      // the node takes a double click, so one stray click no longer throws you
      // out of the diagram you were reading.
      onclick: e => {
        if (e.stopPropagation) e.stopPropagation();
        S.gtrace = null;
        S.gpick = S.gpick === n.id ? null : n.id;
        render();
      },
      ondblclick: e => {
        if (e.stopPropagation) e.stopPropagation();
        S.gpick = null;
        S.sel = { kind: 'node', id: n.id };
        render();
      },
    });
    // Nested boxes step lighter with depth so containment is legible without
    // reading a single label, and a guest is dashed since it has no sockets.
    const shade = ['#21252d', '#262b34', '#2b313b', '#31374253'][Math.min(depth, 3)];
    const onChain = litNodes.has(n.id);
    const dimmed = litNodes.size > 0 && !onChain;
    box.append(svgEl('rect', {
      x, y, width: w, height: h, rx: '6',
      fill: selected ? '#24405f' : shade,
      stroke: selected ? '#6ea8fe' : onChain ? '#ffffff' : (n.virtual ? '#3c4450' : '#2c313b'),
      'stroke-width': onChain ? '2' : '1',
      'stroke-dasharray': n.virtual ? '4 3' : null,
      opacity: dimmed ? '0.35' : '1',
    }));
    box.append(svgEl('text', {
      x: x + 9, y: y + 16, fill: n.virtual ? '#9aa3b2' : '#e4e7ec',
      'font-size': depth ? '11' : '12', 'font-family': GFONT,
    }, trunc(n.label || n.id, Math.max(10, 24 - depth * 3))));
    // the right-hand corner shows what is still free, or that this is a guest
    const freeCount = n.pluggables.filter(pp => Core.slotsLeft(ix, n.id, pp) > 0).length;
    const corner = n.virtual ? 'guest' : (freeCount > 0 ? freeCount + ' free' : '');
    if (corner) {
      box.append(svgEl('text', {
        x: x + w - 9, y: y + 16, fill: n.virtual ? '#7f8794' : '#5dd39e', 'font-size': '10',
        'font-family': GFONT, 'text-anchor': 'end',
      }, corner));
    }
    shown.forEach((p, i) => {
      const py = y + HEAD_H + i * ROW_H + 8;
      // the exact sockets the traced chain passes through, so you can see where
      // it lands rather than only which boxes are involved
      const lit = litRefs.has(n.id + ':' + p.id);
      box.append(svgEl('text', {
        x: x + 12, y: py + 3, fill: lit ? '#ffffff' : '#9aa3b2',
        'font-size': '10', 'font-family': GFONT,
        'font-weight': lit ? '700' : null,
        opacity: dimmed ? '0.4' : '1',
      }, trunc(p.id + (p.label && p.label !== p.id ? ' (' + p.label + ')' : ''), 28)));
      const ref = n.id + ':' + p.id;
      const from = S.gconnect ? ix.portByRef.get(S.gconnect) : null;
      const isFrom = S.gconnect === ref;
      // while connecting, only sockets you could actually plug into stay lit
      const ok = from && !isFrom
        && Core.compatible(from.port, p)
        && Core.slotsLeft(ix, n.id, p) > 0
        && !ix.blockedBy.has(ref);
      for (const cx of [x + 5, x + w - 5]) {
        box.append(svgEl('circle', {
          cx, cy: py, r: (lit || isFrom || ok) ? '4.5' : '2.6',
          fill: isFrom ? '#ffffff' : (WIRE[p.type] || '#7f8794'),
          stroke: isFrom ? '#5dd39e' : ok ? '#5dd39e' : lit ? '#ffffff' : null,
          'stroke-width': (isFrom || ok || lit) ? '1.8' : null,
          opacity: (S.gconnect && !isFrom && !ok) ? '0.25' : (dimmed ? '0.4' : '1'),
          style: 'cursor:crosshair',
          onclick: e => {
            if (e.stopPropagation) e.stopPropagation();
            if (!S.gconnect) {
              S.gconnect = ref;
              toast('now click the socket at the other end, or press Escape');
            } else if (isFrom) {
              S.gconnect = null;                     // clicking it again cancels
            } else if (ok) {
              const a = S.gconnect;
              S.gconnect = null;
              connect(a, ref);
              // keep the new cable lit: the columns are worked out from the
              // cables, so adding one can move things, and you want to see
              // which line you just made
              S.gtrace = { a, b: ref };
              return;
            } else {
              toast('not compatible with ' + S.gconnect);
              return;
            }
            render();
          },
        }, svgEl('title', {}, ref + (p.reserved ? '  reserved: ' + p.reserved : '')
          + (S.gconnect ? (isFrom ? '  (click to cancel)' : ok ? '  (click to connect here)' : '  (not compatible)')
            : '  (click to start a cable)'))));
      }
    });
    g.append(box);
  }

  const z = S.gz || { k: 1, tx: 0, ty: 0 };
  const apply = () => g.setAttribute('transform', 'translate(' + S.gz.tx + ',' + S.gz.ty + ') scale(' + S.gz.k + ')');
  S.gz = z; apply();

  // Fill whatever vertical space is left rather than a fixed 720px cap, which
  // left a band of empty page below the diagram on any tall window.
  let viewH = Math.min(height, 720);
  const root = svgEl('svg', {
    width: '100%', height: viewH,
    viewBox: '0 0 ' + width + ' ' + viewH,
    style: 'background:' + BG + ';border:1px solid var(--line);border-radius:6px;' +
      'touch-action:none;display:block;cursor:grab;user-select:none;-webkit-user-select:none',
  }, g);

  // The viewBox is kept equal to the element's own pixel box, so one user unit is
  // one CSS pixel. That matters for two reasons this view got wrong before:
  // panning becomes 1:1 with the pointer instead of needing a scale conversion,
  // and the viewBox stops disagreeing with the element's aspect ratio, which had
  // the browser fitting by height and centring the diagram in a sea of blank space.
  const syncBox = () => {
    // Height first: measure how much of the scrolling pane is left below the
    // top of the diagram, leaving room for the count line underneath it.
    const sec = root.parentElement && root.parentElement.closest
      ? root.parentElement.closest('section')
      : null;
    if (sec && root.getBoundingClientRect) {
      const avail = Math.floor(sec.getBoundingClientRect().bottom
        - root.getBoundingClientRect().top - 44);
      const want = Math.max(260, avail);
      if (want !== viewH) { viewH = want; root.setAttribute('height', String(viewH)); }
    }
    const cw = root.clientWidth;
    if (cw > 0) root.setAttribute('viewBox', '0 0 ' + cw + ' ' + viewH);
  };
  syncBox();
  if (typeof queueMicrotask === 'function') queueMicrotask(syncBox);
  if (typeof ResizeObserver === 'function') new ResizeObserver(syncBox).observe(root);

  // Pointer position in user units. Same thing as element-relative pixels now.
  const at = e => {
    const r = root.getBoundingClientRect ? root.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Require a modifier: swallowing every wheel event meant the page could not be
  // scrolled past the diagram.
  root.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const k = S.gz.k;
    const k2 = Math.min(4, Math.max(0.25, k * (e.deltaY < 0 ? 1.12 : 0.89)));
    if (k2 === k) return;
    // Hold whatever is under the pointer still. Scaling about the origin instead
    // threw the diagram off screen on the first notch of the wheel.
    const p = at(e), r = k2 / k;
    S.gz = { k: k2, tx: p.x - (p.x - S.gz.tx) * r, ty: p.y - (p.y - S.gz.ty) * r };
    apply();
  }, { passive: false });

  root.addEventListener('click', e => {
    // a click that lands on the background, not on a box or a cable
    if (e.target === root && !moved) { S.gpick = null; S.gtrace = null; S.gconnect = null; render(); }
  });

  let drag = null;
  // A drag that starts on a node used to pan and then fire that node's click on
  // release, so trying to move the diagram navigated away from it.
  let moved = false;
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    root.style.cursor = 'grab';
  };
  root.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    // Deliberately no preventDefault here: on pointerdown it suppresses the
    // compatibility mouse events, which killed the click that opens a node.
    // Text selection is handled by user-select:none in the element style instead.
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId, tx: S.gz.tx, ty: S.gz.ty };
    moved = false;
    root.style.cursor = 'grabbing';
    // Capture is taken in pointermove, not here. Capturing on pointerdown
    // retargets the derived click event to this element, so the click never
    // reached the node box and clicking a node in the graph did nothing.
  });
  root.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!moved && dx * dx + dy * dy > 16) {
      moved = true;
      // Only now: keeps a pan alive if the pointer leaves the frame mid-drag.
      if (root.setPointerCapture) { try { root.setPointerCapture(drag.id); } catch { /* gone */ } }
    }
    S.gz = { k: S.gz.k, tx: drag.tx + dx, ty: drag.ty + dy };
    apply();
  });
  // Without pointercancel a drag interrupted by a context menu left `drag` set,
  // and the graph then panned on plain mouse movement with no button held.
  // pointerleave is deliberately not used: with the pointer captured it can fire
  // mid-gesture and drop a pan that merely strayed outside the frame.
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
  root.addEventListener('lostpointercapture', endDrag);
  root.addEventListener('click', e => {
    if (!moved) return;
    moved = false;
    if (e.stopPropagation) e.stopPropagation();
    if (e.preventDefault) e.preventDefault();
  }, true);

  // Scale the diagram down to fit the frame if it overflows, rather than just
  // returning to 1:1 and leaving the far end off screen.
  const fit = () => {
    const cw = root.clientWidth || width;
    const k = Math.min(1, cw / width, viewH / height);
    S.gz = { k, tx: 0, ty: 0 };
    apply();
  };
  bar.append(el('button', { style: 'margin-left:6px', onclick: fit }, 'fit'));
  bar.append(el('button', { onclick: () => { S.gz = { k: 1, tx: 0, ty: 0 }; apply(); } }, '1:1'));
  bar.append(el('button', { onclick: () => exportSvg(root, width, height) }, 'SVG'));
  bar.append(el('button', { onclick: () => exportPng(root, width, height) }, 'PNG'));

  v.append(bar);
  v.append(root);
  const foot = el('div', { class: 'faint', style: 'margin-top:6px' },
    place.size + ' nodes, ' + links.length + ' cables shown' +
    (S.gfilter === 'all' ? '' : ' (filtered to ' + S.gfilter + ')'));
  if (S.gconnect) {
    foot.replaceChildren(
      el('b', {}, 'connecting from ' + S.gconnect), ' ',
      el('span', {}, 'click a green socket to finish. Only compatible, free sockets are green.'), ' ',
      el('button', { onclick: () => { S.gconnect = null; render(); } }, 'cancel'));
  }
  if (traced.size) {
    foot.append(' · ', el('b', {}, `tracing ${traced.size} cable${traced.size > 1 ? 's' : ''} `
      + `through ${litNodes.size} node${litNodes.size > 1 ? 's' : ''}`), ' ');
    if (S.gtrace && linkOf(S.gtrace)) {
      // a 1.4px line is a small target for a double click, so offer the same
      // thing as a button
      foot.append(el('button', {
        onclick: () => { S.sel = { kind: 'link', a: S.gtrace.a, b: S.gtrace.b }; render(); },
      }, 'edit this cable'), ' ');
    }
    foot.append(el('button', { onclick: () => { S.gtrace = null; render(); } }, 'clear'));
  }
  v.append(foot);
}

// The run one cable belongs to: what feeds it, and what it goes on to feed.
//
// Traversal follows direction and never reverses, which is the whole point. An
// earlier version walked the graph as if undirected, so from any cable it went
// up to the wall socket and back down every other branch, lighting the entire
// diagram. Here, from the feeding end we only ever go further upstream, and from
// the fed end only further downstream, so the other devices sharing a socket are
// left out. A cable with no declared direction, ethernet between two switches
// say, highlights itself and its two boxes and stops.
function tracedChain(links, sel, ix) {
  const empty = { links: new Set(), refs: new Set(), nodes: new Set() };
  if (!sel) return empty;
  const seed = links.find(l => l.a === sel.a && l.b === sel.b);
  if (!seed) return empty;

  const onNode = new Map();
  for (const l of links) {
    for (const ref of [l.a, l.b]) {
      const n = Core.splitRef(ref)[0];
      if (!onNode.has(n)) onNode.set(n, []);
      onNode.get(n).push(l);
    }
  }
  const outLinks = new Set([seed]);
  const nodes = new Set();
  const dirOf = ref => { const p = ix.portByRef.get(ref); return p ? p.port.dir : ''; };

  // want 'in': keep walking towards the source. want 'out': keep walking away.
  const walk = (startNode, want) => {
    const seen = new Set();
    const queue = [startNode];
    let guard = 0;
    while (queue.length && guard++ < 5000) {
      const nid = queue.pop();
      if (seen.has(nid)) continue;
      seen.add(nid);
      nodes.add(nid);
      for (const l of (onNode.get(nid) || [])) {
        const mine = Core.splitRef(l.a)[0] === nid ? l.a : l.b;
        if (dirOf(mine) !== want) continue;
        outLinks.add(l);
        queue.push(Core.splitRef(mine === l.a ? l.b : l.a)[0]);
      }
    }
  };

  for (const ref of [seed.a, seed.b]) {
    const nid = Core.splitRef(ref)[0];
    nodes.add(nid);
    const d = dirOf(ref);
    // this end supplies the cable, so its own supply is further upstream
    if (d === 'out') walk(nid, 'in');
    // this end is fed by the cable, so what it feeds is further downstream
    else if (d === 'in') walk(nid, 'out');
  }

  const refs = new Set();
  for (const l of outLinks) { refs.add(l.a); refs.add(l.b); }
  return { links: outLinks, refs, nodes };
}

// Everything one node is directly wired to: its own cables, the sockets they use
// and the boxes at the far ends. One hop only, because "what is this plugged
// into" is a different question from "trace this run", and answering it with the
// whole chain buries the answer.
function neighbourhood(links, nodeId, ix) {
  const outLinks = new Set();
  const nodes = new Set([nodeId]);
  const refs = new Set();
  for (const l of links) {
    const a = Core.splitRef(l.a)[0], b = Core.splitRef(l.b)[0];
    if (a !== nodeId && b !== nodeId) continue;
    outLinks.add(l);
    nodes.add(a); nodes.add(b);
    refs.add(l.a); refs.add(l.b);
  }
  return { links: outLinks, refs, nodes };
}

function anchorOf(place, ref) {
  const parts = Core.splitRef(ref);
  const b = place.get(parts[0]);
  if (!b) return null;
  const i = b.shown.findIndex(p => p.id === parts[1]);
  if (i < 0) return null;
  const y = b.y + HEAD_H + i * ROW_H + 8;
  // b.w, not BOX_W: a nested box is narrower than its parent, and using the
  // constant put the right-hand anchor outside the box it belongs to.
  return { x: b.x, y, left: b.x + 5, right: b.x + b.w - 5 };
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
  copyText(url, 'link copied', 'Link to this view');
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
