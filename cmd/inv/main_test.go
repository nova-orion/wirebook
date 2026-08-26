package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------- helpers ---

func load1(t *testing.T, src string) *Inventory {
	t.Helper()
	in, err := loadBytes([]byte(src))
	if err != nil {
		t.Fatalf("loadBytes: %v", err)
	}
	return in
}

func split(in *Inventory) (errs, warns []string) {
	for _, p := range validate(in) {
		if p.warn {
			warns = append(warns, p.msg)
		} else {
			errs = append(errs, p.msg)
		}
	}
	return
}

func has(list []string, want string) bool {
	for _, s := range list {
		if strings.Contains(s, want) {
			return true
		}
	}
	return false
}

func mustFormat(t *testing.T, in *Inventory) string {
	t.Helper()
	b, err := format(in)
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	return string(b)
}

// ------------------------------------------------------- namespace resolution

func TestResolve(t *testing.T) {
	for _, c := range []struct{ id, ns, want string }{
		{"a", "ns", "ns/a"},
		{"ns/a", "ns", "ns/a"}, // already absolute
		{"other/a", "ns", "other/a"},
		{"a", "", "a"},           // no namespace
		{"", "ns", ""},           // empty stays empty
		{"a/b/c", "ns", "a/b/c"}, // any slash means absolute
	} {
		if got := resolve(c.id, c.ns); got != c.want {
			t.Errorf("resolve(%q,%q) = %q, want %q", c.id, c.ns, got, c.want)
		}
	}
}

func TestResolveRef(t *testing.T) {
	for _, c := range []struct{ ref, ns, want string }{
		{"a:p", "ns", "ns/a:p"},
		{"x/a:p", "ns", "x/a:p"},
		{"a", "ns", "a"},            // no colon: left alone, validate reports it
		{"a:p:q", "ns", "ns/a:p:q"}, // split on the FIRST colon only
		{":p", "ns", ":p"},
		{"", "ns", ""},
	} {
		if got := resolveRef(c.ref, c.ns); got != c.want {
			t.Errorf("resolveRef(%q,%q) = %q, want %q", c.ref, c.ns, got, c.want)
		}
	}
}

func TestPairKeyIsOrderIndependent(t *testing.T) {
	if pairKey("a", "b") != pairKey("b", "a") {
		t.Fatal("pairKey must not depend on argument order")
	}
	// The separator must be a character that cannot occur in a ref, or two
	// different cables could collide onto one key.
	if !strings.Contains(pairKey("a", "b"), "\x00") {
		t.Fatal("pairKey separator should be NUL")
	}
}

// ------------------------------------------------------------------ desugar --

func TestDesugarReciprocalCollapses(t *testing.T) {
	in := load1(t, `
nodes:
  - id: a
    pluggables: [{id: p, type: eth, connected_with: "b:p"}]
  - id: b
    pluggables: [{id: p, type: eth, connected_with: "a:p"}]
`)
	if len(in.Links) != 1 {
		t.Fatalf("declaring one cable from both ends must collapse to 1, got %d", len(in.Links))
	}
}

func TestDesugarExplicitLinkWins(t *testing.T) {
	// The explicit entry carries poe/blocks; the sugar must not shadow it.
	in := load1(t, `
nodes:
  - id: a
    pluggables: [{id: p, type: eth, connected_with: "b:p"}]
  - id: b
    pluggables: [{id: p, type: eth}]
links:
  - {a: "a:p", b: "b:p", poe: true, label: tagged}
`)
	if len(in.Links) != 1 {
		t.Fatalf("want 1 cable, got %d", len(in.Links))
	}
	if !in.Links[0].PoE || in.Links[0].Label != "tagged" {
		t.Fatalf("explicit link lost its metadata: %+v", in.Links[0])
	}
}

func TestDesugarTwoDifferentTargetsMakesTwoCables(t *testing.T) {
	in := load1(t, `
nodes:
  - id: a
    pluggables: [{id: p, type: power, dir: out}]
  - id: b
    pluggables: [{id: p, type: power, dir: in, connected_with: "a:p"}]
  - id: c
    pluggables: [{id: p, type: power, dir: in, connected_with: "a:p"}]
`)
	if len(in.Links) != 2 {
		t.Fatalf("want 2 cables, got %d", len(in.Links))
	}
	errs, _ := split(in)
	if !has(errs, "carries 2 cables") {
		t.Fatalf("a port over capacity must error, got %v", errs)
	}
}

