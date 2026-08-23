// Command inv checks the homelab inventory, reports what is still unplugged,
// and canonicalises the files.
//
// validate and free only read. fmt writes, and only when asked with -w or -o:
// it renders the canonical bytes, parses them back, compares a fingerprint of
// every port and cable against the input, and refuses to write at all unless
// they match. It then writes to a temp file and renames, so an interrupted run
// leaves the original intact rather than truncated. The yaml in git remains the
// system of record; losing data would mean losing git.
//
// The inventory is a single yaml file, or every *.yaml directly inside a
// directory. Each file may hold `nodes`, `links`, or both; they are merged, so
// the split across files is for human convenience and can change freely.
//
// Usage:
//
//	inv validate [path] [--strict]
//	inv free     [path]
//	inv fmt      [path] [-w | -o dest]
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"

	"gopkg.in/yaml.v3"
)

const (
	singleFile  = "inventory.yaml"
	multiDir    = "inventory"
	exampleFile = "inventory.example.yaml"
)

// defaultTarget prefers the consolidated single file, falling back to the
// directory, so both layouts work without anyone passing a path.
func defaultTarget() string {
	if _, err := os.Stat(singleFile); err == nil {
		return singleFile
	}
	if fi, err := os.Stat(multiDir); err == nil && fi.IsDir() {
		return multiDir
	}
	// Neither exists: name the single file, so the error and the hint are about
	// the thing the user is actually missing.
	return singleFile
}

type Pluggable struct {
	ID            string         `yaml:"id"`
	Type          string         `yaml:"type"`
	Dir           string         `yaml:"dir"`
	ConnectedWith string         `yaml:"connected_with"` // sugar for a link; desugared in load
	Fanout        int            `yaml:"fanout"`         // >1 lets one output feed several cables
	Mac           string         `yaml:"mac"`
	IPs           []string       `yaml:"ips"`
	Untagged      int            `yaml:"untagged"` // native vlan
	Tagged        []int          `yaml:"tagged"`   // trunked vlans
	Reserved      string         `yaml:"reserved"` // kept free on purpose, and why
	Label         string         `yaml:"label"`
	Note          string         `yaml:"note"`
	Meta          map[string]any `yaml:"meta"`
}

// Field declares a meta key. The spec's ID *is* the key, so declaring one adds
// meaning to data that already exists and needs no migration.
//
// These live in inventory.yaml rather than alongside the shipped defaults on
// purpose: they describe the user's data, so backing up the inventory has to be
// enough to keep them. Anything held only in browser storage would be lost the
// first time site data was cleared.
type Field struct {
	ID          string         `yaml:"id"`
	Label       string         `yaml:"label"`
	Type        string         `yaml:"type"`
	Control     string         `yaml:"control"`
	Unit        string         `yaml:"unit"`
	Enum        []any          `yaml:"enum"`
	Open        bool           `yaml:"open"`
	Min         *float64       `yaml:"min"`
	Max         *float64       `yaml:"max"`
	AppliesTo   []string       `yaml:"applies_to"`
	Description string         `yaml:"description"`
	Parts       []FieldPart    `yaml:"parts"`
	Meta        map[string]any `yaml:"meta"`

	src string
}

type FieldPart struct {
	ID    string `yaml:"id"`
	Label string `yaml:"label"`
	Type  string `yaml:"type"`
	Unit  string `yaml:"unit"`
}

// Vlan is defined once and referenced from ports. VLANs deliberately do NOT
// create extra links: one cable stays one cable, and the logical connections
// riding it are derived from the membership on both ends.
type Vlan struct {
	ID     int            `yaml:"id"`
	Name   string         `yaml:"name"`
	Subnet string         `yaml:"subnet"`
	Note   string         `yaml:"note"`
	Meta   map[string]any `yaml:"meta"`

	src string
}

type Node struct {
	ID         string         `yaml:"id"`
	Label      string         `yaml:"label"`
	Type       string         `yaml:"type"`
	Virtual    bool           `yaml:"virtual"` // a VM or container: no physical ports
	Hostname   string         `yaml:"hostname"`
	Parent     string         `yaml:"parent"`
	Note       string         `yaml:"note"`
	Meta       map[string]any `yaml:"meta"`
	Pluggables []Pluggable    `yaml:"pluggables"`

	src string // file it came from, for error messages
}

type Link struct {
	A       string         `yaml:"a"`
	B       string         `yaml:"b"`
	Label   string         `yaml:"label"`
	Note    string         `yaml:"note"`
	Planned bool           `yaml:"planned"` // intended, not yet run
	PoE     bool           `yaml:"poe"`
	Blocks  []string       `yaml:"blocks"`
	Meta    map[string]any `yaml:"meta"`

	src string
}

// Defaults are per-file, so the common case is not repeated on every entry.
type Defaults struct {
	Namespace string `yaml:"namespace"`
	Parent    string `yaml:"parent"`
}

// document is the shape of a single file on disk.
type document struct {
	Defaults Defaults `yaml:"defaults"`
	Fields   []Field  `yaml:"fields"`
	Vlans    []Vlan   `yaml:"vlans"`
	Nodes    []Node   `yaml:"nodes"`
	Links    []Link   `yaml:"links"`
}

