# Development

## Setup and maintenance

```bash
npm install
npm run build
npm test
```

Run the server directly over stdio:

```bash
node dist/server.js --stdio
```

## The highlighting grammar

Semantic tokens come from the carve-grammars TextMate grammar, vendored in
`src/carve-grammar.ts` at the commit in `CARVE_GRAMMARS_REV`. To move the pin:

```bash
node tools/sync-grammar.mjs <40-hex carve-grammars commit>
npm run build && npm test
```

The scope-to-token mapping is `tokenTypeOf` in `src/semantic.ts`.

## Diagnostics benchmark

`tools/bench-analysis.mjs` measures diagnostics on large documents. It reports the median and p95 of one `analyzeCarve` run, then drives the built server over stdio with a typing burst from a pulling client. For the burst it reports how long after the last keystroke the final pull is answered, and the longest the server's event loop stayed blocked.

```bash
git submodule update --init tests/spec
npm run build
node tools/bench-analysis.mjs --sizes 100,270,1000
```

The input repeats the first 20 `.crv` files of `tests/spec` (or the files given with `--seed`) to each size, once with unique and once with duplicated ids. `--dist <dir>` measures another build, such as one of `origin/main`, on the same input. The numbers depend on the machine, so compare two builds in the same session.
