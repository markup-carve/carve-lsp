# carve-lsp

Language server (LSP) for [Carve](https://markup-carve.github.io/carve/) markup documents.
Provides editor intelligence for `.crv` files via the
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
| File inclusion | Resolves `{{ path }}` directives and reports the failures as diagnostics - **off by default**, see below |

## File inclusion

Carve's `{{ path }}` directive is a processor-level feature (PART 9 §19 of the
grammar), not part of the parser. This server resolves it so that the thin
editor clients - `helix-carve`, `emacs-carve`, `vim-carve`, `zed-carve`,
`sublime-carve` - get inclusion support without each implementing it.

Resolution reads files from disk, so it is **opt-in and off by default**. The
server enables it only when it is asked to, and only inside a containment root.

### Settings

Pass these under `carve.includes`, either in `initializationOptions` at
initialize time or through `workspace/didChangeConfiguration`. Changing them
re-publishes diagnostics for every open document.

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `"auto"` | `"auto"` enables inclusion only for a workspace the client reports as trusted; `"on"` always; `"off"` never. A client that reports no trust gets inclusion off. |
| `includeRoot` | workspace root | Containment root override. With no workspace, the document's own directory is used - never the server's working directory. |
| `allowAbsolute` | `false` | Allow absolute include paths. They still have to canonicalize inside the root. |
| `allowedRemoteHosts` | `[]` | Hosts a remote include may name. This server has no fetcher, so a remote target is refused either way; the list exists so the gate is explicit. |
| `maxDepth` | `16` | Maximum transitive include depth. |
| `maxBytes` | `max(1 MiB, 8x document)` | Total byte budget across the whole include graph, charged per occurrence. |

Client trust is read from `initializationOptions.workspaceTrusted`.

```json
{
  "carve": {
    "includes": {
      "enabled": "auto",
      "maxDepth": 8
    }
  },
  "workspaceTrusted": true
}
```

### What is enforced

Every target has to canonicalize (symlinks resolved) to a file inside the
containment root. A symlink pointing out of the root, a `..` path that leaves
it, and an absolute path outside it are all refused. A `..` path whose real
target stays inside the root is fine - a chapter reaching a shared glossary is
ordinary layout. Remote URLs are never fetched. Recursion depth and total
expanded bytes are both bounded, so a file that includes another many times
cannot amplify without limit.

A refused target produces an `include-unresolved` diagnostic on the directive,
and the directive stays literal. The diagnostic deliberately does not say WHICH
check refused it: a distinguishable denial is a way to probe the layout of the
machine the server runs on.

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

Add a filetype detection entry if your Neovim does not already recognize `.crv`:

```lua
vim.filetype.add({
  extension = {
    crv = 'carve',
  },
})
```

### Other editors

Any editor with LSP support can start the server as an external process:

- **Command:** `carve-lsp --stdio`
- **File extension:** `.crv` (language ID: `carve`)
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
