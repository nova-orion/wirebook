# wirebook

Documents physical hardware and the cables between it. What is plugged into
what, via which port, and where you can still plug something in.

Built for a homelab, but there is nothing homelab-specific in it: racks, desks,
AV setups and electrical panels all fit the same two primitives.

## Why files instead of a service

The data is a YAML file in git. So every edit is a commit, every version is
restorable, and it is replicated to every clone and remote you have. Losing it
means losing git.

There is nothing to run. No container, no port, no database, no volume to back
up, no migration to break. The editor is one HTML file you open in a browser; it
reads and writes your YAML directly through the File System Access API.

This matters more than it sounds. Every lightweight tool in this space stores
your inventory in a SQLite file or a Postgres volume, and then durability is your
problem. Here it is git's problem, which git is good at.

## What it does that a wiki or a spreadsheet cannot

- **Tells you where a cable can go.** `free` lists every unplugged port, and the
  connect picker only offers ports that are physically compatible, so an invalid
  cable is not something you can record and discover later.
- **Knows a socket can be blocked without being used.** The wall-wart problem: a
  brick in outlet 1 overhangs and eats outlet 2. Record it once and outlet 2
  stops being offered.
- **Models adapters as real objects.** A PSU brick can fail, get lost, or be the
  wrong one. It is a node with an input and an output, so the chain reads
  outlet → brick → device, which is what is actually true.
- **Catches trunk mistakes.** A VLAN tagged on one end of a cable and not the
  other is the classic misconfiguration, and it is reported.
- **Nests without limit.** Room → rack → server → NIC → port, as deep as you
  like, and the graph draws that nesting as boxes inside boxes rather than as a
  flat row of siblings.
- **Lets one socket carry several cables.** Two small plugs really do fit in one
  universal socket, so a port has a `fanout` and a full port still offers to take
  another. Note which way round this is: `fanout` is one hole carrying several
  cables, `blocks` is one plug covering a different hole.
- **Traces a run through the mess.** Click a cable in the graph and it lights up
  what feeds it and what it goes on to feed, with the exact sockets marked and
  everything else faded. It follows direction, so it does not wander sideways
  into the other things sharing the same wall socket. Click a box instead and you
  get everything that box is plugged into, one hop.
- **Lays out by chain, not just by room.** Columns are steps along a cable run,
  so a wall socket is on the left and whatever it eventually feeds is on the
  right. Locations are drawn as a boundary around their members, which still
  works when everything lives in one room and the room axis buys you nothing.
- **Records what a cable carries when the connector cannot say.** A USB lead may
  be power, data or both; `meta.carries` settles it, and the graph filters
  accordingly instead of filing a phone charger under "other" beside HDMI.

## How this differs from NetBox, homelable, openDCIM and friends

Short version: this trades away everything a team needs in order to model one
thing nothing else models, and to run with no server.

| | NetBox | homelable / homelab-hub | openDCIM | wiki or spreadsheet | wirebook |
|---|---|---|---|---|---|
| runs as | service + Postgres + Redis | service + DB | LAMP | service | nothing |
| memory | ~700MB tuned, 4GB recommended | a few hundred MB | ~250MB | ~300MB | 0 |
| stores data in | database | database | database | prose or cells | YAML in git |
| API, RBAC, audit log | yes | partial | thin | no | no |
| auto-discovery | via plugins | yes | no | no | **no, by design** |
| adapters as objects | no | no | no | no | **yes** |
| a socket blocked but unused | no | no | no | no | **yes** |
| rack elevations | yes | yes | yes | no | **no** |

### NetBox

**If you can spare the RAM and you want an API, RBAC or a change log, use
NetBox.** It is the serious tool in this space, its model is right, and its
community is enormous. This exists because a 4GB recommendation is a lot for
documenting thirty devices, and because NetBox's power model is rack-shaped:
panels, feeds, PDUs, outlets. It has no concept of a wall wart that physically
overhangs and blocks the socket next to it, which in a homelab is the constraint
you actually hit.

