import { statSync, watch } from "node:fs";
import { networkInterfaces } from "node:os";
import { relative, resolve } from "node:path";
import { createHandler } from "./handlers";
import { classifyBatch, createSseHub, isIgnoredWatchPath } from "./live";
import { flushLogs, logBanner, logInfo, logReload } from "./log";
import { DEFAULT_OPTIONS, type Options } from "./options";

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

export function formatUrl(host: string, port: number): string {
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
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
