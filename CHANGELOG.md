# Changelog

## 0.2.0 — 2026-07-26

**Breaking changes:**

- Cache headers are off by default (`no-cache`). Use `--cache` for long-lived, immutable asset caching. (`#4`)

**Features**

- Prefer zstd compression when the client advertises it via `Accept-Encoding`, falling back to gzip. (`#6`)

**Fixes**

- Graceful shutdown on `SIGINT`/`SIGTERM`, including when `--watch` is not set; await `server.stop()` before exit. (`#5`)

## 0.1.0 — 2026-07-14

- initial release
