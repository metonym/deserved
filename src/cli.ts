#!/usr/bin/env bun
import { resolve } from "node:path";

import { version as VERSION } from "../package.json";
import { DEFAULT_OPTIONS, type Options } from "./options";
import { BindError, RootError, startServer } from "./server";

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

type CliOptions = Options & { portExplicit: boolean };

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

    // Only the long form carries its value inline (`--port=8080`);
    // otherwise the value is the next arg (`-p 8080`).
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

    if (a.startsWith("-")) fail(`Unknown option: ${a}`, nearest(flag));
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

// Long options only, since every short one is one edit from another. A
// distance of a third of the name keeps the guess to a typo (`--hlep`),
// not a different word that happens to be short.
function nearest(flag: string): string | undefined {
  const known = [
    ...BOOLEAN_FLAGS.keys(),
    ...VALUE_FLAGS.keys(),
    "--help",
    "--version",
  ].filter((k) => k.startsWith("--"));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const k of known) {
    const d = distance(flag, k);
    if (d <= Math.max(1, Math.floor(k.length / 3)) && d < bestDistance) {
      best = k;
      bestDistance = d;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  const w = b.length + 1;
  const d = new Int32Array((a.length + 1) * w);
  const at = (i: number, j: number): number => d[i * w + j] ?? 0;
  for (let i = 0; i <= a.length; i++) d[i * w] = i;
  for (let j = 0; j <= b.length; j++) d[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        at(i - 1, j) + 1,
        at(i, j - 1) + 1,
        at(i - 1, j - 1) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, at(i - 2, j - 2) + 1);
      }
      d[i * w + j] = v;
    }
  }
  return at(a.length, b.length);
}

// A usage error exits 2. A near miss names the option meant, on one line;
// otherwise a second line points to --help.
function fail(msg: string, suggestion?: string): never {
  if (suggestion) {
    console.error(`Error: ${msg} (did you mean ${suggestion}?)`);
  } else {
    console.error(`Error: ${msg}`);
    console.error("Run deserved --help.");
  }
  process.exit(2);
}

if (import.meta.main) {
  const opts = parseArgs(process.argv);

  // Registered before the server starts, so a signal sent once the banner
  // prints, while `--watch` is still setting up, still shuts it down.
  let handle: Awaited<ReturnType<typeof startServer>> | undefined;
  const shutdown = async () => {
    await handle?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
}
