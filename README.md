# carve-lsp

Language server for [Carve](https://markup-carve.github.io/carve/) documents.

Initial features:

- Syntax diagnostics from the Carve parser.
- Advisory diagnostics for Djot/Markdown delimiter collisions.
- Document symbols for headings.

## Development

```bash
npm install
npm run build
npm test
```

Run the server over stdio:

```bash
npx carve-lsp --stdio
```

Editors can start the binary for files with `crv` or `carve` extensions.
