# deserved

Tiny (8.7 kB gzip), zero-dep Bun static server.

```bash
bunx deserved .
bunx deserved dist --spa
bunx deserved dist --watch --open
```

## Install

```bash
bun add -g deserved
# or one-shot
bunx deserved dist --spa
```

## Usage

```bash
bunx deserved [path] [options]
```

| Flag | Description |
|------|-------------|
| `-p, --port <n>` | Port (default `3000`, or `$PORT`) |
| `-H, --host <host>` | Hostname (default `localhost`) |
| `-s, --spa` | SPA fallback to `index.html` |
| `-w, --watch` | Live reload via SSE |
| `-o, --open` | Open the browser |
| `--cors` | Enable CORS |
| `--dir`, `--no-dir` | Directory listing (default on) |
| `--cache`, `--no-cache` | Long-lived, immutable cache headers for assets (default off) |
| `--compress`, `--no-compress` | zstd/gzip compression (default on) |
| `-q, --quiet` | Suppress request logs |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## Examples

```bash
bunx deserved .
bunx deserved dist
bunx deserved dist --spa
bunx deserved dist --port 8080
bunx deserved dist --host 0.0.0.0
bunx deserved dist --open
bunx deserved dist --cors
bunx deserved dist --watch
PORT=8080 bunx deserved dist
```

The default port (`3000`, or `$PORT` if set) hops to the next free port (up
to 10 tries) if it's taken; an explicit `--port` never does — it fails
cleanly instead.

## Programmatic use

```ts
import { serve } from "deserved";

const server = await serve({ root: "dist", port: 0, quiet: true });
console.log(server.url);
await server.stop();
```

`serve()` accepts a `Partial<Options>`, merged over the same defaults as the
CLI (`DEFAULT_OPTIONS`). It resolves to `{ port, hostname, url, stop() }`;
`stop()` closes the server and, if `watch: true` was passed, the file
watcher. Unlike the CLI, a bind failure (e.g. a port already in use) rejects
the promise instead of exiting the process. A `port` passed to `serve()` is
always treated as explicit — it never hops to another port. `quiet: true`
silences all output, including the startup banner.

To mount the file server inside your own `Bun.serve()`, use the request
handler directly (it takes the same `Partial<Options>`; `watch` needs
`serve()`, which owns the file watcher):

```ts
import { createHandler } from "deserved";

Bun.serve({ fetch: createHandler({ root: "dist", spa: true, quiet: true }) });
```

## Features

- `Bun.file()` / `Bun.serve()`: no streams plumbing
- Clean URLs: `/about` serves `about.html` or `about/index.html`
- ETag + `304`
- Range requests (`206`) for media
- SPA mode (HTML Accept only; assets still 404)
- Custom `404.html` for browser requests
- Optional live reload (`--watch`) via Server-Sent Events; tabs reconnect and reload after a server restart
- CSS-only changes hot-swap stylesheets in place instead of a full page reload
- zstd or gzip compression, negotiated per request
- Cache headers off by default (`no-cache`); opt in per-run with `--cache` for long-lived, immutable asset caching
- Directory listings (disable with `--no-dir`)
- Dotfiles (`.env`, `.git/`) are never served, except `/.well-known/`
- Symlinks can't escape the served root
- Colored request logs (plain when piped or with `NO_COLOR`)