// -------------------------------------------------------------------- cycles

func TestCycleProblems(t *testing.T) {
	for _, c := range []struct {
		name, src string
		want      int
	}{
		{"self parent", "nodes:\n  - {id: a, parent: a}\n", 1},
		{"two cycle", "nodes:\n  - {id: a, parent: b}\n  - {id: b, parent: a}\n", 1},
		{"three cycle", "nodes:\n  - {id: a, parent: b}\n  - {id: b, parent: c}\n  - {id: c, parent: a}\n", 1},
		// a tail feeding into a cycle must not produce a second report
		{"rho shape", "nodes:\n  - {id: t, parent: a}\n  - {id: a, parent: b}\n  - {id: b, parent: c}\n  - {id: c, parent: a}\n", 1},
		{"two disjoint cycles", "nodes:\n  - {id: a, parent: b}\n  - {id: b, parent: a}\n  - {id: x, parent: y}\n  - {id: y, parent: x}\n", 2},
		{"deep chain is fine", "", 0},
	} {
		src := c.src
		if c.name == "deep chain is fine" {
			var sb strings.Builder
			sb.WriteString("nodes:\n")
			for i := 0; i < 400; i++ {
				sb.WriteString("  - {id: n" + itoa(i))
				if i > 0 {
					sb.WriteString(", parent: n" + itoa(i-1))
				}
				sb.WriteString("}\n")
			}
			src = sb.String()
		}
		in := load1(t, src)
		errs, _ := split(in)
		n := 0
		for _, e := range errs {
			if strings.HasPrefix(e, "parent cycle") {
				n++
			}
		}
		if n != c.want {
			t.Errorf("%s: got %d cycle reports, want %d (%v)", c.name, n, c.want, errs)
		}
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

// ------------------------------------------------------------------ validate

// The severity split is the documented contract: a warning is something more
// data would fix, an error is a contradiction. This pins every rule to a side.
func TestValidateSeverity(t *testing.T) {
	cases := []struct {
		name, src, want string
		fatal           bool
	}{
		{"duplicate node", "nodes:\n  - {id: a}\n  - {id: a}\n", "duplicate node id", true},
		{"duplicate port", "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth}, {id: p, type: eth}]\n", "duplicate pluggable", true},
		{"self link", "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth}]\nlinks:\n  - {a: \"a:p\", b: \"a:p\"}\n", "same pluggable", true},
		{"type mismatch", "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth}, {id: q, type: usb, dir: in}]\nlinks:\n  - {a: \"a:p\", b: \"a:q\"}\n", "type mismatch", true},
		{"dir on one side", "nodes:\n  - id: a\n    pluggables: [{id: p, type: power}, {id: q, type: power, dir: in}]\nlinks:\n  - {a: \"a:p\", b: \"a:q\"}\n", "one end declares dir", true},
		{"same dir", "nodes:\n  - id: a\n    pluggables: [{id: p, type: power, dir: in}, {id: q, type: power, dir: in}]\nlinks:\n  - {a: \"a:p\", b: \"a:q\"}\n", "both ends are dir", true},
		{"negative fanout", "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth, fanout: -1}]\n", "negative fanout", true},
		{"vlan twice", "vlans: [{id: 5}]\nnodes:\n  - id: a\n    pluggables: [{id: p, type: eth, tagged: [5, 5]}]\n", "lists vlan 5 twice", true},
		{"vlan both ways", "vlans: [{id: 5}]\nnodes:\n  - id: a\n    pluggables: [{id: p, type: eth, untagged: 5, tagged: [5]}]\n", "both untagged and tagged", true},
		{"duplicate vlan", "vlans: [{id: 5}, {id: 5}]\nnodes: []\n", "duplicate vlan 5", true},
		{"vlan out of range", "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth, untagged: 9999}]\n", "outside the valid range", true},
		{"empty ip", "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth, ips: [\"\"]}]\n", "empty entry in ips", true},
		{"blocked but used", "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth}, {id: q, type: eth}, {id: r, type: eth}, {id: s, type: eth}]\nlinks:\n  - {a: \"a:p\", b: \"a:q\"}\n  - {a: \"a:r\", b: \"a:s\", blocks: [\"a:p\"]}\n", "but is used by", true},
		{"control char", "nodes:\n  - {id: a, label: \"x\\u0007y\"}\n", "control character", true},
		{"edge whitespace", "nodes:\n  - {id: a, label: \" x\"}\n", "whitespace", true},

		// warnings: finishing data entry resolves these
		{"missing parent", "nodes:\n  - {id: a, parent: nope}\n", "does not exist yet", false},
		{"missing port", "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth}]\nlinks:\n  - {a: \"a:p\", b: \"ghost:x\"}\n", "does not exist yet", false},
		{"undefined vlan", "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth, untagged: 7}]\n", "not defined yet", false},
		{"blocks a ghost", "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth}, {id: q, type: eth}]\nlinks:\n  - {a: \"a:p\", b: \"a:q\", blocks: [\"a:ghost\"]}\n", "does not exist yet", false},
		{"trunk mismatch", "vlans: [{id: 5}]\nnodes:\n  - id: a\n    pluggables: [{id: p, type: eth, tagged: [5], connected_with: \"b:p\"}]\n  - id: b\n    pluggables: [{id: p, type: eth}]\n", "tagged on", false},
	}
	for _, c := range cases {
		in := load1(t, c.src)
		errs, warns := split(in)
		if c.fatal {
			if !has(errs, c.want) {
				t.Errorf("%s: want ERROR containing %q; errs=%v warns=%v", c.name, c.want, errs, warns)
			}
		} else {
			if !has(warns, c.want) {
				t.Errorf("%s: want WARNING containing %q; errs=%v warns=%v", c.name, c.want, errs, warns)
			}
			if len(errs) != 0 {
				t.Errorf("%s: incomplete data must not be fatal, got errs=%v", c.name, errs)
			}
		}
	}
}

func TestFanoutPermitsExtraCables(t *testing.T) {
	in := load1(t, `
nodes:
  - id: a
    pluggables: [{id: p, type: power, dir: out, fanout: 3}]
  - id: b
    pluggables: [{id: p, type: power, dir: in, connected_with: "a:p"}]
  - id: c
    pluggables: [{id: p, type: power, dir: in, connected_with: "a:p"}]
`)
	errs, _ := split(in)
	if len(errs) != 0 {
		t.Fatalf("fanout 3 must permit 2 cables, got %v", errs)
	}
}

func TestFreeReportsRemainingFanoutSlots(t *testing.T) {
	// `free` marked a port used as soon as it carried one cable, so a socket with
	// fanout 2 and one plug in it vanished from the report and there was no way
	// to find the spare slot short of reading the file by hand.
	in := load1(t, `
nodes:
  - id: a
    pluggables: [{id: p, type: power, dir: out, fanout: 2}]
  - id: b
    pluggables: [{id: p, type: power, dir: in, connected_with: "a:p"}]
  - id: zfull
    pluggables: [{id: p, type: power, dir: out}]
  - id: c
    pluggables: [{id: p, type: power, dir: in, connected_with: "zfull:p"}]
`)
	out := free(in)
	if !strings.Contains(out, "1 of 2 free") {
		t.Fatalf("a socket with a spare slot must be listed, and say how much is left:\n%s", out)
	}
	// a plain port carrying a cable is genuinely full and must not be listed
	if strings.Contains(out, "zfull") {
		t.Fatalf("a port at capacity must not be reported as free:\n%s", out)
	}
}

// ------------------------------------------------------------------- format --

func TestFormatIsIdempotentFromMessyInput(t *testing.T) {
	// Deliberately NOT canonical: unsorted, relative ids, defaults, reciprocal
	// sugar, unsorted tagged. Formatting the messy form and then formatting the
	// result again must reach the same bytes.
	messy := `
defaults:
  namespace: zz
vlans:
  - {id: 30}
  - {id: 10}
nodes:
  - id: srv
    pluggables:
      - {id: e1, type: eth, tagged: [30, 10], untagged: 10, connected_with: "zz/sw:p1"}
  - id: sw
    pluggables:
      - {id: p1, type: eth, tagged: [10, 30], untagged: 10}
  - {id: aaa/loc, type: location}
`
	once := mustFormat(t, load1(t, messy))
	twice := mustFormat(t, load1(t, once))
	if once != twice {
		t.Fatalf("fmt is not idempotent\n--- once ---\n%s\n--- twice ---\n%s", once, twice)
	}
	// namespaces resolved, defaults gone, nodes sorted
	if strings.Contains(once, "defaults:") {
		t.Error("canonical output must not carry defaults")
	}
	if !strings.Contains(once, "id: zz/srv") {
		t.Error("ids should be absolute in canonical output")
	}
	if strings.Index(once, "id: aaa/loc") > strings.Index(once, "id: zz/srv") {
		t.Error("nodes should be sorted by id")
	}
	if i, j := strings.Index(once, "- 10"), strings.Index(once, "- 30"); i < 0 || j < 0 || i > j {
		t.Errorf("tagged should be sorted ascending:\n%s", once)
	}
}

func TestFormatRefusesToLoseACable(t *testing.T) {
	// A port carrying two plain cables cannot be expressed purely as sugar, so
	// canonical() has to spill one into `links`. If that ever regresses, format
	// must refuse rather than write a file missing a cable.
	in := load1(t, `
nodes:
  - id: a
    pluggables: [{id: o, type: power, dir: out, fanout: 3}]
  - id: b
    pluggables: [{id: p, type: power, dir: in, connected_with: "a:o"}]
  - id: c
    pluggables: [{id: p, type: power, dir: in, connected_with: "a:o"}]
`)
	out := mustFormat(t, in)
	back := load1(t, out)
	if len(back.Links) != len(in.Links) {
		t.Fatalf("cable count changed: %d -> %d\n%s", len(in.Links), len(back.Links), out)
	}
}

func TestFormatKeepsACableToANonexistentPort(t *testing.T) {
	// Half-entered data: the smaller ref sorts first but is not a real port, so
	// the sugar cannot live there. It must not vanish.
	in := load1(t, "nodes:\n  - id: zz\n    pluggables: [{id: p, type: eth, connected_with: \"aa:p\"}]\n")
	out := mustFormat(t, in)
	if !strings.Contains(out, "aa:p") {
		t.Fatalf("dangling cable was dropped:\n%s", out)
	}
}

// structure() and fingerprint() catch different things, and both are needed.
// This documents the blind spot so nobody trusts one alone.
func TestStructureIgnoresFieldsThatFingerprintCatches(t *testing.T) {
	a := load1(t, "nodes:\n  - id: n\n    label: one\n    pluggables: [{id: p, type: eth, mac: \"aa:aa\"}]\n")
	b := load1(t, "nodes:\n  - id: n\n    label: two\n    pluggables: [{id: p, type: eth, mac: \"bb:bb\"}]\n")
	if structure(a) != structure(b) {
		t.Error("structure() is only ports and cables; it should not notice label/mac")
	}
	if fingerprint(a) == fingerprint(b) {
		t.Error("fingerprint() must notice a changed label or mac")
	}

	// and the converse: a lost cable moves structure()
	c := load1(t, "nodes:\n  - id: n\n    pluggables: [{id: p, type: eth}, {id: q, type: eth}]\nlinks:\n  - {a: \"n:p\", b: \"n:q\"}\n")
	d := load1(t, "nodes:\n  - id: n\n    pluggables: [{id: p, type: eth}, {id: q, type: eth}]\n")
	if structure(c) == structure(d) {
		t.Error("structure() must notice a missing cable")
	}
}

// ---------------------------------------------------------------------- load

func TestLoadRejectsUnknownFields(t *testing.T) {
	// Go and the browser both hard-error here. Silently ignoring an unknown key
	// means a load-then-save cycle deletes the user's data.
	for _, src := range []string{
		"nodes:\n  - {id: a, notes: oops}\n",
		"nodes:\n  - id: a\n    pluggables: [{id: p, type: eth, speedd: 1}]\n",
		"links:\n  - {a: \"x:p\", b: \"y:p\", poee: true}\n",
		"vlans:\n  - {id: 1, nam: x}\n",
		"defaults:\n  namespac: x\nnodes: []\n",
		"nodez: []\n",
	} {
		if _, err := loadBytes([]byte(src)); err == nil {
			t.Errorf("expected an error for %q", strings.TrimSpace(src))
		}
	}
}

func TestLoadDirectory(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.yaml", "defaults:\n  namespace: one\n  parent: loc/x\nnodes:\n  - {id: n1}\n")
	write("b.yaml", "defaults:\n  namespace: two\nnodes:\n  - {id: n2}\n")
	write("empty.yaml", "")       // the io.EOF branch
	write("notes.txt", "ignored") // not *.yaml
	if err := os.Mkdir(filepath.Join(dir, "schema"), 0o755); err != nil {
		t.Fatal(err)
	}
	write("schema/inner.yaml", "nodes:\n  - {id: should_be_ignored}\n")

	in, err := load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(in.Nodes) != 2 {
		t.Fatalf("want 2 nodes from 2 files, got %d", len(in.Nodes))
	}
	got := map[string]string{}
	for _, n := range in.Nodes {
		got[n.ID] = n.Parent
	}
	if got["one/n1"] != "loc/x" {
		t.Errorf("per-file namespace/parent not applied: %v", got)
	}
	if _, ok := got["two/n2"]; !ok {
		t.Errorf("second file not merged: %v", got)
	}

	// a directory with no yaml at all is an error, not an empty inventory
	if _, err := load(t.TempDir()); err == nil {
		t.Error("expected an error for a directory with no *.yaml")
	}
}

func TestLoadRefusesMultiDocument(t *testing.T) {
	// This used to decode only the first document, and `fmt -w` then wrote the
	// truncation back over the file reporting success.
	dir := t.TempDir()
	p := filepath.Join(dir, "m.yaml")
	if err := os.WriteFile(p, []byte("nodes:\n  - {id: a}\n---\nnodes:\n  - {id: b}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := load(p)
	if err == nil {
		t.Fatal("multi-document input must be refused, not silently truncated")
	}
	if !strings.Contains(err.Error(), "multi-document") {
		t.Errorf("unhelpful error: %v", err)
	}
}

// ---------------------------------------------------------------- writeAtomic

func TestWriteAtomicPreservesModeAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f.yaml")
	if err := os.WriteFile(p, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(p, []byte("new\n")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(p)
	if err != nil || string(got) != "new\n" {
		t.Fatalf("content = %q, err = %v", got, err)
	}
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	// CreateTemp makes 0600; without an explicit chmod every fmt -w silently
	// tightened permissions on the user's file.
	if fi.Mode().Perm() != 0o644 {
		t.Errorf("mode = %v, want 0644", fi.Mode().Perm())
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".inv-") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
}

// ----------------------------------------------------------------- free/misc

func TestFreeReportsCapacityAndBlocked(t *testing.T) {
	in := load1(t, `
nodes:
  - id: p
    pluggables:
      - {id: o1, type: power, dir: out, fanout: 2}
      - {id: o2, type: power, dir: out}
      - {id: o3, type: power, dir: out}
  - id: d
    pluggables: [{id: psu, type: power, dir: in}]
links:
  - {a: "p:o1", b: "d:psu", blocks: ["p:o3"]}
`)
	out := free(in)
	if !strings.Contains(out, "BLOCKED") || !strings.Contains(out, "p:o3") {
		t.Errorf("blocked section missing:\n%s", out)
	}
	if !strings.Contains(out, "o2") {
		t.Errorf("a genuinely free port should be listed:\n%s", out)
	}
	if strings.Contains(out, "d:psu") && strings.Contains(out, "FREE\n  d") {
		t.Errorf("a used port must not be listed as free:\n%s", out)
	}
}

func TestMissing(t *testing.T) {
	for _, c := range []struct {
		a, b, want []int
	}{
		{nil, nil, nil},
		{[]int{3, 1}, nil, []int{1, 3}},
		{[]int{1, 2}, []int{1, 2}, nil},
		{[]int{5, 1, 5}, []int{1}, []int{5, 5}},
	} {
		got := missing(c.a, c.b)
		if len(got) != len(c.want) {
			t.Errorf("missing(%v,%v) = %v, want %v", c.a, c.b, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("missing(%v,%v) = %v, want %v", c.a, c.b, got, c.want)
				break
			}
		}
	}
}

func TestCountPorts(t *testing.T) {
	in := load1(t, "nodes:\n  - id: a\n    pluggables: [{id: p, type: eth}, {id: q, type: eth}]\n  - {id: b}\n")
	if got := countPorts(in); got != 2 {
		t.Errorf("countPorts = %d, want 2", got)
	}
}

// The awkward scalars the browser emitter is diffed against. Pinning them here
// too means a go-yaml bump that changes quoting fails on the Go side as well,
// rather than only showing up as a parity mismatch.
func TestScalarQuotingGolden(t *testing.T) {
	in := load1(t, `
nodes:
  - id: z
    meta:
      a_one: "1"
      b_oh_seven: "007"
      c_yes: "yes"
      d_colon: 'has: a colon'
      e_quote: say "hi"
      f_num: 3.5
      g_bool: true
      h_brace: '{not a map}'
      i_date: "2024-03-01"
      j_plain: TODO
`)
	want := `nodes:
  - id: z
    meta:
      a_one: "1"
      b_oh_seven: "007"
      c_yes: "yes"
      d_colon: 'has: a colon'
      e_quote: say "hi"
      f_num: 3.5
      g_bool: true
      h_brace: '{not a map}'
      i_date: "2024-03-01"
      j_plain: TODO
`
	if got := mustFormat(t, in); got != want {
		t.Errorf("quoting changed\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// Field specs travel inside the inventory so the file stands alone, which is
// also what lets the CLI type-check meta in CI.
func TestFieldsInInventory(t *testing.T) {
	src := `
fields:
  - {id: w, label: Watts, type: number, unit: W, min: 0}
  - {id: side, type: enum, enum: [front, rear]}
  - {id: ok, type: boolean}
  - {id: dim, type: composite, parts: [{id: w, type: number}, {id: h, type: number}]}
nodes:
  - {id: good, meta: {w: 42, side: front, ok: true, dim: {w: 1, h: 2}}}
`
	in := load1(t, src)
	if len(in.Fields) != 4 {
		t.Fatalf("want 4 fields, got %d", len(in.Fields))
	}
	if errs, _ := split(in); len(errs) != 0 {
		t.Fatalf("valid values must pass: %v", errs)
	}

	// the specs survive a format round trip
	out := mustFormat(t, in)
	if !strings.Contains(out, "fields:") || !strings.Contains(out, "unit: W") {
		t.Fatalf("fields lost on format:\n%s", out)
	}
	if len(load1(t, out).Fields) != 4 {
		t.Fatal("fields did not round trip")
	}
}

func TestFieldTypeChecks(t *testing.T) {
	head := `
fields:
  - {id: w, type: number, unit: W, min: 0, max: 10}
  - {id: i, type: integer}
  - {id: side, type: enum, enum: [front, rear]}
  - {id: openish, type: enum, open: true, enum: [a]}
  - {id: ok, type: boolean}
  - {id: dim, type: composite, parts: [{id: w}]}
nodes:
`
	for _, c := range []struct{ name, meta, want string }{
		{"wrong type", "{w: lots}", "should be a number in W"},
		{"below min", "{w: -1}", "below the minimum"},
		{"above max", "{w: 99}", "above the maximum"},
		{"non integer", "{i: 1.5}", "whole number"},
		{"off enum", "{side: sideways}", "not one of the declared"},
		{"not boolean", "{ok: yep}", "true or false"},
		{"composite not a map", "{dim: 5}", "mapping of parts"},
		{"undeclared part", "{dim: {nope: 1}}", "not declared"},
	} {
		in := load1(t, head+"  - {id: n, meta: "+c.meta+"}\n")
		errs, _ := split(in)
		if !has(errs, c.want) {
			t.Errorf("%s: want error containing %q, got %v", c.name, c.want, errs)
		}
	}

	// an open enum accepts anything, and an undeclared key is never an error
	in := load1(t, head+"  - {id: n, meta: {openish: whatever, totally_made_up: 1}}\n")
	if errs, _ := split(in); len(errs) != 0 {
		t.Errorf("open enum and undeclared keys must be fine, got %v", errs)
	}
}

func TestBadFieldSpecIsAnError(t *testing.T) {
	for _, c := range []struct{ src, want string }{
		{"fields: [{id: a, type: nonsense}]\nnodes: []\n", "unknown type"},
		{"fields: [{id: a, type: enum}]\nnodes: []\n", "enum with no values"},
		{"fields: [{id: a, type: composite}]\nnodes: []\n", "composite with no parts"},
		{"fields: [{id: a}, {id: a}]\nnodes: []\n", "duplicate field"},
	} {
		errs, _ := split(load1(t, c.src))
		if !has(errs, c.want) {
			t.Errorf("want %q for %q, got %v", c.want, strings.TrimSpace(c.src), errs)
		}
	}
}
