import { statSync, watch } from "node:fs";
import { networkInterfaces } from "node:os";
import { relative, resolve } from "node:path";
import { createHandler } from "./handlers";

export type Options = {
  root: string;
  port: number;
  host: string;
  spa: boolean;
  watch: boolean;
  open: boolean;
  cors: boolean;
  dir: boolean;
  cache: boolean;
  compress: boolean;
  quiet: boolean;
};

export const DEFAULT_OPTIONS = {
  root: ".",
  port: 3000,
  host: "localhost",
  spa: false,
  watch: false,
  open: false,
  cors: false,
  dir: true,
  cache: false,
  compress: true,
  quiet: false,
} satisfies Options;

export type ServerHandle = {
  port: number;
  hostname: string;
  url: string;
  stop: () => Promise<void>;
};

export class RootError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RootError";
  }
}

export class BindError extends Error {
  constructor(host: string, port: number, options?: ErrorOptions) {
    super(`could not bind to ${host}:${port}`, options);
    this.name = "BindError";
  }
}

const MAX_PORT_FALLBACK_ATTEMPTS = 10;

function isAddrInUseError(err: unknown): boolean {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    err.code === "EADDRINUSE"
  )
    return true;
  const message = err instanceof Error ? err.message : String(err);
  return /EADDRINUSE|address already in use/i.test(message);
}

export const LIVE_PATH = "/__live.js";
export const EVENTS_PATH = "/__events";

// Once the stream drops (server stopped or restarting), the browser's
// EventSource retries on its own; the first successful reconnect reloads
// the page. If the server comes back without --watch, /__events 404s and
// the source closes for good, so reload once to pick up the new server.
// A source that never connected (a handler with no hub) stays put, so
// it can't loop.
export const LIVE_SCRIPT = `(()=>{let down=false;const e=new EventSource("${EVENTS_PATH}");e.onopen=()=>{if(down)location.reload()};e.onmessage=(m)=>{if(m.data==="css"){for(const l of document.querySelectorAll('link[rel="stylesheet"]')){const h=l.href.split("?")[0];l.href=h+"?t="+Date.now()}}else{location.reload()}};e.onerror=()=>{if(down&&e.readyState===2)location.reload();down=true}})()`;

const INJECT = `<script src="${LIVE_PATH}"></script>`;

export function formatUrl(host: string, port: number): string {
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
}

export function injectLiveReload(html: string): string {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return html + INJECT;
  return html.slice(0, idx) + INJECT + html.slice(idx);
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

export function createSseHub() {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const PING = encoder.encode(": ping\n\n");

  // Bun force-closes a connection after ~10s of no traffic, which would
  // otherwise drop an idle browser tab's SSE stream and make it reload on
  // reconnect. Keep it warm so it only ever closes on shutdown.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      try {
        c.enqueue(PING);
      } catch {
        clients.delete(c);
      }
    }
  }, 8000);
  heartbeat.unref();

  function subscribe(): Response {
    let controller: ReadableStreamDefaultController<Uint8Array>;

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        clients.add(c);
        // retry: how soon the browser reconnects after a restart.
        c.enqueue(encoder.encode("retry: 500\n: connected\n\n"));
      },
      cancel() {
        clients.delete(controller);
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  function broadcast(data = "reload") {
    const payload = encoder.encode(`data: ${data}\n\n`);
    for (const c of clients) {
      try {
        c.enqueue(payload);
      } catch {
        clients.delete(c);
      }
    }
  }

  function close() {
    clearInterval(heartbeat);
    for (const c of clients) {
      try {
        c.close();
      } catch {}
    }
    clients.clear();
  }

  return { subscribe, broadcast, close };
}

// Plain text when piped (CI logs, `| tee`) or when NO_COLOR is set
// (https://no-color.org).
export function shouldColor(
  isTTY: boolean | undefined,
  env: Record<string, string | undefined>,
): boolean {
  return isTTY === true && !env.NO_COLOR;
}

const useColor = shouldColor(process.stdout.isTTY, process.env);
const ansi = (code: number) => (useColor ? `\x1b[${code}m` : "");

const c = {
  reset: ansi(0),
  dim: ansi(2),
  green: ansi(32),
  yellow: ansi(33),
  red: ansi(31),
  cyan: ansi(36),
  bold: ansi(1),
} as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control chars from logs
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: cheap pre-check so the common clean-path case skips replace()
const HAS_CONTROL = /[\x00-\x1f\x7f]/;

function sanitizeForLog(s: string): string {
  return HAS_CONTROL.test(s) ? s.replace(CONTROL_CHARS, "") : s;
}

const ICON_OK = `${c.green}✓${c.reset}`;
const ICON_REDIRECT = `${c.yellow}○${c.reset}`;
const ICON_ERR = `${c.red}✗${c.reset}`;
const DIM = c.dim;
const RESET = c.reset;

// Collapses many synchronous per-request writes into one per tick: a
// console.log/write per request costs a syscall each, which adds up under
// load. Lines queue here and flush once, at the end of the current
// microtask queue.
let pendingLines: string[] = [];

function scheduleFlush(): void {
  if (pendingLines.length === 1) queueMicrotask(flushLogs);
}

export function flushLogs(): void {
  if (pendingLines.length === 0) return;
  const out = pendingLines.join("\n");
  pendingLines = [];
  process.stdout.write(`${out}\n`);
}

export function logRequest(
  method: string,
  status: number,
  path: string,
  quiet: boolean,
) {
  if (quiet) return;
  const icon = status < 300 ? ICON_OK : status < 400 ? ICON_REDIRECT : ICON_ERR;
  pendingLines.push(
    `${icon} ${DIM}${method}${RESET} ${status} ${sanitizeForLog(path)}`,
  );
  scheduleFlush();
}

