# third_party

## js-yaml.min.js

js-yaml 4.1.0, MIT, from https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js

todo version https://github.com/nodeca/js-yaml/releases

Vendored rather than fetched from a CDN so the editor works offline and from
`file://`, and so no third party sees which pages you open. It is used for
*parsing* only; the emitter is hand-written in `js/core.js` to match Go's
`yaml.v3` byte for byte, which `test/sweep.mjs` enforces.

Replacing this file changes how values resolve on read, which can shift the
emitter's quoting decisions. Run `node test/sweep.mjs` after any bump.