// Inventory is every document merged, in file order.
type Inventory struct {
	Fields []Field
	Vlans  []Vlan
	Nodes  []Node
	Links  []Link
	Files  []string
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}
	cmd := args[0]

	inPlace, strict, out := false, false, ""
	target := ""
	for i := 1; i < len(args); i++ {
		switch a := args[i]; {
		case a == "-w" || a == "--write":
			inPlace = true
		case a == "--strict":
			strict = true
		case a == "-o":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "inv: -o needs a path")
				os.Exit(2)
			}
			i++
			out = args[i]
		default:
			target = a
		}
	}
	if target == "" {
		target = defaultTarget()
	}

	inv, err := load(target)
	if err != nil {
		fmt.Fprintln(os.Stderr, "inv:", err)
		// A fresh clone has no inventory.yaml, since it is gitignored: it is the
		// user's data and this repo is public. Say so rather than just failing.
		if os.IsNotExist(err) && target == singleFile {
			if _, e := os.Stat(exampleFile); e == nil {
				fmt.Fprintf(os.Stderr,
					"\nThere is no %s yet. To start from the shipped example:\n"+
						"    cp %s %s\n"+
						"Or point at any file: inv %s %s\n",
					singleFile, exampleFile, singleFile, cmd, exampleFile)
			}
		}
		os.Exit(1)
	}

	switch cmd {
	case "validate":
		var nerr, nwarn int
		for _, p := range validate(inv) {
			kind := "error"
			if p.warn {
				kind, nwarn = "warn", nwarn+1
			} else {
				nerr++
			}
			fmt.Fprintf(os.Stderr, "%s: %s\n", kind, p.msg)
		}
		if nerr > 0 || (strict && nwarn > 0) {
			fmt.Fprintf(os.Stderr, "\n%d error(s), %d warning(s)\n", nerr, nwarn)
			os.Exit(1)
		}
		if nwarn > 0 {
			fmt.Fprintf(os.Stderr, "\n%d warning(s), not fatal\n", nwarn)
		}
		fmt.Printf("ok: %d nodes, %d links, %d ports\n",
			len(inv.Nodes), len(inv.Links), countPorts(inv))
	case "free":
		fmt.Print(free(inv))
	case "fmt":
		data, err := format(inv)
		if err != nil {
			fmt.Fprintln(os.Stderr, "inv:", err)
			os.Exit(1)
		}
		dest := out
		if dest == "" && inPlace {
			dest = target
		}
		if dest == "" {
			os.Stdout.Write(data)
			return
		}
		if fi, err := os.Stat(dest); err == nil && fi.IsDir() {
			fmt.Fprintf(os.Stderr, "inv: %s is a directory; fmt writes one file, pass -o <file>\n", dest)
			os.Exit(2)
		}
		if err := writeAtomic(dest, data); err != nil {
			fmt.Fprintln(os.Stderr, "inv:", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "wrote %s (%d nodes, %d ports)\n", dest, len(inv.Nodes), countPorts(inv))
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `inv - homelab inventory tool

  inv validate [path] [--strict]   check the graph; --strict makes warnings fatal
  inv free     [path]            unplugged ports, and blocked ones with reasons
  inv fmt      [path] [-w|-o f]  canonicalise: absolute ids, sorted, no defaults

path may be a single yaml file or a directory of them.
Defaults to `+singleFile+` if it exists, otherwise `+multiDir+`.

fmt prints to stdout unless -w (rewrite in place) or -o (write elsewhere).
Both write atomically, and refuse to write output that does not read back
identically to the input.
`)
}

func countPorts(inv *Inventory) int {
	n := 0
	for i := range inv.Nodes {
		n += len(inv.Nodes[i].Pluggables)
	}
	return n
}

// load reads a single yaml file, or every *.yaml directly inside a directory,
// and merges them into one graph.
func load(target string) (*Inventory, error) {
	info, err := os.Stat(target)
	if err != nil {
		return nil, err
	}
	var paths []string
	if info.IsDir() {
		paths, err = filepath.Glob(filepath.Join(target, "*.yaml"))
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			return nil, fmt.Errorf("no *.yaml found in %s", target)
		}
	} else {
		paths = []string{target}
	}

	inv := &Inventory{}
	for _, path := range paths {
		// Glob is non-recursive, which is why the schema lives in schema/ rather
		// than beside the data: it stays out of this list, and out of the
		// editor's glob, without needing a special case.
		base := filepath.Base(path)
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		dec := yaml.NewDecoder(f)
		// A misspelled key is an error rather than silently ignored data. Only
		// `meta` is open, and it is a map, so it stays free.
		dec.KnownFields(true)
		var doc document
		err = dec.Decode(&doc)
		if err != nil && !errors.Is(err, io.EOF) { // EOF means an empty file
			f.Close()
			return nil, fmt.Errorf("%s: %w", base, err)
		}
		// A `---` separated stream used to lose every document after the first,
		// and `fmt -w` then wrote the truncated result back over the file with a
		// success message. Refuse instead; the editor cannot express one either.
		if err == nil {
			var extra document
			if err2 := dec.Decode(&extra); err2 == nil {
				f.Close()
				return nil, fmt.Errorf("%s: multi-document YAML is not supported, "+
					"split it into separate files", base)
			}
		}
		f.Close()
		absorb(inv, &doc, base)
		inv.Files = append(inv.Files, base)
	}
	desugar(inv)
	return inv, nil
}

