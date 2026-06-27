# carve-lsp

Language server (LSP) for [Carve](https://markup-carve.github.io/carve/) markup documents.
Provides editor intelligence for `.carve` / `.crv` files via the
[Language Server Protocol](https://microsoft.github.io/language-server-protocol/).

## Install

```bash
npm install -g @markup-carve/carve-lsp
```

Or run without installing:

```bash
npx @markup-carve/carve-lsp --stdio
```

The server communicates over **stdio** (`--stdio` flag).

## Supported capabilities

| Capability | Details |
|---|---|
| Diagnostics | Syntax errors from the Carve parser; advisory warnings for Djot/Markdown delimiter collisions |
| Document symbols | Headings as an outline tree |
| Hover | Contextual information on hover |
| Completion | Trigger characters `:` `#` `^` `[` |
| Go to definition | Jump to heading / reference targets |
| Find references | All uses of a heading id or reference label |
| Rename | Prepare + apply renames across the document |
| Code actions | Migration quick-fixes for deprecated Carve syntax |
| Code lens | Inline annotations on headings and references |
| Folding ranges | Fold sections and block containers |
| Formatting | Format the whole document |
| Semantic tokens | Token-based syntax highlighting |

## Editor setup

### VS Code

Install the
[vscode-carve](https://marketplace.visualstudio.com/items?itemName=markup-carve.vscode-carve)
extension, which bundles and auto-starts this server.

For a generic LSP client (e.g.
[vscode-languageclient](https://marketplace.visualstudio.com/items?itemName=adamvoss.vscode-languageclient)),
add to `.vscode/settings.json`:

```json
{
  "languageServerExample.serverCommand": "carve-lsp",
  "languageServerExample.serverArgs": ["--stdio"]
}
```

Or wire it up in a custom extension:

```ts
const serverOptions: ServerOptions = {
  command: 'carve-lsp',
  args: ['--stdio'],
};
const clientOptions: LanguageClientOptions = {
  documentSelector: [{ scheme: 'file', language: 'carve' }],
};
new LanguageClient('carve-lsp', 'Carve Language Server', serverOptions, clientOptions).start();
```

### Neovim (nvim-lspconfig)

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.carve_lsp then
  configs.carve_lsp = {
    default_config = {
      cmd = { 'carve-lsp', '--stdio' },
      filetypes = { 'carve', 'crv' },
      root_dir = lspconfig.util.root_pattern('.git', '.'),
      single_file_support = true,
    },
  }
end

lspconfig.carve_lsp.setup({})
```

Add a filetype detection entry if your Neovim does not already recognise `.carve` / `.crv`:

```lua
vim.filetype.add({
  extension = {
    carve = 'carve',
    crv   = 'carve',
  },
})
```

### Other editors

Any editor with LSP support can start the server as an external process:

- **Command:** `carve-lsp --stdio`
- **File extensions / language IDs:** `carve`, `crv`
- **Root pattern:** `.git` or the project root

## Development

```bash
npm install
npm run build
npm test
```

Run the server directly over stdio:

```bash
node dist/server.js --stdio
```
