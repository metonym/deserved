# Changelog

## 0.3.0 — 2026-07-27

**Features**

- Serve root `404.html` (with live-reload injection under `--watch`) for HTML-accepting 404s; other clients keep the plain-text body. (`#13`)
- Honor `If-Range` per RFC 9110: a stale or weak validator falls back to a full `200` instead of a `206`. (`#13`)

**Performance**

- Compress asynchronously and single-flight concurrent cache misses for the same file/encoding. (`#8`)
- Preserve BunFile sendfile path under `--cors`; skip body read/compress/inject work for `HEAD`. (`#9`)

**Fixes**

- Stream Range responses instead of buffering the slice into memory. (`#7`)
- Harden request handling: malformed `%`-encoding → `400`, unexpected errors → logged `500`, send `Vary: Accept-Encoding` on identity compressible responses, keep validators on `416`, bracket `::1` in the banner URL. (`#10`)
- Redirect slashless directory URLs with `301`, and URI-encode directory-listing hrefs. (`#11`)
- `--watch` ignores nested `.git` / dot-directory churn (every path segment, not just the first). (`#13`)

## 0.2.0 — 2026-07-26

**Breaking changes:**

- Cache headers are off by default (`no-cache`). Use `--cache` for long-lived, immutable asset caching. (`#4`)

**Features**

- Prefer zstd compression when the client advertises it via `Accept-Encoding`, falling back to gzip. (`#6`)

**Fixes**

- Graceful shutdown on `SIGINT`/`SIGTERM`, including when `--watch` is not set; await `server.stop()` before exit. (`#5`)

## 0.1.0 — 2026-07-14

- initial release
