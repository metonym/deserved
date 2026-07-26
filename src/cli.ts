#!/usr/bin/env bun
import { resolve } from "node:path";
import { version as VERSION } from "../package.json";
import { type Options, startServer } from "./server";

function printHelp() {
  console.log(`
  deserved - tiny Bun static file server

  Usage
    deserved [path] [options]

  Options
    -p, --port <n>       Port (default: 3000)
    -H, --host <host>    Hostname (default: localhost)
    -s, --spa            SPA fallback to index.html
    -w, --watch          Live reload on file changes
    -o, --open           Open browser
        --cors           Enable CORS
        --dir            Enable directory listing (default)
        --no-dir         Disable directory listing
        --cache          Long-lived, immutable cache headers for assets
        --no-cache       Disable cache headers (default)
        --compress       zstd or gzip, negotiated per request (default)
        --no-compress    Disable compression
    -q, --quiet          Suppress request logs
    -h, --help           Show help
    -v, --version        Show version

  Examples
    deserved .
    deserved dist --spa
    deserved dist --port 8080
    deserved docs --watch --open
`);
}

export function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  let root = ".";
  let port = 3000;
  let host = "localhost";
  let spa = false;
  let watch = false;
  let open = false;
  let cors = false;
  let dir = true;
  let cache = false;
  let compress = true;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;

    if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    }
    if (a === "-v" || a === "--version") {
      console.log(VERSION);
      process.exit(0);
    }
    if (a === "-s" || a === "--spa") {
      spa = true;
      continue;
    }
    if (a === "-w" || a === "--watch") {
      watch = true;
      continue;
    }
    if (a === "-o" || a === "--open") {
      open = true;
      continue;
    }
    if (a === "--cors") {
      cors = true;
      continue;
    }
    if (a === "--dir") {
      dir = true;
      continue;
    }
    if (a === "--no-dir") {
      dir = false;
      continue;
    }
    if (a === "--cache") {
      cache = true;
      continue;
    }
    if (a === "--no-cache") {
      cache = false;
      continue;
    }
    if (a === "--compress") {
      compress = true;
      continue;
    }
    if (a === "--no-compress") {
      compress = false;
      continue;
    }
    if (a === "-q" || a === "--quiet") {
      quiet = true;
      continue;
    }
    if (a === "-p" || a === "--port") {
      const next = args[++i];
      if (!next || next.startsWith("-")) {
        fail(`Missing value for ${a}`);
      }
      const n = Number(next);
      if (!Number.isInteger(n) || n < 0 || n > 65535)
        fail(`Invalid port: ${next}`);
      port = n;
      continue;
    }
    if (a === "-H" || a === "--host") {
      const next = args[++i];
      if (!next || next.startsWith("-")) fail(`Missing value for ${a}`);
      host = next;
      continue;
    }
    if (a.startsWith("--port=")) {
      const n = Number(a.slice("--port=".length));
      if (!Number.isInteger(n) || n < 0 || n > 65535)
        fail(`Invalid port: ${a}`);
      port = n;
      continue;
    }
    if (a.startsWith("--host=")) {
      host = a.slice("--host=".length);
      continue;
    }
    if (a.startsWith("-")) {
      fail(`Unknown option: ${a}`);
    }
    root = a;
  }

  return {
    root: resolve(root),
    port,
    host,
    spa,
    watch,
    open,
    cors,
    dir,
    cache,
    compress,
    quiet,
  };
}

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error("Run deserved --help.");
  process.exit(1);
}

if (import.meta.main) {
  const opts = parseArgs(process.argv);
  await startServer(opts);
}