// absorb merges one parsed document into inv, applying that file's namespace
// and default parent. Shared by load and by the read-back check in format, so
// the two can never disagree about what a file means.
func absorb(inv *Inventory, doc *document, src string) {
	ns := doc.Defaults.Namespace
	for i := range doc.Fields {
		f := doc.Fields[i]
		f.src = src
		inv.Fields = append(inv.Fields, f)
	}
	for i := range doc.Vlans {
		v := doc.Vlans[i]
		v.src = src
		inv.Vlans = append(inv.Vlans, v)
	}
	for i := range doc.Nodes {
		n := doc.Nodes[i]
		n.ID = resolve(n.ID, ns)
		if n.Parent == "" {
			n.Parent = doc.Defaults.Parent
		}
		n.Parent = resolve(n.Parent, ns)
		for j := range n.Pluggables {
			n.Pluggables[j].ConnectedWith = resolveRef(n.Pluggables[j].ConnectedWith, ns)
		}
		n.src = src
		inv.Nodes = append(inv.Nodes, n)
	}
	for i := range doc.Links {
		l := doc.Links[i]
		l.A = resolveRef(l.A, ns)
		l.B = resolveRef(l.B, ns)
		for j := range l.Blocks {
			l.Blocks[j] = resolveRef(l.Blocks[j], ns)
		}
		l.src = src
		inv.Links = append(inv.Links, l)
	}
}

// loadBytes runs the same pipeline as load over an in-memory document.
func loadBytes(data []byte) (*Inventory, error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var doc document
	if err := dec.Decode(&doc); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	inv := &Inventory{}
	absorb(inv, &doc, "<generated>")
	desugar(inv)
	return inv, nil
}

// desugar turns every `connected_with` on a pluggable into a real link, so
// everything downstream sees exactly one graph regardless of how a cable was
// written down.
//
// Explicit links are added first and therefore win, which is what carries their
// `poe` and `blocks` through. A pair already present is skipped, so declaring a
// cable from both ends collapses to one link instead of colliding. A pluggable
// wired to two *different* things still trips the used-twice check, as it should.
func desugar(inv *Inventory) {
	seen := make(map[string]bool, len(inv.Links))
	for i := range inv.Links {
		seen[pairKey(inv.Links[i].A, inv.Links[i].B)] = true
	}
	for i := range inv.Nodes {
		n := &inv.Nodes[i]
		for _, p := range n.Pluggables {
			if p.ConnectedWith == "" {
				continue
			}
			ref := n.ID + ":" + p.ID
			key := pairKey(ref, p.ConnectedWith)
			if seen[key] {
				continue
			}
			seen[key] = true
			inv.Links = append(inv.Links, Link{A: ref, B: p.ConnectedWith, src: n.src})
		}
	}
}

// pairKey identifies a cable regardless of which end was written first.
func pairKey(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + "\x00" + b
}

// resolve expands a bare id against a namespace. One rule everywhere: anything
// containing a slash is already absolute and is left alone.
func resolve(id, ns string) string {
	if id == "" || ns == "" || strings.Contains(id, "/") {
		return id
	}
	return ns + "/" + id
}

// resolveRef expands the node half of a `node:pluggable` ref.
func resolveRef(ref, ns string) string {
	node, plug, found := strings.Cut(ref, ":")
	if !found {
		return ref // malformed; validate reports it as a missing pluggable
	}
	return resolve(node, ns) + ":" + plug
}

// A problem is either fatal or advisory. The test for which: a warning is
// something that finishing your data entry will resolve, so a parent or a port
// you have not created yet. An error is something no amount of additional data
// can fix, so a duplicate id, a port claimed twice, a physically impossible
// link, or a containment cycle. Half-entered data should never block you.
type problem struct {
	warn bool
	msg  string
}

