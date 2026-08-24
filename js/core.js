/* ==== CORE START ====
   Pure logic: no DOM, no browser APIs. Mirrors cmd/inv/main.go exactly so that
   a file written here and a file written by `inv fmt` are byte-identical. The
   node test in test/core.test.mjs extracts this block and checks that. */
const Core = (() => {
  const s = v => (v === undefined || v === null) ? '' : String(v);

  // ---- namespace resolution: anything with a slash is absolute -------------
  function resolve(id, ns) {
    if (!id || !ns || id.includes('/')) return id || '';
    return ns + '/' + id;
  }
  function resolveRef(ref, ns) {
    if (!ref) return '';
    const i = ref.indexOf(':');
    if (i < 0) return ref;
    return resolve(ref.slice(0, i), ns) + ':' + ref.slice(i + 1);
  }
    // '\x00' as an escape, not a literal NUL: a literal makes grep treat the
  // file as binary, and any tool that normalises control characters would
  // silently change desugar's dedup key. Go uses the same separator.
  function pairKey(a, b) { return a > b ? b + '\x00' + a : a + '\x00' + b; }
  function splitRef(ref) {
    const i = ref.indexOf(':');
    return i < 0 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)];
  }

  function emptyInv() { return { fields: [], vlans: [], nodes: [], links: [] }; }
  // A hand-edited file may hold `ips: 10.0.0.1` where a list belongs. Coerce
  // rather than throwing a raw TypeError at the user.
  const asList = v => Array.isArray(v) ? v
    : (v === undefined || v === null || v === '' ? [] : [v]);
  const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
  const nums = a => asList(a).map(num);   // Go keeps these; filtering here lost data

  function cleanMeta(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    return Object.keys(m).length ? m : null;
  }

  // ---- absorb one parsed document -----------------------------------------
  function absorb(inv, doc, src) {
    const d = (doc && doc.defaults) || {};
    const ns = s(d.namespace);
    for (const raw of asList(doc && doc.fields)) inv.fields.push(readField(raw, src));
    for (const raw of asList(doc && doc.vlans)) {
      inv.vlans.push({
        id: num(raw.id), name: s(raw.name), subnet: s(raw.subnet),
        note: s(raw.note), meta: cleanMeta(raw.meta), src,
      });
    }
    for (const raw of asList(doc && doc.nodes)) {
      const parentRaw = s(raw.parent) || s(d.parent);
      inv.nodes.push({
        id: resolve(s(raw.id), ns),
        label: s(raw.label),
        type: s(raw.type),
        virtual: !!raw.virtual,
        hostname: s(raw.hostname),
        parent: resolve(parentRaw, ns),
        note: s(raw.note),
        meta: cleanMeta(raw.meta),
        pluggables: asList(raw.pluggables).map(p => ({
          id: s(p.id),
          type: s(p.type),
          dir: s(p.dir),
          connected_with: resolveRef(s(p.connected_with), ns),
          fanout: num(p.fanout),
          mac: s(p.mac),
          ips: asList(p.ips).map(s),   // an empty entry is a validation error, not something to drop
          untagged: num(p.untagged),
          tagged: nums(p.tagged),
          reserved: s(p.reserved),
          label: s(p.label),
          note: s(p.note),
          meta: cleanMeta(p.meta),
        })),
        src,
      });
    }
    for (const raw of asList(doc && doc.links)) {
      inv.links.push({
        a: resolveRef(s(raw.a), ns),
        b: resolveRef(s(raw.b), ns),
        label: s(raw.label),
        note: s(raw.note),
        planned: !!raw.planned,
        poe: !!raw.poe,
        blocks: asList(raw.blocks).map(x => resolveRef(s(x), ns)),
        meta: cleanMeta(raw.meta),
        src,
      });
    }
  }

  // connected_with is sugar. Explicit links come first so their poe/blocks win;
  // a pair already present is skipped, so declaring a cable from both ends
  // collapses to one instead of colliding.
  function desugar(inv) {
    const seen = new Set(inv.links.map(l => pairKey(l.a, l.b)));
    for (const n of inv.nodes) {
      for (const p of n.pluggables) {
        if (!p.connected_with) continue;
        const ref = n.id + ':' + p.id;
        const k = pairKey(ref, p.connected_with);
        if (seen.has(k)) continue;
        seen.add(k);
        inv.links.push({
          a: ref, b: p.connected_with, label: '', note: '',
          poe: false, blocks: [], meta: null, src: n.src,
        });
      }
    }
  }

  // Go uses KnownFields(true) and hard-errors on an unknown key. This side must
  // match: silently ignoring `labl:` would mean a load-then-save cycle in the
  // editor DELETES the user's field, which is the worst bug this app could have.
  const KNOWN = {
    doc: ['defaults', 'fields', 'vlans', 'nodes', 'links'],
    defaults: ['namespace', 'parent'],
    vlan: ['id', 'name', 'subnet', 'note', 'meta'],
    field: ['id', 'label', 'type', 'control', 'unit', 'enum', 'open', 'min', 'max',
      'applies_to', 'parts', 'description', 'meta'],
    node: ['id', 'label', 'type', 'virtual', 'hostname', 'parent', 'note', 'meta', 'pluggables'],
    plug: ['id', 'type', 'dir', 'connected_with', 'fanout', 'mac', 'ips', 'untagged',
      'tagged', 'reserved', 'label', 'note', 'meta'],
    link: ['a', 'b', 'label', 'note', 'planned', 'poe', 'blocks', 'meta'],
  };
  function badKeys(obj, allowed, where, out) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) out.push((where ? where + '.' : '') + k);
    }
  }
  function unknownFields(doc) {
    const out = [];
    badKeys(doc, KNOWN.doc, '', out);
    badKeys(doc.defaults, KNOWN.defaults, 'defaults', out);
    asList(doc.fields).forEach((f, i) => badKeys(f, KNOWN.field, 'fields[' + i + ']', out));
    asList(doc.vlans).forEach((v, i) => badKeys(v, KNOWN.vlan, 'vlans[' + i + ']', out));
    asList(doc.nodes).forEach((n, i) => {
      badKeys(n, KNOWN.node, 'nodes[' + i + ']', out);
      asList(n && n.pluggables).forEach((q, j) =>
        badKeys(q, KNOWN.plug, 'nodes[' + i + '].pluggables[' + j + ']', out));
    });
    asList(doc.links).forEach((l, i) => badKeys(l, KNOWN.link, 'links[' + i + ']', out));
    return out;
  }

  // One reader for a field spec, used for both the shipped defaults and the ones
  // carried inside an inventory, so the two can never drift.
  function readField(f, src) {
    return {
      id: s(f.id),
      label: s(f.label) || s(f.id),
      type: s(f.type) || 'string',
      control: s(f.control) || defaultControl(f),
      unit: s(f.unit),
      enum: asList(f.enum),
      open: !!f.open,
      min: f.min === undefined || f.min === null ? null : Number(f.min),
      max: f.max === undefined || f.max === null ? null : Number(f.max),
      applies_to: asList(f.applies_to).map(s),
      description: s(f.description),
      parts: asList(f.parts).map(q => ({
        id: s(q.id), label: s(q.label) || s(q.id),
        type: s(q.type) || 'string', unit: s(q.unit),
      })),
      meta: cleanMeta(f.meta),
      src,
    };
  }

  function parse(text, src = 'inventory.yaml') {
    const doc = jsyaml.load(text) || {};
    if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('top level must be a mapping');
    const bad = unknownFields(doc);
    if (bad.length) {
      throw new Error('unknown field(s): ' + bad.join(', ') +
        '. Refusing to load rather than dropping them on the next save.');
    }
    const inv = emptyInv();
    absorb(inv, doc, src);
    desugar(inv);
    return inv;
  }

  // ---- index --------------------------------------------------------------
  function index(inv) {
    const nodeById = new Map(), portByRef = new Map(), childrenOf = new Map();
    for (const n of inv.nodes) {
      if (!nodeById.has(n.id)) nodeById.set(n.id, n);
      for (const p of n.pluggables) {
        const ref = n.id + ':' + p.id;
        if (!portByRef.has(ref)) portByRef.set(ref, { node: n, port: p, ref });
      }
    }
    for (const n of inv.nodes) {
      const k = n.parent || '';
      if (!childrenOf.has(k)) childrenOf.set(k, []);
      childrenOf.get(k).push(n);
    }
    // Every cable on a port, not just the first: a fanout port carries several,
    // and keeping only the first is what made fanout unusable from the editor.
    const usedBy = new Map(), blockedBy = new Map();
    for (const l of inv.links) {
      if (l.planned) continue;   // intent, not an occupied port
      for (const ref of [l.a, l.b]) {
        if (!usedBy.has(ref)) usedBy.set(ref, []);
        usedBy.get(ref).push(l);
      }
      for (const b of l.blocks) if (!blockedBy.has(b)) blockedBy.set(b, l);
    }
    return { nodeById, portByRef, childrenOf, usedBy, blockedBy };
  }

  function peerOf(link, ref) { return link.a === ref ? link.b : link.a; }
  function cablesAt(ix, ref) { return ix.usedBy.get(ref) || []; }
  function capacity(port) { return port && port.fanout > 1 ? port.fanout : 1; }
  function slotsLeft(ix, nodeId, port) { return capacity(port) - cablesAt(ix, nodeId + ':' + port.id).length; }
  function kind(p) { return p.dir ? p.type + '/' + p.dir : p.type; }

  // Two ports can be cabled if the type matches and, where direction is
  // declared, it is declared on both and opposite.
  function compatible(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if ((a.dir === '') !== (b.dir === '')) return false;
    if (a.dir && a.dir === b.dir) return false;
    return true;
  }

  // ---- validate -----------------------------------------------------------
  // A warning is something finishing your data entry will fix. An error is
  // something no amount of additional data can fix.
  function validate(inv, specs) {
    const out = [];
    const err = m => out.push({ warn: false, msg: m });
    const warn = m => out.push({ warn: true, msg: m });

    // Control characters cannot survive a YAML round trip reliably, so they are
    // refused rather than silently mangled. Reported per field so the offender
    // is findable.
    const ctlCheck = (where, v) => {
      if (typeof v !== 'string' || !CTRL.test(v)) return;
      const c = v.match(CTRL)[0].codePointAt(0);
      err(`${where} contains a control character (0x${c.toString(16)}). ` +
        'Remove it: these cannot round-trip through YAML safely.');
    };
    for (const n of inv.nodes) {
      for (const f of ['id', 'label', 'type', 'hostname', 'parent', 'note']) ctlCheck(`${n.id}.${f}`, n[f]);
      for (const [k, v] of Object.entries(n.meta || {})) { ctlCheck(`${n.id}.meta key`, k); ctlCheck(`${n.id}.meta.${k}`, v); }
      for (const p of n.pluggables) {
        for (const f of ['id', 'label', 'note', 'mac']) ctlCheck(`${n.id}:${p.id}.${f}`, p[f]);
        for (const [k, v] of Object.entries(p.meta || {})) { ctlCheck(`${n.id}:${p.id}.meta key`, k); ctlCheck(`${n.id}:${p.id}.meta.${k}`, v); }
      }
    }
    const dateCheck = (where, v) => {
      if (typeof v === 'string' && badDateShape(v)) {
        err(`${where} looks like a date but is not a real one ("${v}"). ` +
          'Fix it or write it differently: the two YAML parsers disagree about it.');
      }
    };
    for (const n of inv.nodes) {
      for (const f of ['label', 'note']) dateCheck(`${n.id}.${f}`, n[f]);
      for (const [k, v] of Object.entries(n.meta || {})) dateCheck(`${n.id}.meta.${k}`, v);
      for (const p of n.pluggables) for (const [k, v] of Object.entries(p.meta || {})) dateCheck(`${n.id}:${p.id}.meta.${k}`, v);
    }

    const wsCheck = (where, v) => {
      if (typeof v !== 'string' || v === '' || v === v.trim()) return;
      err(`${where} has leading or trailing whitespace. Remove it: go-yaml drops ` +
        'it on the way back, so the value would not survive a round trip.');
    };
    for (const n of inv.nodes) {
      for (const f of ['id', 'label', 'type', 'hostname', 'parent', 'note']) wsCheck(`${n.id}.${f}`, n[f]);
      for (const [k, v] of Object.entries(n.meta || {})) { wsCheck(`${n.id}.meta key`, k); wsCheck(`${n.id}.meta.${k}`, v); }
      for (const p of n.pluggables) {
        for (const f of ['id', 'label', 'note', 'mac']) wsCheck(`${n.id}:${p.id}.${f}`, p[f]);
        for (const [k, v] of Object.entries(p.meta || {})) { wsCheck(`${n.id}:${p.id}.meta key`, k); wsCheck(`${n.id}:${p.id}.meta.${k}`, v); }
      }
    }
    for (const l of inv.links) for (const f of ['label', 'note']) ctlCheck(`${l.a} <-> ${l.b}.${f}`, l[f]);
    for (const l of inv.links) for (const f of ['label', 'note']) wsCheck(`${l.a} <-> ${l.b}.${f}`, l[f]);

    // typed checks against declared field specs, when the caller supplies them
    if (specs && specs.size) {
      for (const n of inv.nodes) {
        checkMeta(specs, n.id, n.meta, err);
        for (const p of n.pluggables) checkMeta(specs, `${n.id}:${p.id}`, p.meta, err);
      }
      for (const l of inv.links) checkMeta(specs, `${l.a} <-> ${l.b}`, l.meta, err);
      for (const v of (inv.vlans || [])) checkMeta(specs, `vlan ${v.id}`, v.meta, err);
    }
    for (const v of (inv.vlans || [])) for (const f of ['name', 'subnet', 'note']) ctlCheck(`vlan ${v.id}.${f}`, v[f]);

    const nodes = new Map();
    for (const n of inv.nodes) {
      if (nodes.has(n.id)) { err(`duplicate node id "${n.id}"`); continue; }
      nodes.set(n.id, n);
    }
    const ports = new Map();
    for (const n of nodes.values()) {
      const seen = new Set();
      for (const p of n.pluggables) {
        if (seen.has(p.id)) { err(`${n.id} has duplicate pluggable "${p.id}"`); continue; }
        seen.add(p.id);
        ports.set(n.id + ':' + p.id, p);
      }
    }
    for (const n of nodes.values()) {
      if (n.parent && !nodes.has(n.parent)) warn(`${n.id} has parent "${n.parent}" which does not exist yet`);
    }
    // containment cycles, reported once by whichever member sorts first
    for (const start of nodes.keys()) {
      const seen = new Map([[start, 0]]);
      let path = [start], cur = nodes.get(start);
      while (cur && cur.parent) {
        const next = nodes.get(cur.parent);
        if (!next) break;
        if (seen.has(next.id)) {
          const cyc = path.slice(seen.get(next.id));
          if (cyc.reduce((m, x) => x < m ? x : m, cyc[0]) === start) {
            err('parent cycle: ' + cyc.concat([next.id]).join(' -> '));
          }
          break;
        }
        seen.set(next.id, path.length); path.push(next.id); cur = next;
      }
    }
    // VLANs are defined once and referenced from ports.
    const vlans = new Map();
    for (const v of (inv.vlans || [])) {
      if (vlans.has(v.id)) { err(`duplicate vlan ${v.id}`); continue; }
      vlans.set(v.id, v);
    }
    for (const n of nodes.values()) {
      for (const p of n.pluggables) {
        const ref = n.id + ':' + p.id;
        const seenTag = new Set();
        for (const vid of (p.tagged || [])) {
          if (seenTag.has(vid)) err(`${ref} lists vlan ${vid} twice`);
          seenTag.add(vid);
          if (vid === p.untagged) err(`${ref} has vlan ${vid} both untagged and tagged`);
          if (!vlans.has(vid)) warn(`${ref} references vlan ${vid} which is not defined yet`);
        }
        if (p.untagged && !vlans.has(p.untagged)) {
          warn(`${ref} references vlan ${p.untagged} which is not defined yet`);
        }
        if (p.fanout < 0) err(`${ref} has negative fanout`);
        for (const vid of [p.untagged, ...(p.tagged || [])]) {
          if (vid !== 0 && (vid < 1 || vid > 4094)) {
            err(`${ref} references vlan ${vid}, outside the valid range 1-4094`);
          }
        }
        for (const ip of (p.ips || [])) {
          if (!ip.trim()) err(`${ref} has an empty entry in ips`);
        }
      }
    }

    const used = new Map();
    for (const l of inv.links) {
      const desc = l.a + ' <-> ' + l.b;
      const pa = ports.get(l.a), pb = ports.get(l.b);
      if (!pa) warn(`${desc}: "${l.a}" does not exist yet`);
      if (!pb) warn(`${desc}: "${l.b}" does not exist yet`);
      if (!pa || !pb) continue;
      if (l.a === l.b) { err(`${desc}: both ends are the same pluggable`); continue; }
      // A planned cable records intent; counting it would make `free` lie.
      if (!l.planned) {
        for (const ref of [l.a, l.b]) {
          if (!used.has(ref)) used.set(ref, []);
          used.get(ref).push(desc);
        }
      }
      if (pa.type !== pb.type) err(`${desc}: type mismatch, ${l.a} is ${pa.type} and ${l.b} is ${pb.type}`);
      else if ((pa.dir === '') !== (pb.dir === '')) err(`${desc}: one end declares dir and the other does not`);
      else if (pa.dir && pa.dir === pb.dir) err(`${desc}: both ends are dir "${pa.dir}"`);
    }
    // Capacity: one cable per port unless `fanout` says otherwise, which is the
    // splitter case, one outlet legitimately feeding several devices.
    for (const ref of [...used.keys()].sort()) {
      const claims = used.get(ref);
      const p = ports.get(ref);
      const limit = p && p.fanout > 1 ? p.fanout : 1;
      if (claims.length > limit) {
        err(limit === 1
          ? `${ref} carries ${claims.length} cables: ${claims.join('; ')} (give it fanout, or model the splitter as a node)`
          : `${ref} has fanout ${limit} but carries ${claims.length} cables: ${claims.join('; ')}`);
      }
    }

    // A tag on one end of a cable and not the other is the classic trunk bug.
    for (const l of inv.links) {
      const pa = ports.get(l.a), pb = ports.get(l.b);
      if (!pa || !pb) continue;
      const any = pa.untagged || pb.untagged || (pa.tagged || []).length || (pb.tagged || []).length;
      if (!any) continue;
      if (pa.untagged !== pb.untagged) {
        warn(`${l.a} <-> ${l.b}: untagged vlan differs, ${pa.untagged} vs ${pb.untagged}`);
      }
      const gap = (x, y) => (x.tagged || []).filter(v => !(y.tagged || []).includes(v)).sort((m, n2) => m - n2);
      const ga = gap(pa, pb), gb = gap(pb, pa);
      if (ga.length) warn(`${l.a} <-> ${l.b}: vlan [${ga}] tagged on ${l.a} but not ${l.b}`);
      if (gb.length) warn(`${l.a} <-> ${l.b}: vlan [${gb}] tagged on ${l.b} but not ${l.a}`);
    }

    for (const l of inv.links) {
      for (const b of l.blocks) {
        if (!ports.has(b)) { warn(`${l.a} <-> ${l.b}: blocks "${b}" which does not exist yet`); continue; }
        if (used.has(b)) err(`${b} is blocked by ${l.a} <-> ${l.b} but is used by ${used.get(b).join('; ')}`);
      }
    }
    return out;
  }

  // ---- canonical form -----------------------------------------------------
  function canonical(inv) {
    // A `connected_with` can only live on a port that exists, and a port can
    // host exactly one. A second cable on the same port (fanout) must become an
    // explicit link, or the canonical form could not represent the graph and the
    // cable would silently disappear.
    const realPort = new Set();
    for (const n of inv.nodes) for (const p of n.pluggables) realPort.add(n.id + ':' + p.id);

    const owner = new Map();
    const rich = [];
    for (const l of inv.links) {
      let a = l.a, b = l.b;
      if (a > b) { a = l.b; b = l.a; }
      if (!l.label && !l.note && !l.planned && !l.poe && !l.blocks.length && !l.meta) {
        if (realPort.has(a) && !owner.has(a)) owner.set(a, b);
        else if (realPort.has(b) && !owner.has(b)) owner.set(b, a);
        else rich.push({ a, b });
        continue;
      }
      const o = { a, b };
      if (l.label) o.label = l.label;
      if (l.note) o.note = l.note;
      if (l.planned) o.planned = true;
      if (l.poe) o.poe = true;
      if (l.blocks.length) o.blocks = l.blocks.slice().sort();
      if (l.meta) o.meta = l.meta;
      rich.push(o);
    }
    rich.sort((x, y) => x.a < y.a ? -1 : x.a > y.a ? 1 : (x.b < y.b ? -1 : x.b > y.b ? 1 : 0));

    const nodes = inv.nodes.map(n => {
      const o = { id: n.id };
      if (n.label) o.label = n.label;
      if (n.type) o.type = n.type;
      if (n.virtual) o.virtual = true;
      if (n.hostname) o.hostname = n.hostname;
      if (n.parent) o.parent = n.parent;
      if (n.note) o.note = n.note;
      if (n.meta) o.meta = n.meta;
      if (n.pluggables.length) o.pluggables = n.pluggables.map(p => {
        const q = { id: p.id, type: p.type };
        if (p.dir) q.dir = p.dir;
        const cw = owner.get(n.id + ':' + p.id);
        if (cw) q.connected_with = cw;
        if (p.fanout) q.fanout = p.fanout;
        if (p.mac) q.mac = p.mac;
        if (p.ips && p.ips.length) q.ips = p.ips.slice();
        if (p.untagged) q.untagged = p.untagged;   // matches Go's omitempty on an int
        const tg = (p.tagged || []).slice();
        if (tg.length) q.tagged = tg.sort((x, y) => x - y);
        if (p.reserved) q.reserved = p.reserved;
        if (p.label) q.label = p.label;
        if (p.note) q.note = p.note;
        if (p.meta) q.meta = p.meta;
        return q;
      });
      return o;
    }).sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

    const doc = {};
    if (inv.fields && inv.fields.length) {
      doc.fields = inv.fields.slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(fieldOut);
    }
    if (inv.vlans && inv.vlans.length) {
      doc.vlans = inv.vlans.slice().sort((x, y) => x.id - y.id).map(v => {
        const o = { id: v.id };
        if (v.name) o.name = v.name;
        if (v.subnet) o.subnet = v.subnet;
        if (v.note) o.note = v.note;
        if (v.meta) o.meta = v.meta;
        return o;
      });
    }
    doc.nodes = nodes;
    if (rich.length) doc.links = rich;
    return doc;
  }

  // ---- emitter ------------------------------------------------------------
  // Hand-rolled rather than jsyaml.dump so the bytes match Go's yaml.v3
  // exactly: two-space indent, no folding, plain scalars where legal, map keys
  // sorted (Go sorts map keys; struct fields keep declaration order, which is
  // why canonical() builds objects in the right order).
  // Mirrors go-yaml v3's three-way choice, which is subtler than it looks:
  //   1. plain, when YAML allows it
  //   2. DOUBLE quotes, when the plain form would resolve as a non-string, so
  //      the quotes are what keep "1" and "yes" strings
  //   3. SINGLE quotes otherwise, e.g. 'has: a colon'
  // Getting this wrong does not corrupt anything, it just makes every diff
  // against `inv fmt` churn, which is the whole point of matching.

  // Mirrors go-yaml v3's three-way choice:
  //   1. plain, when YAML allows it AND the plain text reads back as this exact
  //      string
  //   2. DOUBLE quotes when plain would resolve to something else, so the quotes
  //      are what keep "1", "09" and "yes" strings
  //   3. SINGLE quotes otherwise, e.g. 'has: a colon'
  // Order matters. Checking "resolves to non-string" before plain-legality would
  // double-quote 'has: a colon', where Go single-quotes it.

  // Indicators only forbid a plain scalar at the very start, and `-?:` only when
  // followed by space or end of string. That is why `say "hi"` stays plain.
  const CTRL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
  // Explicit, rather than \s: \s also matches U+00A0, which Go emits plain, so
  // treating it as whitespace here would diverge on every non-breaking space.
  const EDGE_WS = /^[ \t\n]|[ \t\n]$/;
  function plainLegal(t) {
    if (t === '') return false;
    if (EDGE_WS.test(t)) return false;
    if (CTRL.test(t)) return false;
    if (/^[,[\]{}#&*!|>'"%@`]/.test(t)) return false;
    if (/^[-?:]($|\s)/.test(t)) return false;
    if (/:(\s|$)/.test(t)) return false;
    if (/\s#/.test(t)) return false;
    return true;
  }

  // Hand-written regexes cannot keep up with a YAML resolver: "09" is neither a
  // valid int nor an octal, yet it still reads back as the number 9. So ask the
  // parser instead of guessing, and keep a couple of regex fast paths for the
  // 1.1-era booleans js-yaml's core schema does not fold.
  const LEGACY_BOOL = /^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;
  // Go resolves YAML 1.1 underscore separators, so it reads `0_` as the integer
  // 0 while js-yaml keeps it a string. Quoting these keeps both sides agreeing
  // that it is a string.
  const UNDERSCORE_NUM = /^[-+]?(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*|0[xXoObB][0-9a-fA-F_]+)([eE][-+]?\d+)?$/;
  // Go accepts uppercase base prefixes and reads 0X1F as 31; js-yaml keeps it a
  // string. Quote it so both sides agree it is a string.
  const UPPER_BASE = /^[-+]?0([Xx][0-9a-fA-F_]+|[Oo][0-7_]+|[Bb][01_]+)$/;
  // Go resolves sexagesimals, so bare 12:30 becomes 750 there.
  const SEXAGESIMAL = /^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+$/;
  // A date-shaped string that is not a real date: js-yaml yields an Invalid Date
  // while Go keeps it a string, and neither side can be talked out of it. Such a
  // value is rejected in validate(), so it never reaches the emitter.
  const DATE_SHAPE = /^\d{4}-\d{1,2}-\d{1,2}$/;
  function badDateShape(s) {
    if (!DATE_SHAPE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return !(dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d);
  }
  function resolvesToNonString(s) {
    if (LEGACY_BOOL.test(s)) return true;
    if (s.includes('_') && UNDERSCORE_NUM.test(s)) return true;
    if (UPPER_BASE.test(s)) return true;
    if (SEXAGESIMAL.test(s)) return true;
    let v;
    try { v = jsyaml.load(s); } catch { return true; }
    return v !== s;
  }

  const ESC = {
    '\u0000': '\\0', '\u0007': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n',
    '\u000b': '\\v', '\f': '\\f', '\r': '\\r', '\u001b': '\\e',
    '"': '\\"', '\\': '\\\\',
    '\u0085': '\\N', '\u00a0': '\\_', '\u2028': '\\L', '\u2029': '\\P',
  };
  function dq(s) {
    let out = '"';
    for (const ch of s) {
      if (ESC[ch] !== undefined) { out += ESC[ch]; continue; }
      const c = ch.codePointAt(0);
      if (c < 0x20 || c === 0x7f) { out += '\\x' + c.toString(16).padStart(2, '0'); continue; }
      if (c > 0xffff) { out += '\\U' + c.toString(16).toUpperCase().padStart(8, '0'); continue; }
      out += ch;
    }
    return out + '"';
  }
  function sq(s) { return "'" + s.replace(/'/g, "''") + "'"; }

  const NON_BMP = /[\u{10000}-\u{10FFFF}]/u;

  function scalar(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    // js-yaml hands back a Date for a timestamp-shaped value. Without this it
    // fell through to isMap() and was emitted as `{}`.
    if (v instanceof Date) return v.toISOString().replace('.000Z', 'Z');
    const s = String(v);
    if (s === '') return '""';
    // Anything outside the BMP has to be escaped, which only double quotes can
    // do. This is checked before plain-legality because a non-plain string with
    // an emoji in it still needs the escape, not single quotes.
    if (NON_BMP.test(s) || CTRL.test(s)) return dq(s);
    if (plainLegal(s)) return resolvesToNonString(s) ? dq(s) : s;
    return sq(s);
  }

  function isMap(v) { return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date); }

  // sorted: true for free-form maps (meta), false for ordered records
  // A faithful port of yaml.v3's keyList.Less (sorter.go). Not just "compare
  // numeric runs numerically": when one side is a letter and the other a digit,
  // which one wins depends on whether digits were just consumed, which is why
  // `a1b` sorts before `a10b`. Any simplification diverges on real keys.
  function natLess(a, b) {
    const isDigit = c => c >= '0' && c <= '9';
    const isLetter = c => /\p{L}/u.test(c);
    const ar = [...a], br = [...b];
    let digits = false, ai = 0, bi = 0;
    for (; ai < ar.length && bi < br.length; ai++, bi++) {
      if (ar[ai] === br[bi]) { digits = isDigit(ar[ai]); continue; }
      const al = isLetter(ar[ai]), bl = isLetter(br[bi]);
      if (al && bl) return ar[ai] < br[bi];
      if (al || bl) return digits ? al : bl;
      let an = 0, bn = 0;
      if (ar[ai] === '0' || br[bi] === '0') {
        for (let k = ai - 1; k >= 0 && isDigit(ar[k]); k--) {
          if (ar[k] !== '0') { an = 1; bn = 1; break; }
        }
      }
      let ai1 = ai, bi1 = bi;
      for (; ai1 < ar.length && isDigit(ar[ai1]); ai1++) an = an * 10 + (ar[ai1].charCodeAt(0) - 48);
      for (; bi1 < br.length && isDigit(br[bi1]); bi1++) bn = bn * 10 + (br[bi1].charCodeAt(0) - 48);
      if (an !== bn) return an < bn;
      if (ai1 !== bi1) return ai1 < bi1;
      return ar[ai] < br[bi];
    }
    return ar.length < br.length;
  }

  function emitMap(obj, ind, out, sorted) {
    const pad = ' '.repeat(ind);
    let keys = Object.keys(obj);
    if (sorted) keys = keys.sort((x, y) => (natLess(x, y) ? -1 : natLess(y, x) ? 1 : 0));
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      // Keys go through scalar() too. Interpolating them raw meant a meta key
      // like `a: b` or `#x`, both typeable in the editor, produced a file that
      // would not parse or that silently lost the entry.
      const kk = scalar(k);
      if (Array.isArray(v)) {
        if (!v.length) { out.push(`${pad}${kk}: []`); continue; }
        out.push(`${pad}${kk}:`);
        emitSeq(v, ind + 2, out, sorted);
      } else if (isMap(v)) {
        if (!Object.keys(v).length) { out.push(`${pad}${kk}: {}`); continue; }
        out.push(`${pad}${kk}:`);
        emitMap(v, ind + 2, out, true); // nested maps are always free-form
      } else {
        out.push(`${pad}${kk}: ${scalar(v)}`);
      }
    }
  }

  function emitSeq(arr, ind, out, sorted) {
    const pad = ' '.repeat(ind);
    for (const item of arr) {
      if (isMap(item)) {
        const sub = [];
        emitMap(item, 0, sub, sorted);   // was hardcoded false, so meta seqs went unsorted
        if (!sub.length) { out.push(pad + '- {}'); continue; }
        out.push(pad + '- ' + sub[0]);
        for (let i = 1; i < sub.length; i++) out.push(pad + '  ' + sub[i]);
      } else if (Array.isArray(item)) {
        if (!item.length) { out.push(pad + '- []'); continue; }
        const sub = [];
        emitSeq(item, 0, sub, sorted);
        out.push(pad + '- ' + sub.join('\n' + pad + '  '));
      } else {
        out.push(pad + '- ' + scalar(item));
      }
    }
  }

  function emit(doc) {
    const out = [];
    emitMap(doc, 0, out, false);
    return out.join('\n') + '\n';
  }

  function serialize(inv) { return emit(canonical(inv)); }

  // A stable digest of the ENTIRE canonical document. Deliberately not a count
  // of ports and cables: that would not notice a dropped mac, ip, vlan or meta
  // value, and silently dropping a field is what this guard is for.
  function stable(v) {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = stable(v[k]);
      return o;
    }
    return v;
  }
  function fingerprint(inv) {
    return inv.nodes.length + 'n/' + (inv.fields || []).length + 'f/' + JSON.stringify(stable(canonical(inv)));
  }

  // Read straight off the model, deliberately NOT through canonical(). The
  // full-document fingerprint runs both sides through canonical(), so anything
  // canonical() itself drops is dropped on both sides and compares equal. These
  // two checks catch disjoint classes of bug and both are needed.
  function structure(inv) {
    const ports = [], cables = [];
    for (const n of inv.nodes) for (const p of n.pluggables) ports.push(n.id + ':' + p.id);
    for (const l of inv.links) cables.push(l.a > l.b ? l.b + '~' + l.a : l.a + '~' + l.b);
    ports.sort(); cables.sort();
    return ports.length + 'p/' + cables.length + 'c|' + ports.join(',') + '|' + cables.join(',');
  }

  function serializeChecked(inv) {
    const text = serialize(inv);
    const back = parse(text);
    if (structure(inv) !== structure(back)) {
      throw new Error('refusing to save: a port or cable would be lost. ' +
        'in: ' + structure(inv).split('|')[0] + ', out: ' + structure(back).split('|')[0]);
    }
    if (fingerprint(inv) !== fingerprint(back)) {
      throw new Error('refusing to save: output describes a different graph');
    }
    return text;
  }

  // ---- templates ----------------------------------------------------------
  // A template is a node with {{placeholders}} anywhere in it, including inside
  // ids and meta values, plus a `vars` list declaring them.
  const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;

  function substitute(v, vars) {
    if (typeof v === 'string') {
      return v.replace(PLACEHOLDER, (m, k) => vars[k] !== undefined ? String(vars[k]) : m);
    }
    if (Array.isArray(v)) return v.map(x => substitute(x, vars));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[substitute(k, vars)] = substitute(val, vars);
      return o;
    }
    return v;
  }

  function placeholdersIn(v, into) {
    into = into || new Set();
    if (typeof v === 'string') {
      PLACEHOLDER.lastIndex = 0;
      let m; while ((m = PLACEHOLDER.exec(v))) into.add(m[1]);
    } else if (Array.isArray(v)) {
      for (const x of v) placeholdersIn(x, into);
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) { placeholdersIn(k, into); placeholdersIn(val, into); }
    }
    return into;
  }

  // A field spec's id IS the meta key it describes. Declaring one buys a typed
  // input, a unit, an enum and range checks; `meta` stays open either way, so an
  // undeclared key is legal and merely flagged.
  function defaultControl(f) {
    const ty = s(f.type) || 'string';
    if (ty === 'boolean') return 'checkbox';
    if (ty === 'number' || ty === 'integer') return 'number';
    if (ty === 'enum') return f.open ? 'combo' : 'select';
    if (ty === 'composite') return 'composite';
    return 'text';
  }

  function parseSettings(text) {
    const doc = jsyaml.load(text) || {};
    const fields = asList(doc.fields).map(f => readField(f, 'settings')).filter(f => f.id);
    return { fields, templates: parseTemplates(text) };
  }

  // Same shape whether it is written into an inventory or into settings.yaml.
  function fieldOut(f) {
    const o = { id: f.id };
    if (f.label && f.label !== f.id) o.label = f.label;
    if (f.type && f.type !== 'string') o.type = f.type;
    if (f.control && f.control !== defaultControl(f)) o.control = f.control;
    if (f.unit) o.unit = f.unit;
    if (f.enum && f.enum.length) o.enum = f.enum.slice();
    if (f.open) o.open = true;
    if (f.min !== null && f.min !== undefined) o.min = f.min;
    if (f.max !== null && f.max !== undefined) o.max = f.max;
    if (f.applies_to && f.applies_to.length) o.applies_to = f.applies_to.slice();
    if (f.parts && f.parts.length) {
      o.parts = f.parts.map(q => {
        const r = { id: q.id };
        if (q.label && q.label !== q.id) r.label = q.label;
        if (q.type && q.type !== 'string') r.type = q.type;
        if (q.unit) r.unit = q.unit;
        return r;
      });
    }
    if (f.description) o.description = f.description;
    if (f.meta) o.meta = f.meta;
    return o;
  }

  function settingsDoc(fields, templates) {
    const doc = {};
    if (fields && fields.length) {
      doc.fields = fields.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map(fieldOut);
    }
    if (templates && templates.length) {
      doc.templates = templates.map(x => {
        const o = { id: x.id, group: x.group, label: x.label };
        if (x.vars.length) o.vars = x.vars.map(v => ({ name: v.name, label: v.label, default: v.default }));
        o.node = x.node;
        return o;
      });
    }
    return emit(doc);
  }

  // Checks a meta bag against the declared specs. Type and range problems are
  // errors: no amount of extra data makes `watts: "lots"` a number. An
  // undeclared key is not reported at all, because meta is open by design.
  function checkMeta(specs, where, meta, err) {
    for (const [k, v] of Object.entries(meta || {})) {
      const f = specs.get(k);
      if (!f) continue;
      if (v === '' || v === null) continue;   // an unfilled editor placeholder
      const num = typeof v === 'number';
      if ((f.type === 'number' || f.type === 'integer') && !num) {
        err(`${where}.${k} should be a ${f.type}${f.unit ? ' in ' + f.unit : ''}, got ${JSON.stringify(v)}`);
        continue;
      }
      if (f.type === 'integer' && num && !Number.isInteger(v)) {
        err(`${where}.${k} should be a whole number, got ${v}`);
      }
      if (num && f.min !== null && v < f.min) err(`${where}.${k} is ${v}, below the minimum ${f.min}`);
      if (num && f.max !== null && v > f.max) err(`${where}.${k} is ${v}, above the maximum ${f.max}`);
      if (f.type === 'boolean' && typeof v !== 'boolean') {
        err(`${where}.${k} should be true or false, got ${JSON.stringify(v)}`);
      }
      if (f.type === 'enum' && !f.open && f.enum.length && !f.enum.map(String).includes(String(v))) {
        err(`${where}.${k} is ${JSON.stringify(v)}, not one of: ${f.enum.join(', ')}`);
      }
      if (f.type === 'composite') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          err(`${where}.${k} should be a mapping of ${f.parts.map(q => q.id).join('/')}`);
        } else {
          const known = new Set(f.parts.map(q => q.id));
          for (const pk of Object.keys(v)) {
            if (!known.has(pk)) err(`${where}.${k} has part "${pk}", not one of: ${[...known].join(', ')}`);
          }
        }
      }
    }
  }

  function parseTemplates(text) {
    const doc = jsyaml.load(text) || {};
    return (doc.templates || []).map(t => {
      const declared = (t.vars || []).map(v => ({
        name: s(v.name),
        label: s(v.label) || s(v.name),
        default: v.default === undefined ? '' : String(v.default),
      }));
      // any placeholder used but not declared still gets a field, so a
      // hand-written template cannot silently leave {{gaps}} in the output
      const known = new Set(declared.map(v => v.name));
      for (const p of placeholdersIn(t.node || {})) {
        if (!known.has(p)) declared.push({ name: p, label: p, default: '' });
      }
      return {
        id: s(t.id), group: s(t.group) || 'other', label: s(t.label) || s(t.id),
        vars: declared, node: t.node || {},
      };
    });
  }

  // `specs` is the id -> field spec map, and is optional. Without it every meta
  // value a template fills in stays a string, because a placeholder has to be
  // quoted to be legal YAML: `volts: {{volts}}` is a flow mapping, not a scalar.
  // Shipped templates were therefore producing `volts: "48"` and `speed: "1"`, so
  // creating a node from a template immediately reported "should be a number in
  // V, got 48" against the very templates this repo ships.
  function fromTemplate(tpl, vars, src, specs) {
    const inv = emptyInv();
    absorb(inv, { nodes: [substitute(tpl.node, vars)] }, src || 'template');
    const node = inv.nodes[0];
    if (specs) {
      const get = k => (specs.get ? specs.get(k) : specs[k]);
      const fix = holder => {
        if (!holder.meta) return;
        for (const [k, v] of Object.entries(holder.meta)) {
          const spec = get(k);
          if (!spec || typeof v !== 'string' || v.trim() === '') continue;
          if (spec.type !== 'number' && spec.type !== 'integer') continue;
          // Only a value that is entirely a number. A serial like "0012" must not
          // silently become 12, and a serial is not a numeric field anyway.
          if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v.trim())) continue;
          const n = Number(v.trim());
          if (Number.isFinite(n)) holder.meta[k] = spec.type === 'integer' ? Math.trunc(n) : n;
        }
      };
      fix(node);
      for (const p of node.pluggables) fix(p);
    }
    return node;
  }

  // Turn a node you already built into a template, pulling a trailing number
  // out of the id into {{n}} so the next one is a two-field job.
  function toTemplate(node, id, group) {
    const clone = JSON.parse(JSON.stringify(canonical({ nodes: [node], links: [] }).nodes[0]));
    const vars = [];
    const m = /^(.*?)(\d+)$/.exec(clone.id);
    if (m) {
      const num = m[2];
      vars.push({ name: 'n', label: 'number', default: num });
      clone.id = m[1] + '{{n}}';
      if (clone.label && clone.label.includes(num)) clone.label = clone.label.split(num).join('{{n}}');
    }
    return { id, group: group || 'saved', label: node.label || id, vars, node: clone };
  }

  function templatesDoc(list) {
    return emit({
      templates: list.map(t => {
        const o = { id: t.id, group: t.group, label: t.label };
        if (t.vars.length) o.vars = t.vars.map(v => ({ name: v.name, label: v.label, default: v.default }));
        o.node = t.node;
        return o;
      }),
    });
  }

  return {
    resolve, resolveRef, splitRef, pairKey, emptyInv, absorb, desugar, parse,
    index, peerOf, cablesAt, capacity, slotsLeft, kind, compatible, validate, canonical, emit, serialize,
    fingerprint, structure, serializeChecked, scalar,
    substitute, placeholdersIn, parseTemplates, fromTemplate, toTemplate, templatesDoc,
    parseSettings, settingsDoc, defaultControl, checkMeta, readField, fieldOut,
  };
})();
/* ==== CORE END ==== */