### homelable, homelab-hub and the newer homelab-specific apps

These are the closest in spirit and they render racks far better than this does
(this has no rack elevation at all). The structural difference is what the
primary object is. In those tools the **canvas** is primary and devices are
attached to canvases, so a rack view and a topology view hold separate sets of
edges that then need syncing. As of writing, homelable's sync runs one way only:
it derives rack patches from diagram links, not the reverse, so a cable you draw
on the rack never reaches the topology.

Here there is **one graph** and the views are renderers over it. A cable is a
cable. That whole class of desync cannot occur, which is the entire reason for
the design rather than a feature.

### openDCIM

Genuinely good electrical modelling, and lighter than NetBox. Its power model is
more complete than this one for real data centre work: branch circuits,
three-phase, computed load per breaker. Weaker on IPAM, thin API, and the UI is
of its era.

### Wikis and spreadsheets

A wiki holds prose, so it cannot answer "where can this cable go". A spreadsheet
can hold the data but `.xlsx` does not diff in git, so you lose the history that
makes documentation trustworthy, and nothing validates a row.

### When not to use this

Being straight about it:

- **You want auto-discovery.** There is none, deliberately. Everything is typed
  in by hand.
- **More than one person edits it.** Git is the audit trail, but there is no
  concurrent editing and no locking. Two browser tabs will warn each other and
  that is the extent of it.
- **Another system needs to query it.** There is no API. The YAML parses in three
  lines in any language, which is not the same thing.
- **You want rack elevations, or a floor plan.** Not implemented.
- **Tens of thousands of devices, or an editing team.** See the measured limits
  below; the ceiling is the single-file, single-editor model long before it is
  the code.

## How big it goes

Measured, not guessed. A generated inventory of **2,120 nodes, 7,040 ports and
2,920 cables** across 40 racks, on an ordinary laptop:

| | |
|---|---|
| `inv validate` | 0.07s, 31 MB |
| `inv free` | 0.06s, 28 MB |
| `inv fmt` | 0.24s, 97 MB |
| open the file in the browser | 0.33s |
| slowest view to draw (graph) | 0.23s |
| what Save writes | 0.11s |

So the numbers are comfortable two orders of magnitude above a homelab. What
actually limits you is the design, not the speed: one file, one editor, no
locking, and a graph that becomes unreadable long before it becomes slow. Treat a
few thousand devices as the point where you should want a database and an API
instead, which is what NetBox is for.

## Layout

```
index.html            markup, plus the built-in settings as an inline payload
css/wirebook.css
js/core.js            the model: parse, validate, canonicalise, emit. No DOM.
js/app.js             the UI
third_party/          vendored js-yaml, for parsing only
cmd/inv/              the CLI
schema/               JSON Schema for both yaml files, written in YAML
settings.yaml         field specs + templates
inventory.yaml        your data
```

Classic scripts, not ES modules, and the settings payload is inline rather than
fetched. Both so the page still *loads* from `file://`, which blocks ES modules
and `fetch` alike. Reading and writing your file needs it served, see above.

## Quick start

Try it at **<https://nova-orion.github.io/wirebook/>**, or serve it yourself:

```sh
git clone https://github.com/nova-orion/wirebook && cd wirebook
python3 -m http.server 8099     # then open http://localhost:8099/
```

Hit **Open** and pick your `inventory.yaml`, or start adding nodes and save a new
one. Work is autosaved to the browser as you go; **Save** asks whether to
overwrite the file you opened or write a new one.

**It has to be served, not opened as a file.** The page itself loads fine from
`file://`, but Chromium does not grant the File System Access API to `file://`
origins, so Open and Save would degrade to downloads. `http://localhost` counts
as a secure context, which is why the one-liner above is the local recipe.

Chromium only for the full experience: Chrome, Edge, Brave, Opera. Firefox and
Safari implement no access to your own files, so there it is
download-and-move-it-yourself.

