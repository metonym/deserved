#!/usr/bin/env bun
import { resolve } from "node:path";
import { version as VERSION } from "../package.json";
import {
  BindError,
  DEFAULT_OPTIONS,
  type Options,
  RootError,
  startServer,
} from "./server";

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
  const opts: Options = { ...DEFAULT_OPTIONS };
  let root = opts.root;

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
      opts.spa = true;
      continue;
    }
    if (a === "-w" || a === "--watch") {
      opts.watch = true;
      continue;
    }
    if (a === "-o" || a === "--open") {
      opts.open = true;
      continue;
    }
    if (a === "--cors") {
      opts.cors = true;
      continue;
    }
    if (a === "--dir") {
      opts.dir = true;
      continue;
    }
    if (a === "--no-dir") {
      opts.dir = false;
      continue;
    }
    if (a === "--cache") {
      opts.cache = true;
      continue;
    }
    if (a === "--no-cache") {
      opts.cache = false;
      continue;
    }
    if (a === "--compress") {
      opts.compress = true;
      continue;
    }
    if (a === "--no-compress") {
      opts.compress = false;
      continue;
    }
    if (a === "-q" || a === "--quiet") {
      opts.quiet = true;
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
      opts.port = n;
      continue;
    }
    if (a === "-H" || a === "--host") {
      const next = args[++i];
      if (!next || next.startsWith("-")) fail(`Missing value for ${a}`);
      opts.host = next;
      continue;
    }
    if (a.startsWith("--port=")) {
      const n = Number(a.slice("--port=".length));
      if (!Number.isInteger(n) || n < 0 || n > 65535)
        fail(`Invalid port: ${a}`);
      opts.port = n;
      continue;
    }
    if (a.startsWith("--host=")) {
      opts.host = a.slice("--host=".length);
      continue;
    }
    if (a.startsWith("-")) {
      fail(`Unknown option: ${a}`);
    }
    root = a;
  }

  opts.root = resolve(root);
  return opts;
}

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error("Run deserved --help.");
  process.exit(1);
}

if (import.meta.main) {
  const opts = parseArgs(process.argv);

  let handle: Awaited<ReturnType<typeof startServer>>;
  try {
    handle = await startServer(opts);
  } catch (err) {
    if (err instanceof RootError) {
      console.error(`Error: ${err.message}`);
      console.error("Run deserved --help.");
      process.exit(1);
    }
    if (err instanceof BindError) {
      console.error(`Error: ${err.message}`);
      console.error(
        err.cause instanceof Error ? err.cause.message : String(err.cause),
      );
      process.exit(1);
    }
    throw err;
  }

  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