func validate(inv *Inventory) []problem {
	var probs []problem
	errf := func(f string, a ...any) { probs = append(probs, problem{msg: fmt.Sprintf(f, a...)}) }
	warnf := func(f string, a ...any) { probs = append(probs, problem{warn: true, msg: fmt.Sprintf(f, a...)}) }

	// Control characters cannot survive a YAML round trip reliably: go-yaml will
	// happily emit some of them and then refuse to re-read the file it wrote. No
	// inventory field legitimately holds one, so they are refused here instead.
	// Leading or trailing whitespace does not survive go-yaml's round trip, so it
	// is refused rather than silently dropped later.
	ws := func(where, v string) {
		if v != "" && strings.TrimSpace(v) != v {
			errf("%s has leading or trailing whitespace. Remove it: it would not "+
				"survive a round trip.", where)
		}
	}
	// A date-shaped string that is not a real date is refused: js-yaml resolves it
	// to an Invalid Date while go-yaml keeps it a string, and the two emitters
	// cannot be reconciled on it.
	badDate := func(where, v string) {
		var y, m, d int
		if n, _ := fmt.Sscanf(v, "%4d-%d-%d", &y, &m, &d); n != 3 || len(v) > 10 {
			return
		}
		if m >= 1 && m <= 12 && d >= 1 && d <= 31 {
			return
		}
		errf("%s looks like a date but is not a real one (%q). Fix it or write it "+
			"differently: the two YAML parsers disagree about it.", where, v)
	}
	ctl := func(where, v string) {
		for _, r := range v {
			if r < 0x20 || r == 0x7f || r == 0x85 || r == 0x2028 || r == 0x2029 {
				errf("%s contains a control character (%#x). Remove it: these cannot "+
					"round-trip through YAML safely.", where, r)
				return
			}
		}
	}
	for i := range inv.Nodes {
		n := &inv.Nodes[i]
		for f, v := range map[string]string{"id": n.ID, "label": n.Label, "type": n.Type,
			"hostname": n.Hostname, "parent": n.Parent, "note": n.Note} {
			ctl(n.ID+"."+f, v)
			ws(n.ID+"."+f, v)
		}
		for k, v := range n.Meta {
			ctl(n.ID+".meta key", k)
			ws(n.ID+".meta key", k)
			if s, ok := v.(string); ok {
				ctl(n.ID+".meta."+k, s)
				ws(n.ID+".meta."+k, s)
				badDate(n.ID+".meta."+k, s)
			}
		}
		for j := range n.Pluggables {
			p := &n.Pluggables[j]
			ref := n.ID + ":" + p.ID
			for f, v := range map[string]string{"id": p.ID, "label": p.Label, "note": p.Note, "mac": p.Mac} {
				ctl(ref+"."+f, v)
				ws(ref+"."+f, v)
			}
			for k, v := range p.Meta {
				ctl(ref+".meta key", k)
				ws(ref+".meta key", k)
				if s, ok := v.(string); ok {
					ctl(ref+".meta."+k, s)
					ws(ref+".meta."+k, s)
				}
			}
		}
	}
	for i := range inv.Links {
		l := &inv.Links[i]
		ctl(l.A+" <-> "+l.B+".label", l.Label)
		ctl(l.A+" <-> "+l.B+".note", l.Note)
	}
	for i := range inv.Vlans {
		v := &inv.Vlans[i]
		ctl(fmt.Sprintf("vlan %d.name", v.ID), v.Name)
		ctl(fmt.Sprintf("vlan %d.subnet", v.ID), v.Subnet)
		ctl(fmt.Sprintf("vlan %d.note", v.ID), v.Note)
	}

	// Declared fields, and the typed checks they enable.
	fields := map[string]*Field{}
	for i := range inv.Fields {
		f := &inv.Fields[i]
		if f.ID == "" {
			errf("%s: a field has no id", f.src)
			continue
		}
		if prev, dup := fields[f.ID]; dup {
			errf("%s: duplicate field %q, already declared in %s", f.src, f.ID, prev.src)
			continue
		}
		switch f.Type {
		case "", "string", "number", "integer", "boolean", "enum", "composite":
		default:
			errf("%s: field %q has unknown type %q", f.src, f.ID, f.Type)
		}
		if f.Type == "enum" && len(f.Enum) == 0 {
			errf("%s: field %q is an enum with no values", f.src, f.ID)
		}
		if f.Type == "composite" && len(f.Parts) == 0 {
			errf("%s: field %q is composite with no parts", f.src, f.ID)
		}
		fields[f.ID] = f
	}
	checkMeta := func(where string, meta map[string]any) {
		for k, v := range meta {
			f := fields[k]
			if f == nil {
				continue // meta is open; an undeclared key is legal
			}
			num, isNum := toFloat(v)
			switch f.Type {
			case "number", "integer":
				if !isNum {
					errf("%s.%s should be a %s%s, got %v", where, k, f.Type, unitSuffix(f), v)
					continue
				}
				if f.Type == "integer" && num != float64(int64(num)) {
					errf("%s.%s should be a whole number, got %v", where, k, v)
				}
			case "boolean":
				if _, ok := v.(bool); !ok {
					errf("%s.%s should be true or false, got %v", where, k, v)
				}
			case "enum":
				if !f.Open && len(f.Enum) > 0 && !enumHas(f.Enum, v) {
					errf("%s.%s is %v, not one of the declared values", where, k, v)
				}
			case "composite":
				m, ok := v.(map[string]any)
				if !ok {
					errf("%s.%s should be a mapping of parts", where, k)
					break
				}
				known := map[string]bool{}
				for _, q := range f.Parts {
					known[q.ID] = true
				}
				for pk := range m {
					if !known[pk] {
						errf("%s.%s has part %q which is not declared", where, k, pk)
					}
				}
			}
			if isNum && f.Min != nil && num < *f.Min {
				errf("%s.%s is %v, below the minimum %v", where, k, v, *f.Min)
			}
			if isNum && f.Max != nil && num > *f.Max {
				errf("%s.%s is %v, above the maximum %v", where, k, v, *f.Max)
			}
		}
	}

	// Unique node ids.
	nodes := map[string]*Node{}
	var order []string
	for i := range inv.Nodes {
		n := &inv.Nodes[i]
		if prev, dup := nodes[n.ID]; dup {
			errf("%s: duplicate node id %q, already defined in %s", n.src, n.ID, prev.src)
			continue
		}
		nodes[n.ID] = n
		order = append(order, n.ID)
	}

	// Unique pluggable ids within each node.
	plugs := map[string]*Pluggable{}
	for _, id := range order {
		n := nodes[id]
		seen := map[string]bool{}
		for j := range n.Pluggables {
			p := &n.Pluggables[j]
			if seen[p.ID] {
				errf("%s: %s has duplicate pluggable %q", n.src, n.ID, p.ID)
				continue
			}
			seen[p.ID] = true
			plugs[n.ID+":"+p.ID] = p
		}
	}

	// Parent refs, and containment cycles.
	for _, id := range order {
		n := nodes[id]
		if n.Parent == "" {
			continue
		}
		if _, ok := nodes[n.Parent]; !ok {
			warnf("%s: %s has parent %q which does not exist yet", n.src, n.ID, n.Parent)
		}
	}
	for _, msg := range cycleProblems(nodes, order) {
		errf("%s", msg)
	}

	// VLANs are defined once and referenced from ports.
	vlans := map[int]*Vlan{}
	for i := range inv.Vlans {
		v := &inv.Vlans[i]
		if prev, dup := vlans[v.ID]; dup {
			errf("%s: duplicate vlan %d, already defined in %s", v.src, v.ID, prev.src)
			continue
		}
		vlans[v.ID] = v
	}
	for _, id := range order {
		n := nodes[id]
		for j := range n.Pluggables {
			p := &n.Pluggables[j]
			ref := n.ID + ":" + p.ID
			seenTag := map[int]bool{}
			for _, vid := range p.Tagged {
				if seenTag[vid] {
					errf("%s: %s lists vlan %d twice", n.src, ref, vid)
				}
				seenTag[vid] = true
				if vid == p.Untagged {
					errf("%s: %s has vlan %d both untagged and tagged", n.src, ref, vid)
				}
				if _, ok := vlans[vid]; !ok {
					warnf("%s: %s references vlan %d which is not defined yet", n.src, ref, vid)
				}
			}
			if p.Untagged != 0 {
				if _, ok := vlans[p.Untagged]; !ok {
					warnf("%s: %s references vlan %d which is not defined yet", n.src, ref, p.Untagged)
				}
			}
			if p.Fanout < 0 {
				errf("%s: %s has negative fanout", n.src, ref)
			}
			for _, vid := range append([]int{p.Untagged}, p.Tagged...) {
				if vid != 0 && (vid < 1 || vid > 4094) {
					errf("%s: %s references vlan %d, outside the valid range 1-4094", n.src, ref, vid)
				}
			}
			for _, ip := range p.IPs {
				if strings.TrimSpace(ip) == "" {
					errf("%s: %s has an empty entry in ips", n.src, ref)
				}
			}
		}
	}

	for i := range inv.Nodes {
		n := &inv.Nodes[i]
		checkMeta(n.ID, n.Meta)
		for j := range n.Pluggables {
			checkMeta(n.ID+":"+n.Pluggables[j].ID, n.Pluggables[j].Meta)
		}
	}
	for i := range inv.Links {
		checkMeta(inv.Links[i].A+" <-> "+inv.Links[i].B, inv.Links[i].Meta)
	}
	for i := range inv.Vlans {
		checkMeta(fmt.Sprintf("vlan %d", inv.Vlans[i].ID), inv.Vlans[i].Meta)
	}

	// Links: refs resolve, ends are compatible, and no port carries more cables
	// than it has capacity for.
	used := map[string][]string{} // ref -> the links claiming it
	for i := range inv.Links {
		l := &inv.Links[i]
		desc := l.A + " <-> " + l.B

		pa, oka := plugs[l.A]
		pb, okb := plugs[l.B]
		if !oka {
			warnf("%s: %s: %q does not exist yet", l.src, desc, l.A)
		}
		if !okb {
			warnf("%s: %s: %q does not exist yet", l.src, desc, l.B)
		}
		if !oka || !okb {
			continue
		}
		if l.A == l.B {
			errf("%s: %s: both ends are the same pluggable", l.src, desc)
			continue
		}

		// Deliberately not counted: a planned cable records intent, and marking
		// the port occupied would make the free report lie.
		if !l.Planned {
			for _, ref := range [2]string{l.A, l.B} {
				used[ref] = append(used[ref], desc)
			}
		}

		switch {
		case pa.Type != pb.Type:
			errf("%s: %s: type mismatch, %s is %s and %s is %s", l.src, desc, l.A, pa.Type, l.B, pb.Type)
		case (pa.Dir == "") != (pb.Dir == ""):
			errf("%s: %s: one end declares dir and the other does not", l.src, desc)
		case pa.Dir != "" && pa.Dir == pb.Dir:
			errf("%s: %s: both ends are dir %q", l.src, desc, pa.Dir)
		}
	}

	// Capacity. One cable per port unless `fanout` says otherwise, which is the
	// splitter case: one outlet legitimately feeding several devices.
	capRefs := make([]string, 0, len(used))
	for ref := range used {
		capRefs = append(capRefs, ref)
	}
	sort.Strings(capRefs)
	for _, ref := range capRefs {
		claims := used[ref]
		limit := 1
		if p := plugs[ref]; p != nil && p.Fanout > 1 {
			limit = p.Fanout
		}
		if len(claims) > limit {
			if limit == 1 {
				errf("%s carries %d cables: %s (give it `fanout`, or model the splitter as a node)",
					ref, len(claims), strings.Join(claims, "; "))
			} else {
				errf("%s has fanout %d but carries %d cables: %s",
					ref, limit, len(claims), strings.Join(claims, "; "))
			}
		}
	}

	// VLAN membership should agree across a cable. A tag present on one end and
	// missing on the other is the classic trunk misconfiguration.
	for i := range inv.Links {
		l := &inv.Links[i]
		pa, pb := plugs[l.A], plugs[l.B]
		if pa == nil || pb == nil {
			continue
		}
		if pa.Untagged == 0 && pb.Untagged == 0 && len(pa.Tagged) == 0 && len(pb.Tagged) == 0 {
			continue
		}
		if pa.Untagged != pb.Untagged {
			warnf("%s: %s <-> %s: untagged vlan differs, %d vs %d", l.src, l.A, l.B, pa.Untagged, pb.Untagged)
		}
		if diff := missing(pa.Tagged, pb.Tagged); len(diff) > 0 {
			warnf("%s: %s <-> %s: vlan %v tagged on %s but not %s", l.src, l.A, l.B, diff, l.A, l.B)
		}
		if diff := missing(pb.Tagged, pa.Tagged); len(diff) > 0 {
			warnf("%s: %s <-> %s: vlan %v tagged on %s but not %s", l.src, l.A, l.B, diff, l.B, l.A)
		}
	}

	// Blocked pluggables.
	for i := range inv.Links {
		l := &inv.Links[i]
		for _, b := range l.Blocks {
			if _, ok := plugs[b]; !ok {
				warnf("%s: %s <-> %s: blocks %q which does not exist yet", l.src, l.A, l.B, b)
				continue
			}
			if claims, ok := used[b]; ok {
				errf("%s: %s is blocked by %s <-> %s but is used by %s",
					l.src, b, l.A, l.B, strings.Join(claims, "; "))
			}
		}
	}

	return probs
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case float64:
		return n, true
	}
	return 0, false
}