## How the browser gets write access to a real file

Reasonable thing to be suspicious of, so here is exactly how it works. This uses
the **File System Access API**, not the download flow.

1. **The picker is the grant.** `showOpenFilePicker()` can only be called from a
   real click, and the OS dialog you get *is* the permission: picking a file
   grants read access to that one file. There is no way for the page to open a
   picker on its own or to guess a path.
2. **Writing prompts separately.** The first `createWritable()` on that handle
   raises a browser prompt ("let this site edit <file>?"). Save-As grants write
   as part of choosing the destination.
3. **Scope is that file, nothing else.** A file handle is not a directory
   handle: it cannot see the parent, siblings, or anything else on disk.
   Chromium also refuses handles for sensitive locations outright.
4. **Permission is per session by default.** Reload the page and the grant is
   gone; the handle has to be re-authorised. Handles can be stashed in IndexedDB
   to survive a reload, but re-use still needs a fresh click-triggered prompt.
   *This app does not persist the handle yet, so after a reload the first Save
   re-asks where to write. That is a known rough edge, not a security boundary.*
5. **Secure context only.** https or `localhost`. On plain http the API simply
   does not exist, which is why the deployment notes insist on TLS.
6. **Chromium only.** Chrome, Edge, Brave, Opera. Firefox and Safari implement
   only the private sandboxed filesystem, not access to your own files, so there
   they fall back to download-and-move.

### What that means for trusting a hosted copy

The app makes no network requests at all: your inventory never leaves the
machine, and the shipped nginx config sets `connect-src 'self'` to keep it that
way.

But be clear-eyed about the difference between running it locally and loading it
from a URL. **From a URL you are trusting whoever serves the JavaScript**, every
time you load it, with read and write access to the file you pick. Serving it from
your own clone, or from an image you built yourself, removes that trust
entirely. That is a real argument for the local path, and the reason
this is distributed as files you can read rather than only as a hosted app.

## The model

Two primitives, plus VLANs.

```yaml
vlans:
  - {id: 10, name: mgmt, subnet: 10.0.10.0/24}

nodes:
  - id: loc/office
    label: Office
    type: location

  - id: net/sw-1
    label: UniFi Flex Mini
    type: switch
    hostname: sw1.lan
    parent: loc/office
    pluggables:
      - id: p1
        type: eth
        untagged: 10
        connected_with: compute/pc-1:eth0
      - id: dc
        type: power
        dir: in
```

- **nodes** are anything physical: places, devices, PSU bricks, drives.
  `parent` is containment.
- **pluggables** are ports. `type` is load-bearing: a cable is only legal
  between two ports of the same type. `dir` marks one-way connectors, where
  `out` is the providing side.
- **links** are cables. VLANs ride them; they never create extra ones.

## Two ways to write a cable

Usually on the port itself, where you are already looking:

```yaml
- id: eth0
  type: eth
  connected_with: net/sw-1:p3
```

Declare it from one end or both; naming each other collapses to one cable.

Use a `links` entry when the cable carries something belonging to the connection
rather than to either end, which means `poe` and `blocks`:

```yaml
links:
  - a: power/ups-1:out1
    b: power/pdu-1:inlet
    note: pdu brick overhangs, out2 is dead space
    blocks: [power/ups-1:out2]
```

Both become the same graph.

## CLI

```sh
mise run check     # validate: broken refs, duplicates, impossible cables, cycles
mise run free      # every unplugged port, and blocked ones with reasons
mise run fmt       # rewrite inventory.yaml in canonical form
```

Errors are contradictions and fail the build. Warnings are things that finishing
your data entry will resolve, and do not. `--strict` makes warnings fatal once
you are done entering.

`fmt` renders the canonical bytes, parses them back, compares a fingerprint of
every port and cable against the input, and refuses to write at all unless they
match. Then it writes to a temp file and renames, so an interrupted run leaves
the original intact.

