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