function logInfo(msg: string, quiet = false) {
  if (quiet) return;
  console.log(`${c.cyan}│${c.reset} ${msg}`);
}

export function isIgnoredWatchPath(filename: string): boolean {
  return filename
    .split(/[/\\]/)
    .some((segment) => segment.startsWith(".") || segment === "node_modules");
}

export function classifyBatch(files: (string | null)[]): "css" | "reload" {
  if (files.length === 0) return "reload";
  return files.every((f) => f?.endsWith(".css")) ? "css" : "reload";
}

function lanAddress(): string | null {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

function logBanner(
  url: string,
  root: string,
  flags: string[],
  networkUrl?: string,
) {
  console.log();
  console.log(
    `  ${c.bold}deserved${c.reset} ${c.dim}serving${c.reset} ${root}`,
  );
  console.log(`  ${c.green}->${c.reset}  ${c.cyan}${url}${c.reset}`);
  if (networkUrl) {
    console.log(`  ${c.green}->${c.reset}  ${c.cyan}${networkUrl}${c.reset}`);
  }
  if (flags.length) {
    console.log(`  ${c.dim}${flags.join("  ")}${c.reset}`);
  }
  console.log();
}

function logReload(quiet: boolean, kind: "css" | "reload") {
  if (quiet) return;
  console.log(`${c.yellow}*${c.reset} ${kind}`);
}

function openCommand(url: string): string[] {
  if (process.platform === "darwin") return ["open", url];
  if (process.platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

// Fire and forget: some xdg-open setups block until the browser exits,
// which would otherwise hold up startServer() for the whole session.
function openBrowser(url: string): void {
  try {
    Bun.spawn(openCommand(url), { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    console.error(`Could not open browser for ${url}`);
  }
}

function validateRoot(rootPath: string): void {
  try {
    const st = statSync(rootPath);
    if (!st.isDirectory()) {
      throw new RootError(`not a directory: ${rootPath}`);
    }
  } catch (err) {
    if (err instanceof RootError) throw err;
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new RootError(`directory not found: ${rootPath}`);
    }
    throw new RootError(`not a directory: ${rootPath}`);
  }
}

export type StartOptions = {
  // The default port hops to the next free one when taken; an explicit
  // one (the CLI's --port, or any port passed to serve()) never does.
  portExplicit?: boolean;
  // The CLI always prints the banner (-q only silences request logs);
  // serve() skips it when quiet so embedding stays silent.
  banner?: boolean;
};

export async function startServer(
  opts: Options,
  { portExplicit = false, banner = true }: StartOptions = {},
): Promise<ServerHandle> {
  const root = resolve(opts.root);
  validateRoot(root);

  const hub = opts.watch ? createSseHub() : undefined;
  const fetch = createHandler({ ...opts, root }, hub);

  // Bun.serve misses bind conflicts when hostname is the string "localhost".
  // A literal loopback IP throws. Bind to 127.0.0.1 so a second instance fails cleanly.
  const bindHost = opts.host === "localhost" ? "127.0.0.1" : opts.host;

  // Port 0 already means "any free port", so there's nothing to hop from.
  const maxHops =
    !portExplicit && opts.port !== 0 ? MAX_PORT_FALLBACK_ATTEMPTS : 0;

  let server: ReturnType<typeof Bun.serve> | undefined;
  for (let hop = 0; !server; hop++) {
    const port = opts.port + hop;
    try {
      server = Bun.serve({ port, hostname: bindHost, fetch });
    } catch (err) {
      if (hop >= maxHops || !isAddrInUseError(err)) {
        throw new BindError(opts.host, port, { cause: err });
      }
      continue;
    }
    if (hop > 0) logInfo(`port ${opts.port} in use, using ${port}`, opts.quiet);
  }

  const isWildcardHost = opts.host === "0.0.0.0" || opts.host === "::";
  const displayHost = isWildcardHost ? "localhost" : opts.host;
  const url = formatUrl(displayHost, server.port ?? opts.port);
  const lanIp = isWildcardHost ? lanAddress() : null;
  const networkUrl = lanIp ? `http://${lanIp}:${server.port}` : undefined;

  const flags: string[] = [];
  if (opts.spa) flags.push("--spa");
  if (opts.watch) flags.push("--watch");
  if (opts.cors) flags.push("--cors");
  if (!opts.dir) flags.push("--no-dir");
  if (!opts.compress) flags.push("--no-compress");
  if (opts.cache) flags.push("--cache");

  if (banner) {
    logBanner(url, relative(process.cwd(), root) || ".", flags, networkUrl);
  }

  let watcher: ReturnType<typeof watch> | undefined;
  if (opts.watch && hub) {
    let timer: Timer | null = null;
    const batch = new Set<string | null>();
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && isIgnoredWatchPath(filename)) return;
      // Clear before debouncing the reload broadcast, so a request racing
      // the debounce window still sees the post-change state.
      fetch.invalidateResolutionCache();
      fetch.invalidateCompressedCache();
      batch.add(filename);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const kind = classifyBatch([...batch]);
        batch.clear();
        logReload(opts.quiet, kind);
        hub.broadcast(kind);
      }, 80);
    });

    logInfo("watching for changes", opts.quiet);
  }

  const stop = async () => {
    watcher?.close();
    hub?.close();
    await server.stop();
    flushLogs();
    logInfo("server stopped", opts.quiet);
  };

  if (opts.open) openBrowser(url);

  return { port: server.port ?? opts.port, hostname: displayHost, url, stop };
}

export async function serve(
  options: Partial<Options> = {},
): Promise<ServerHandle> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return startServer(opts, {
    portExplicit: options.port !== undefined,
    banner: !opts.quiet,
  });
}