## Custom fields

Anything beyond the built-in shape lives in `meta`, and `meta` is open: any key
is legal. Declaring a key in `settings.yaml` makes it *first class*.

```yaml
fields:
  - { id: speed, label: Link speed, type: number, unit: gbps, applies_to: [pluggable] }
  - { id: poe_standard, label: PoE standard, type: enum, applies_to: [pluggable],
      enum: ["802.3af", "802.3at", "802.3bt", passive] }
  - { id: tip, label: Device-side connector, type: enum, control: combo, open: true,
      enum: ["barrel 5.5x2.1", usb-c, molex] }
```

**A field spec's `id` *is* the meta key.** So declaring `speed` immediately
applies to every port that already has a `speed`. There is no migration and the
inventory format does not change; the spec just adds meaning to a key you were
already using.

### Your definitions live in your inventory file

The only thing you need to back up is `inventory.yaml`.

Field definitions you create are written **into that file**, under a top-level
`fields:` key, next to the data they describe. Nothing important lives in browser
storage, because a definition held only there would be gone the first time you
cleared site data, and the values it described would become uninterpretable.

Only the fields the shipped defaults do not already cover get written, and the
editor adds them automatically as soon as you use one, so the file always stands
alone. Because the definitions travel with the data, `inv validate` can
type-check your meta in CI:

```
error: b.my_watts should be a number in W, got lots
error: b.rack_side is sideways, not one of the declared values
```

Declaring one buys you a typed input, the unit shown beside it, a dropdown for
enums, range checks, and a hard error if you type text into a number.

### Units go on the spec, never in the value

`speed: 2.5` with the spec saying gbps stays sortable and comparable.
`speed: "2.5 gbps"` is prose you would have to parse back. Store values in the
spec's unit. 25 of the shipped fields carry units: `V`, `A`, `W`, `Hz`, `gbps`,
`GB`, `m`, `U`, `mm`, `kg`, `dB`, `rpm`, `USD`.

### Controls

`type` is the shape of the stored value; `control` is the widget, and it defaults
sensibly from the type so you rarely set it.

| control | for |
|---|---|
| `text` / `textarea` | strings |
| `number` | numbers, with `min` / `max` |
| `checkbox` | booleans |
| `select` | a closed list |
| `combo` | a dropdown that *also* accepts anything you type (`open: true`) |
| `composite` | several inputs making one value |

`composite` stores a **nested object**, one key per part, so `dimensions` with
parts w/d/h stores `{d: 210, h: 45, w: 300}`. Deliberately not a formatted string
like `300x210x45`: that would have to be parsed back, and this way each part
keeps its own type and unit.

### Where the shipped defaults come from

The copy built into the page, until you change something; after that, your copy in
this browser. There's a **reset to repo default** button in Settings.

Nothing is fetched from a server, deliberately. A served settings file could only
ever do what the built-in copy already does, because the browser cannot write back
to it — so it would be machinery for no gain. That also means the deployment is
completely stateless: no volume, nothing to back up.

This only covers the *shipped defaults*: labels, units, validation, templates.
Your own field definitions live in your inventory file, so losing browser storage
costs you nothing you cannot regenerate.

### Undeclared keys stay legal

An ad hoc key is not an error, because `meta` is open by design. The editor marks
it, and the Settings view lists every undeclared key in use with a one-click
**declare** button, which doubles as a typo detector: `wattts` looks exactly like
this.

## Templates

`settings.yaml` also holds reusable node shapes with `{{placeholders}}`, so the
second Flex Mini is two fields rather than five ports retyped. Defaults for
common gear ship inside `index.html`. Built a node you own more than one of? Open
it and hit **save as template**.

## Editing

The sidebar holds your inventory and nothing else; the application's own
navigation is on the toolbar, so a node called "View" cannot be confused with the
view called View. Beyond that:

