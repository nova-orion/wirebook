# Working on wirebook

Instructions for coding agents (Claude Code, Cursor, Aider, Codex, Copilot, and
friends). Read this before changing anything.

**Keep this file current.** If you change the data model, the canonical format,
the validation rules, or the test strategy, update this document and
`schema/inventory.yaml` in the same change. A stale AGENTS.md is worse than none,
because the next agent will trust it.

## What this is

A physical inventory of hardware and the cables between it. Two artifacts:

| Path | What |
|---|---|
| `index.html` | Markup, plus `settings.yaml` inline as a `<script type="application/yaml">` payload. |
| `js/core.js` | The model: parse, validate, canonicalise, emit. **Must stay DOM-free.** |
| `js/app.js` | The UI. |
| `css/wirebook.css` | Styles. |
| `third_party/` | Vendored js-yaml, used for *parsing* only. |
| `cmd/inv/main.go` | CLI: `validate`, `free`, `fmt`. |
| `schema/inventory.yaml` | JSON Schema (in YAML) for the inventory. |
| `schema/settings.yaml` | JSON Schema (in YAML) for settings. |
| `inventory.yaml` | The actual data. Canonical form, produced by `inv fmt`. |
| `settings.yaml` | Field specs and templates. Also embedded in `index.html`. |
| `test/core.test.mjs` | Unit tests. |
| `test/sweep.mjs` | Emitter parity enforcement. Run it after any emitter change. |

**Classic scripts, not ES modules, and the settings payload is inline rather
than fetched.** Both so `file://` keeps working: it blocks ES modules and
`fetch` alike. Do not "modernise" this without checking that opening
`index.html` from a clone still works.

**Field specs live in `inventory.yaml`, not in browser storage.** A top-level
`fields:` key carries the user's own definitions next to the data they describe,
so backing up that one file is sufficient. This is a hard requirement, not a
preference: a definition held only in localStorage disappears when site data is
cleared, and the values it described become uninterpretable. `settings.yaml`
holds only the *shipped defaults*, which are reproducible from the repo.

`embedUsedFields()` in `js/app.js` is what keeps the file self-contained: on every
serialisation it writes in any spec that is in use and not already provided by the
shipped defaults. It never prunes; a declared-but-unused spec is intent.

**Field specs are first class.** A spec's `id` in `settings.yaml` IS the meta key
it describes, which is why adding one needs no migration. `meta` stays open: an
undeclared key is legal and merely flagged in the UI. Units live on the spec,
never in the value, so numbers stay sortable. A test asserts the specs and the
schema's documented meta properties agree in both directions.

The YAML in git is the system of record. There is no database.

## The one rule that matters most

**`cmd/inv/main.go` and the CORE block in `index.html` must produce byte-identical
YAML.** The Go emitter and the JS emitter are two implementations of the same
canonical format. If they diverge, then saving from the UI reformats the whole
file and every git diff becomes unreadable noise, which destroys the main reason
the data lives in git.

This is enforced by `serialize matches inv fmt byte-for-byte` and
`vlan/fanout fixture matches inv fmt byte-for-byte` in the test suite.

**If you touch either emitter, you must touch both.** Specifically:
- key order (`canonical()` builds objects in the output order deliberately)
- `omitempty` behaviour: an empty field must be absent, not present-and-blank
- map keys are sorted; struct/record fields keep declaration order
- node ordering (by id), link ordering (by a then b), `tagged`/`blocks` sorted
- two-space indent, no line folding, and the three-way scalar quoting below

### Scalar quoting

This mirrors `go-yaml` v3 and is subtler than it looks. Three cases:

1. **Plain** when YAML permits it. Note `say "hi"` is plain: a quote only
   matters at the start of a scalar.
2. **Double quotes** when the plain text would resolve as a non-string, so the
   quotes are what keep `"1"`, `"007"`, `"yes"`, `"2024-03-01"` strings.
3. **Single quotes** otherwise, e.g. `'has: a colon'`, `'pad '`.

Getting this wrong does not corrupt data, it just makes every diff churn.