func enumHas(list []any, v any) bool {
	want := fmt.Sprint(v)
	for _, x := range list {
		if fmt.Sprint(x) == want {
			return true
		}
	}
	return false
}

func unitSuffix(f *Field) string {
	if f.Unit == "" {
		return ""
	}
	return " in " + f.Unit
}

// missing returns the ids in a that are absent from b.
func missing(a, b []int) []int {
	have := make(map[int]bool, len(b))
	for _, x := range b {
		have[x] = true
	}
	var out []int
	for _, x := range a {
		if !have[x] {
			out = append(out, x)
		}
	}
	sort.Ints(out)
	return out
}

// cycleProblems walks parent chains. Each cycle is reported once, by whichever
// of its members sorts first, so a 3-node loop yields one line and not three.
func cycleProblems(nodes map[string]*Node, order []string) []string {
	var probs []string
	for _, start := range order {
		seen := map[string]int{start: 0}
		path := []string{start}
		cur := nodes[start]
		for cur.Parent != "" {
			next, ok := nodes[cur.Parent]
			if !ok {
				break // dangling parent, reported elsewhere
			}
			if idx, dup := seen[next.ID]; dup {
				cycle := path[idx:]
				first := cycle[0]
				for _, m := range cycle {
					if m < first {
						first = m
					}
				}
				if first == start {
					probs = append(probs, "parent cycle: "+strings.Join(append(cycle, next.ID), " -> "))
				}
				break
			}
			seen[next.ID] = len(path)
			path = append(path, next.ID)
			cur = next
		}
	}
	return probs
}