- **Tree**: drag a row onto another to move it inside that one, or onto the strip
  at the bottom to bring it back to the top level. A drop that would make
  something its own ancestor is refused. Ctrl+click, middle click or the peek
  button opens a node in a dialog so you keep your place.
- **Graph**: single click selects, double click opens, drag pans, ctrl+scroll
  zooms toward the pointer.
- **Back** works. Every view and node is a real URL, so the browser's back button
  walks back through where you have been, and any view can be bookmarked.
- Every labelled control carries its own one-line explanation, rather than a
  paragraph at the top of the page that leaves each individual box unexplained.

## Tests

```sh
npm run setup                 # once: playwright and chromium
npm test                      # model, stub DOM, real browser, emitter parity
node test/explore.mjs         # exploratory crawler
```

The browser logic and the Go CLI are two implementations of one canonical
format, and the suite asserts they emit byte-identical YAML.

Anything a user can see is tested in real Chromium, because a stubbed DOM cannot
dispatch an event, compute a style or lay anything out, and a suite of those
passed for weeks while the shipped editor deleted every field you added to it.
`test/explore.mjs` goes further and clicks everything it can find with hostile
values, to catch what nobody thought to write a test for. See
[AGENTS.md](AGENTS.md) before changing either implementation.

## Editor support

`schema/inventory.yaml` is a JSON Schema written in YAML. Point your editor at
it with a modeline on line 1 of your data file:

```yaml
# yaml-language-server: $schema=./schema/inventory.yaml
```

Works in VS Code with `redhat.vscode-yaml`, and in Neovim via `yamlls`. If your
editor flags a property that plainly exists in the schema, it is serving a cached
copy; reload the window.

## Running it on a cluster

There is a `Dockerfile` (unprivileged nginx, static files only, no inventory
baked in) and an example `deploy/k8s.yaml`. Images build to GHCR via
`.github/workflows/docker.yml`.

It is stateless: no volume, no database, nothing to back up.

**Serve it over TLS.** The File System Access API only exists in a secure
context, so over plain http on a LAN address the editor cannot open or save your
file in place and falls back to downloads. `kubectl port-forward` to localhost
also counts as secure, which makes it a good way to try it before setting up DNS.

## GitHub Pages

`.github/workflows/pages.yml` publishes the editor. Set Settings > Pages > Source
to "GitHub Actions" first. Free on a public repo; from a private repo Pages needs
GitHub Pro or higher.

The workflow publishes only the app. Your inventory is never uploaded by the
editor, which reads it from your own disk. But note that committing
`inventory.yaml` to a **public** repo publishes your hostnames, IPs, MACs,
serials and management URLs, which is a separate decision worth making
deliberately.

## Disclaimer

**This was built with heavy use of an LLM.** It is tested (see
[AGENTS.md](AGENTS.md) for what that means: unit tests plus an exhaustive
emitter-parity sweep, because the two implementations of the file format have to
agree byte for byte), but that is not the same as being battle-tested by many
users over years. Read the code before you trust it with data you care about.

It is also worth saying that the data format is deliberately boring for exactly
this reason: it is plain YAML in git. If the tooling turns out to be wrong, your
inventory is still a text file you can read, diff, and fix by hand.

**No warranty at all.** See [LICENSE](LICENSE). In plain terms: this is provided as is,
it might lose your data, keep it in git and keep git backed up.

## Issues and feature requests

Welcome, and read. If a request is something the maintainer also wants, it may
get worked on. If not, it probably will not, which is not a judgement on the idea.
There is no roadmap and no support commitment. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[0BSD](LICENSE) — BSD with the attribution clause removed, so do whatever you
like with it and you do not have to credit anyone. It is the most permissive
OSI-approved licence there is; MIT and BSD-2-Clause are equivalent to each other
and both still require you to keep a copyright notice, which this does not.

The vendored `third_party/js-yaml.min.js` is js-yaml, which *is* MIT, so its
notice does have to be kept. It lives in `third_party/js-yaml.LICENSE`.