`node test/sweep.mjs` is the enforcement. It enumerates every 1- and 2-character
string over an alphabet of YAML-significant characters (about 1600 candidates),
emits them from the JS side, runs `inv fmt` over the result, and asserts the
bytes are identical. Run it after **any** emitter change. `WB_SWEEP_DIR=/tmp/x`
keeps the generated file so you can look at a divergence instead of guessing.

Three classes of value are refused by `validate` rather than round-tripped,
because go-yaml and js-yaml cannot be reconciled on them:

- **control characters** (C0, DEL, U+0085, U+2028, U+2029). go-yaml will emit
  some of these and then refuse to re-read the file it just wrote.
- **leading or trailing whitespace.** go-yaml drops it on the way back.
- **date-shaped strings that are not real dates**, like `9999-99-99`. js-yaml
  resolves it to an Invalid Date; go-yaml keeps it a string.

If you are tempted to relax one of these, run the sweep first. Each is there
because the alternative is a file one of the two tools cannot read.

Other things the two emitters must agree on, each of which was a real bug:

- **Map key order is a faithful port of yaml.v3's `keyList.Less`**, not a plain
  sort and not "compare digit runs numerically". When one side is a letter and
  the other a digit, which wins depends on whether digits were just consumed,
  which is why `a1b` sorts before `a10b`. Do not simplify `natLess`.
- **The empty string is `""`, not `''`.** `type` is not omitempty, so any
  typeless port would otherwise churn the whole file on every save.
- **A `Date` is not a map.** js-yaml hands back a `Date` for a timestamp-shaped
  value; without a guard it fell through and emitted `{}`.
- **Maps nested in a sequence inside `meta` are key-sorted**; `emitSeq` must
  pass its `sorted` flag through rather than hardcoding false.
- **Empty nested collections** emit `[]` / `{}`, never a bare `- `.
- **Multi-document YAML is refused.** Go used to decode only the first document
  and `fmt -w` then wrote the truncation back over the file, reporting success.
- **Nothing silently drops a value Go keeps.** `tagged: [-7, 0]` and
  `ips: [""]` are validation errors, not values to filter out on load. A filter
  is invisible to both guards, because it happens symmetrically on each side.

Places where Go's resolver is wider than js-yaml's, so the JS side has to quote
defensively: YAML 1.1 booleans (`yes`/`off`), underscore numerics (`1_000`),
uppercase base prefixes (`0X1F` reads as 31 in Go), and sexagesimals (`12:30`
reads as 750). The JS emitter also asks js-yaml itself whether a plain scalar
reads back unchanged, because no hand-written regex set keeps up: `09` is
neither a valid int nor an octal and still resolves to 9.

## The model, and its invariants

Two primitives plus VLANs.

- **node**: anything with a physical presence. A location, a server, a PSU
  brick, a drive. `parent` is containment, at any depth, with no limit.
- **pluggable**: a port on a node where a cable lands.
- **link**: one physical cable between two pluggables.
- **vlan**: defined once at the top level, referenced from ports.

Invariants you must not break without a very good reason:

1. **One cable per port.** `fanout: N` is the only escape hatch, for a splitter
   you would rather not model as its own node. This invariant is what makes the
   `free` report trustworthy, and `free` is the feature the user actually uses.
2. **A VLAN is not a second cable.** Multiple logical connections between the
   same two ports are VLANs riding one cable. They are *derived* from membership
   on both ends, never stored as extra links. If you find yourself adding links
   for VLANs, stop.
3. **Containment and connection are different edges.** A drive is both inside a
   server (`parent`) and cabled to it (`sata` link). Both are true. Do not
   collapse them.
4. **Nothing derived is stored.** What is on the UPS, what is behind the router,
   what is PoE powered: all of it is a walk over the graph. A stored copy drifts.
5. **`connected_with` is sugar.** It desugars into a link on load. Explicit links
   win over sugar so their `poe`/`blocks` survive; a pair declared from both ends
   collapses to one cable rather than colliding.
6. **`meta` is open.** Unknown keys are always allowed there. Everywhere else, an
   unknown key is a hard error (`KnownFields(true)` in Go, and the schema's
   `additionalProperties: false`). Do not weaken this: it is what catches a
   misspelled field instead of silently ignoring it.

