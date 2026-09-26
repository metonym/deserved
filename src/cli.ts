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
    -p, --port <n>       Port (default: 3000, or $PORT; hops to the next
                          free port unless set explicitly)
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
    PORT=8080 deserved dist
`);
}

export type CliOptions = Options & { portExplicit: boolean };

type BooleanOption = {
  [K in keyof Options]: Options[K] extends boolean ? K : never;
}[keyof Options];

// A Map, not an object literal, so arguments like `constructor` or
// `__proto__` can't hit prototype keys.
const BOOLEAN_FLAGS = new Map<string, [BooleanOption, boolean]>([
  ["-s", ["spa", true]],
  ["--spa", ["spa", true]],
  ["-w", ["watch", true]],
  ["--watch", ["watch", true]],
  ["-o", ["open", true]],
  ["--open", ["open", true]],
  ["--cors", ["cors", true]],
  ["--dir", ["dir", true]],
  ["--no-dir", ["dir", false]],
  ["--cache", ["cache", true]],
  ["--no-cache", ["cache", false]],
  ["--compress", ["compress", true]],
  ["--no-compress", ["compress", false]],
  ["-q", ["quiet", true]],
  ["--quiet", ["quiet", true]],
]);

const VALUE_FLAGS = new Map<string, "port" | "host">([
  ["-p", "port"],
  ["--port", "port"],
  ["-H", "host"],
  ["--host", "host"],
]);

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = Bun.env,
): CliOptions {
  const args = argv.slice(2);
  const opts: Options = { ...DEFAULT_OPTIONS };
  let root: string | undefined;
  let portFlagSet = false;

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

    const bool = BOOLEAN_FLAGS.get(a);
    if (bool) {
      opts[bool[0]] = bool[1];
      continue;
    }

    // `--port=8080` carries its value inline; `-p 8080` takes the next arg.
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq === -1 ? a : a.slice(0, eq);
    const key = VALUE_FLAGS.get(flag);
    if (key) {
      const value = eq === -1 ? args[++i] : a.slice(eq + 1);
      if (!value || (eq === -1 && value.startsWith("-"))) {
        fail(`Missing value for ${flag}`);
      }
      if (key === "port") {
        opts.port = parsePort(value, eq === -1 ? value : a);
        portFlagSet = true;
      } else {
        opts.host = value;
      }
      continue;
    }

    if (a.startsWith("-")) fail(`Unknown option: ${a}`);
    if (root !== undefined) fail(`Unexpected argument: ${a}`);
    root = a;
  }

  if (!portFlagSet && env.PORT !== undefined) {
    opts.port = parsePort(env.PORT, env.PORT);
  }
  opts.root = resolve(root ?? opts.root);
  return { ...opts, portExplicit: portFlagSet };
}

// `shown` is what the error message echoes back (the whole `--port=x` flag
// for the inline form, the bare value otherwise).
function parsePort(value: string, shown: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isInteger(n) || n < 0 || n > 65535)
    fail(`Invalid port: ${shown}`);
  return n;
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
    handle = await startServer(opts, { portExplicit: opts.portExplicit });
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