func free(inv *Inventory) string {
	used := map[string]bool{}
	blocked := map[string]string{} // ref -> the link that blocks it
	for i := range inv.Links {
		l := &inv.Links[i]
		if l.Planned {
			continue // intent, so both ports stay free and keep being offered
		}
		used[l.A] = true
		used[l.B] = true
		for _, b := range l.Blocks {
			blocked[b] = l.A + " <-> " + l.B
		}
	}

	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)

	nFree, nUsed, nBlocked := 0, 0, 0
	fmt.Fprintln(tw, "FREE\t\t")
	for i := range inv.Nodes {
		n := &inv.Nodes[i]
		if n.Virtual {
			continue // its ports are not sockets anything can be plugged into
		}
		// Group by kind, preserving declaration order within each kind.
		var kinds []string
		byKind := map[string][]string{}
		for _, p := range n.Pluggables {
			ref := n.ID + ":" + p.ID
			switch {
			case used[ref]:
				nUsed++
				continue
			case blocked[ref] != "":
				nBlocked++
				continue
			}
			nFree++
			k := kind(p)
			if _, ok := byKind[k]; !ok {
				kinds = append(kinds, k)
			}
			byKind[k] = append(byKind[k], display(p))
		}
		for _, k := range kinds {
			fmt.Fprintf(tw, "  %s\t%s\t%s\n", n.ID, k, strings.Join(byKind[k], ", "))
		}
	}

	if len(blocked) > 0 {
		fmt.Fprintln(tw, "\t\t")
		fmt.Fprintln(tw, "BLOCKED, not free\t\t")
		for i := range inv.Nodes {
			n := &inv.Nodes[i]
			for _, p := range n.Pluggables {
				ref := n.ID + ":" + p.ID
				if by := blocked[ref]; by != "" {
					fmt.Fprintf(tw, "  %s\t\tby %s\n", ref, by)
				}
			}
		}
	}

	fmt.Fprintln(tw, "\t\t")
	fmt.Fprintf(tw, "%d nodes, %d links, %d free, %d used, %d blocked\t\t\n",
		len(inv.Nodes), len(inv.Links), nFree, nUsed, nBlocked)
	tw.Flush()
	return sb.String()
}

// kind is the compatibility bucket a pluggable belongs to, e.g. "power/out".
func kind(p Pluggable) string {
	if p.Dir == "" {
		return p.Type
	}
	return p.Type + "/" + p.Dir
}

// ------------------------------------------------------------ canonical form
//
// One document, absolute ids, no `defaults`, nodes sorted by id, keys in a
// fixed order. A cable with nothing but two ends is written on the port as
// `connected_with`; one carrying anything of its own (poe, blocks, a label, a
// note, meta) stays an explicit links entry, because that information belongs
// to the connection rather than to either end.
//
// Deterministic, so the UI and a hand-edit converge on the same bytes and a
// diff only ever shows what actually changed.

