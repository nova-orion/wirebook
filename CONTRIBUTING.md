# Contributing

Issues and feature requests are welcome. Please be aware of how this project is
maintained before you file one:

- **This is a personal tool published in case it is useful to someone else.**
  There is no roadmap and no support commitment.
- **Issues and feature requests are read.** If a request is something the
  maintainer happens to want too, it may get worked on. If it is not, it will
  probably be closed or left open without action. That is not a judgement on the
  idea; it just is not going to get built here.
- **Pull requests**: fine, but open an issue first for anything beyond a small
  fix, so you do not spend time on something that will not be merged.

## Before opening a PR

```sh
mise run test     # go vet, go build, unit tests, emitter parity sweep
```

Read [AGENTS.md](AGENTS.md) first. The one rule that trips people up: the Go CLI
and the browser editor are two implementations of the same canonical YAML format
and **must emit byte-identical output**. `test/sweep.mjs` enforces it across
about 1600 generated scalars. If you touch either emitter you must touch both.