## What belongs here, and what does not

**This records what is true about the hardware. It does not record what is
configured on it.** A second copy of something another system owns will drift,
and the drifted copy is worse than no copy, because it looks authoritative.

| belongs here | belongs elsewhere |
|---|---|
| ports, cables, the power chain | firewall rules, DNS and network profiles |
| MAC (burned into the NIC) | IP assignments (DHCP, or the config that pins them) |
| vendor, model, serial, cpu, ram, capacity | package state, service state |
| connector types, volts and amps off the brick | cluster node names, inventory keys |
| VLAN membership on a trunk | SSIDs, PSKs, VLAN definitions in the controller |
| which host a guest runs on | the guest's own configuration |

Two tests for whether a field earns its place:

1. **Would it change without the hardware changing?** If yes, something else owns
   it. A hostname is settable; a MAC is not.
2. **Can a mistake in it be detected here?** VLAN membership earned its way in
   because a tag on one end of a cable and not the other is a real, checkable
   cabling error. SSIDs did not, because catching an SSID/trunk mismatch needs
   several APs to be worth the model growth.

`meta` is open, so a user can record whatever they like. That is not licence for
the shipped defaults or an importer to populate config-shaped fields by default.

## Severity rule

Validation problems are either errors or warnings, and the test for which is
mechanical:

- **warning**: finishing your data entry would fix it. A parent or a port that
  does not exist yet, a VLAN not yet defined, a trunk mismatch.
- **error**: no amount of additional data can fix it. A duplicate id, a port
  claimed by two cables, a physically impossible link, a containment cycle.

Half-entered data must never block the user. `--strict` makes warnings fatal for
CI. If you add a check, classify it by that test and not by how serious it feels.

## Tests

```sh
mise run test          # everything: vet, build, JS suite, emitter sweep
node test/core.test.mjs
node test/sweep.mjs
```

Network is restricted here: Go module fetches need `GOPROXY=off` against the
local module cache. `gopkg.in/yaml.v3` is the only dependency and it is cached.

The suite runs `js/core.js` under `node:vm` with the vendored js-yaml. That is
how browser logic is tested without a browser and without a build step.
Consequences to know about:

- **`js/core.js` must stay DOM-free.** No `document`, no `window`, no
  `localStorage`, no `navigator`. If you need those, it belongs in `js/app.js`.
  A test enforces this after stripping comments.
- **Core lives in a different vm realm**, so its arrays and objects have
  different prototypes and `assert.deepStrictEqual` rejects them outright. Copy
  across the boundary first; the suite has an `arr()` helper for this.
- The UI code past the CORE marker is not executed by the suite, but it *is*
  compiled with `new vm.Script`, which catches syntax errors. Keep that test.

`META_KEYS` in `index.html` and the `meta` properties in
`schema/inventory.yaml` are asserted to match. Add a field to both or the suite
fails, which is the point.

## Adding a field

Ordered, because skipping a step silently loses data:

1. `schema/inventory.yaml`, so the editor autocompletes it.
2. `cmd/inv/main.go`: the input struct, the `out*` struct with `omitempty`, and
   `canonical()` in the right key position.
3. The CORE block in `index.html`: `absorb()` to read it, `canonical()` to write
   it in the *same* key position.
4. If it is a documented `meta` key, add it to `META_KEYS` too. A test asserts
   `META_KEYS` and the schema agree.
5. A test proving it survives load → save. Without this, step 2 or 3 being
   missed means the UI erases the field on the next save.
6. Surface it in the UI, or it is undiscoverable.

Step 3 is the one that gets forgotten. `absorb()` ignoring an unknown field means
a load-then-save cycle **deletes user data**, and the fingerprint check will not
notice because it only covers nodes, ports and cables.

## Style

- No comments in the data files. The canonical form drops them, deliberately, so
  a UI round trip is lossless. Put explanation in `note:` or `meta:`.
- Go: standard `gofmt`. Comments explain why, not what.
- JS: no framework, no build, no dependencies beyond the vendored js-yaml. Plain
  DOM via the `el()` / `svgEl()` helpers.
- Prefer deleting code to adding flags.