type outPluggable struct {
	ID            string         `yaml:"id"`
	Type          string         `yaml:"type"`
	Dir           string         `yaml:"dir,omitempty"`
	ConnectedWith string         `yaml:"connected_with,omitempty"`
	Fanout        int            `yaml:"fanout,omitempty"`
	Mac           string         `yaml:"mac,omitempty"`
	IPs           []string       `yaml:"ips,omitempty"`
	Untagged      int            `yaml:"untagged,omitempty"`
	Tagged        []int          `yaml:"tagged,omitempty"`
	Reserved      string         `yaml:"reserved,omitempty"`
	Label         string         `yaml:"label,omitempty"`
	Note          string         `yaml:"note,omitempty"`
	Meta          map[string]any `yaml:"meta,omitempty"`
}

type outField struct {
	ID          string         `yaml:"id"`
	Label       string         `yaml:"label,omitempty"`
	Type        string         `yaml:"type,omitempty"`
	Control     string         `yaml:"control,omitempty"`
	Unit        string         `yaml:"unit,omitempty"`
	Enum        []any          `yaml:"enum,omitempty"`
	Open        bool           `yaml:"open,omitempty"`
	Min         *float64       `yaml:"min,omitempty"`
	Max         *float64       `yaml:"max,omitempty"`
	AppliesTo   []string       `yaml:"applies_to,omitempty"`
	Parts       []outPart      `yaml:"parts,omitempty"`
	Description string         `yaml:"description,omitempty"`
	Meta        map[string]any `yaml:"meta,omitempty"`
}

type outPart struct {
	ID    string `yaml:"id"`
	Label string `yaml:"label,omitempty"`
	Type  string `yaml:"type,omitempty"`
	Unit  string `yaml:"unit,omitempty"`
}

type outVlan struct {
	ID     int            `yaml:"id"`
	Name   string         `yaml:"name,omitempty"`
	Subnet string         `yaml:"subnet,omitempty"`
	Note   string         `yaml:"note,omitempty"`
	Meta   map[string]any `yaml:"meta,omitempty"`
}

type outNode struct {
	ID         string         `yaml:"id"`
	Label      string         `yaml:"label,omitempty"`
	Type       string         `yaml:"type,omitempty"`
	Virtual    bool           `yaml:"virtual,omitempty"`
	Hostname   string         `yaml:"hostname,omitempty"`
	Parent     string         `yaml:"parent,omitempty"`
	Note       string         `yaml:"note,omitempty"`
	Meta       map[string]any `yaml:"meta,omitempty"`
	Pluggables []outPluggable `yaml:"pluggables,omitempty"`
}

type outLink struct {
	A       string         `yaml:"a"`
	B       string         `yaml:"b"`
	Label   string         `yaml:"label,omitempty"`
	Note    string         `yaml:"note,omitempty"`
	Planned bool           `yaml:"planned,omitempty"`
	PoE     bool           `yaml:"poe,omitempty"`
	Blocks  []string       `yaml:"blocks,omitempty"`
	Meta    map[string]any `yaml:"meta,omitempty"`
}

type outDoc struct {
	Fields []outField `yaml:"fields,omitempty"`
	Vlans  []outVlan  `yaml:"vlans,omitempty"`
	Nodes  []outNode  `yaml:"nodes"`
	Links  []outLink  `yaml:"links,omitempty"`
}

