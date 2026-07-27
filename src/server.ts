import { watch } from "node:fs";
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

export const LIVE_PATH = "/__live.js";
export const EVENTS_PATH = "/__events";

export const LIVE_SCRIPT = `(()=>{const e=new EventSource("${EVENTS_PATH}");e.onmessage=()=>location.reload();e.onerror=()=>{e.close();setTimeout(()=>location.reload(),1000)}})()`;

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

  return { subscribe, broadcast };
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

function logReload(quiet: boolean) {
  if (quiet) return;
  console.log(`${c.yellow}*${c.reset} reload`);
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

export async function startServer(opts: Options) {
  const root = resolve(opts.root);
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
    console.error(`Error: could not bind to ${opts.host}:${opts.port}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
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
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && isIgnoredWatchPath(filename)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        logReload(opts.quiet);
        hub.broadcast("reload");
      }, 80);
    });

    logInfo("watching for changes", opts.quiet);
  }

  const shutdown = async () => {
    watcher?.close();
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (opts.open) {
    await openBrowser(url);
  }

  return server;
}
