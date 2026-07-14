# deserved

Tiny, zero-dependency Bun static file server.

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
| `-p, --port <n>` | Port (default `3000`) |
| `-H, --host <host>` | Hostname (default `localhost`) |
| `-s, --spa` | SPA fallback to `index.html` |
| `-w, --watch` | Live reload via SSE |
| `-o, --open` | Open the browser |
| `--cors` | Enable CORS |
| `--no-dir` | Disable directory listing |
| `--no-cache` | Disable cache headers |
| `--no-compress` | Disable gzip |
| `-q, --quiet` | Suppress request logs |

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
```

## Features

- `Bun.file()` / `Bun.serve()`: no streams plumbing
- ETag + `304`
- Range requests (`206`) for media
- SPA mode (HTML Accept only; assets still 404)
- Optional live reload (`--watch`) via Server-Sent Events
- Gzip compression
- Smart cache headers (HTML `no-cache`, assets long-lived)
- Directory listings (disable with `--no-dir`)
- Colored request logs