func canonical(inv *Inventory) *outDoc {
	// Which refs are real ports? A `connected_with` can only live on one that
	// exists, or the cable would be written nowhere and silently vanish.
	realPort := make(map[string]bool)
	for i := range inv.Nodes {
		n := &inv.Nodes[i]
		for _, p := range n.Pluggables {
			realPort[n.ID+":"+p.ID] = true
		}
	}

	// A port can host exactly one `connected_with`. A second cable on the same
	// port (fanout) has to be written as an explicit link instead, otherwise the
	// canonical form could not represent the graph at all.
	owner := make(map[string]string)
	claimed := make(map[string]bool)
	var rich []outLink
	for i := range inv.Links {
		l := &inv.Links[i]
		a, b := l.A, l.B
		if a > b {
			a, b = b, a
		}
		if l.Label == "" && l.Note == "" && !l.Planned && !l.PoE && len(l.Blocks) == 0 && len(l.Meta) == 0 {
			switch {
			case realPort[a] && !claimed[a]:
				owner[a], claimed[a] = b, true
			case realPort[b] && !claimed[b]:
				owner[b], claimed[b] = a, true
			default:
				rich = append(rich, outLink{A: a, B: b})
			}
			continue
		}
		blocks := append([]string(nil), l.Blocks...)
		sort.Strings(blocks)
		rich = append(rich, outLink{
			A: a, B: b, Label: l.Label, Note: l.Note,
			Planned: l.Planned, PoE: l.PoE, Blocks: blocks, Meta: l.Meta,
		})
	}
	sort.SliceStable(rich, func(i, j int) bool {
		if rich[i].A != rich[j].A {
			return rich[i].A < rich[j].A
		}
		return rich[i].B < rich[j].B
	})

	nodes := make([]outNode, 0, len(inv.Nodes))
	for i := range inv.Nodes {
		n := &inv.Nodes[i]
		on := outNode{
			ID: n.ID, Label: n.Label, Type: n.Type, Virtual: n.Virtual, Hostname: n.Hostname,
			Parent: n.Parent, Note: n.Note, Meta: n.Meta,
		}
		for _, p := range n.Pluggables {
			tagged := append([]int(nil), p.Tagged...)
			sort.Ints(tagged)
			on.Pluggables = append(on.Pluggables, outPluggable{
				ID:            p.ID,
				Type:          p.Type,
				Dir:           p.Dir,
				ConnectedWith: owner[n.ID+":"+p.ID],
				Fanout:        p.Fanout,
				Mac:           p.Mac,
				IPs:           p.IPs,
				Untagged:      p.Untagged,
				Tagged:        tagged,
				Reserved:      p.Reserved,
				Label:         p.Label,
				Note:          p.Note,
				Meta:          p.Meta,
			})
		}
		nodes = append(nodes, on)
	}
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })

	vl := make([]outVlan, 0, len(inv.Vlans))
	for _, v := range inv.Vlans {
		vl = append(vl, outVlan{ID: v.ID, Name: v.Name, Subnet: v.Subnet, Note: v.Note, Meta: v.Meta})
	}
	sort.SliceStable(vl, func(i, j int) bool { return vl[i].ID < vl[j].ID })

	fl := make([]outField, 0, len(inv.Fields))
	for _, f := range inv.Fields {
		of := outField{
			ID: f.ID, Label: f.Label, Type: f.Type, Control: f.Control, Unit: f.Unit,
			Enum: f.Enum, Open: f.Open, Min: f.Min, Max: f.Max,
			AppliesTo: f.AppliesTo, Description: f.Description, Meta: f.Meta,
		}
		for _, q := range f.Parts {
			of.Parts = append(of.Parts, outPart{ID: q.ID, Label: q.Label, Type: q.Type, Unit: q.Unit})
		}
		fl = append(fl, of)
	}
	sort.SliceStable(fl, func(i, j int) bool { return fl[i].ID < fl[j].ID })

	return &outDoc{Fields: fl, Vlans: vl, Nodes: nodes, Links: rich}
}

// format renders the canonical bytes, reads them back, and refuses to return
// anything that describes a different graph. Cheap insurance: a serializer bug
// should cost a non-zero exit, never the inventory.
func format(inv *Inventory) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(canonical(inv)); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	data := buf.Bytes()

	round, err := loadBytes(data)
	if err != nil {
		return nil, fmt.Errorf("refusing to write, output does not parse: %w", err)
	}
	// structure() reads the model directly, NOT through canonical(). The
	// fingerprint runs both sides through canonical(), so anything canonical()
	// itself drops is dropped on both sides and compares equal. Two checks,
	// disjoint bug classes, both needed.
	if in, out := structure(inv), structure(round); in != out {
		return nil, fmt.Errorf("refusing to write, a port or cable would be lost\n  in:  %s\n  out: %s", in, out)
	}
	if in, out := fingerprint(inv), fingerprint(round); in != out {
		return nil, fmt.Errorf("refusing to write, output is a different graph\n  in:  %s\n  out: %s", in, out)
	}
	return data, nil
}

// fingerprint is a stable digest of the ENTIRE canonical document, not just a
// count of ports and cables. That matters: a narrower fingerprint would not
// notice a dropped mac, ip, vlan or meta value, and silently dropping a field
// is exactly the failure this guard exists to prevent.
func fingerprint(inv *Inventory) string {
	b, err := json.Marshal(canonical(inv))
	if err != nil {
		return "unserialisable:" + err.Error()
	}
	return fmt.Sprintf("%dn/%df/%db/%s", len(inv.Nodes), len(inv.Fields), len(b), digest(string(b)))
}

// structure is a summary of ports and cables taken straight off the model.
func structure(inv *Inventory) string {
	var ports, cables []string
	for i := range inv.Nodes {
		n := &inv.Nodes[i]
		for _, p := range n.Pluggables {
			ports = append(ports, n.ID+":"+p.ID)
		}
	}
	for i := range inv.Links {
		a, b := inv.Links[i].A, inv.Links[i].B
		if a > b {
			a, b = b, a
		}
		cables = append(cables, a+"~"+b)
	}
	sort.Strings(ports)
	sort.Strings(cables)
	return fmt.Sprintf("%dp/%dc|%s|%s", len(ports), len(cables),
		digest(strings.Join(ports, ",")), digest(strings.Join(cables, ",")))
}

func digest(s string) string {
	h := fnv.New64a()
	h.Write([]byte(s))
	return fmt.Sprintf("%016x", h.Sum64())
}

// writeAtomic writes via a temp file in the same directory then renames, so an
// interrupted run leaves the original untouched rather than truncated.
func writeAtomic(path string, data []byte) error {
	// Keep whatever mode the file already had. CreateTemp makes 0600, and the
	// rename would otherwise silently tighten permissions on every fmt -w.
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".inv-*.tmp")
	if err != nil {
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// display shows the port id, plus a label or note where either adds something
// the id does not already say.
func display(p Pluggable) string {
	var extra []string
	if p.Label != "" && p.Label != p.ID {
		extra = append(extra, `"`+p.Label+`"`)
	}
	if p.Reserved != "" {
		extra = append(extra, "RESERVED: "+p.Reserved)
	}
	if p.Note != "" {
		extra = append(extra, p.Note)
	}
	if len(extra) == 0 {
		return p.ID
	}
	return p.ID + " (" + strings.Join(extra, ", ") + ")"
}
