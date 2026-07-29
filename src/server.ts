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

export const LIVE_PATH = "/__live.js";
export const EVENTS_PATH = "/__events";

export const LIVE_SCRIPT = `(()=>{const e=new EventSource("${EVENTS_PATH}");e.onmessage=(m)=>{if(m.data==="css"){for(const l of document.querySelectorAll('link[rel="stylesheet"]')){const h=l.href.split("?")[0];l.href=h+"?t="+Date.now()}}else{location.reload()}};e.onerror=()=>{e.close();setTimeout(()=>location.reload(),1000)}})()`;

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

export function createSseHub() {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const PING = encoder.encode(": ping\n\n");

  // Bun force-closes a connection after ~10s of no traffic, which would
  // otherwise kill an idle browser tab's SSE stream and trigger its
  // onerror reload fallback. Keep it warm so it only ever closes when we
  // close it (broadcast or shutdown).
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
        c.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
        clients.delete(controller);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
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

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
} as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control chars from logs
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function sanitizeForLog(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

export function logRequest(
  method: string,
  status: number,
  path: string,
  quiet: boolean,
) {
  if (quiet) return;
  const icon =
    status < 300
      ? `${c.green}✓${c.reset}`
      : status < 400
        ? `${c.yellow}○${c.reset}`
        : `${c.red}✗${c.reset}`;
  console.log(
    `${icon} ${c.dim}${method}${c.reset} ${status} ${sanitizeForLog(path)}`,
  );
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

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      await Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" })
        .exited;
    } else if (platform === "win32") {
      await Bun.spawn(["cmd", "/c", "start", "", url], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    } else {
      await Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" })
        .exited;
    }
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

export async function startServer(opts: Options): Promise<ServerHandle> {
  const root = resolve(opts.root);
  validateRoot(root);

  const hub = opts.watch ? createSseHub() : undefined;
  const fetch = createHandler({ ...opts, root }, hub);

  // Bun.serve misses bind conflicts when hostname is the string "localhost".
  // A literal loopback IP throws. Bind to 127.0.0.1 so a second instance fails cleanly.
  const bindHost = opts.host === "localhost" ? "127.0.0.1" : opts.host;

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: opts.port,
      hostname: bindHost,
      fetch: async (req) => {
        if (opts.cors && req.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "*",
              "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            },
          });
        }
        return fetch(req);
      },
    });
  } catch (err) {
    throw new BindError(opts.host, opts.port, { cause: err });
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

  logBanner(url, relative(process.cwd(), root) || ".", flags, networkUrl);

  let watcher: ReturnType<typeof watch> | undefined;
  if (opts.watch && hub) {
    let timer: Timer | null = null;
    const batch = new Set<string | null>();
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && isIgnoredWatchPath(filename)) return;
      // Clear before debouncing the reload broadcast, so a request racing
      // the debounce window still sees the post-change resolution state.
      fetch.invalidateResolutionCache();
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
    logInfo("server stopped", opts.quiet);
  };

  if (opts.open) {
    await openBrowser(url);
  }

  return { port: server.port ?? opts.port, hostname: displayHost, url, stop };
}

export async function serve(
  options: Partial<Options> = {},
): Promise<ServerHandle> {
  return startServer({ ...DEFAULT_OPTIONS, ...options });
}
