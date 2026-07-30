import { readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { escapeHTML } from "bun";
import {
  type createSseHub,
  EVENTS_PATH,
  injectLiveReload,
  LIVE_PATH,
  LIVE_SCRIPT,
  logRequest,
  type Options,
} from "./server";

export type ResolvedFile = {
  path: string;
  file: Bun.BunFile;
  size: number;
  mtimeMs: number;
  kind: "file" | "html-ext" | "dir-index";
};

export type Handler = {
  (req: Request): Promise<Response>;
  invalidateResolutionCache(): void;
  invalidateCompressedCache(): void;
  resolutionCacheSize(): number;
  compressedCacheBytes(): number;
};

type Hub = ReturnType<typeof createSseHub>;

const encoder = new TextEncoder();
const FALLBACK = "application/octet-stream";

const EXT_MAP: Record<string, string> = {
  ".html": "text/html;charset=utf-8",
  ".htm": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".mjs": "text/javascript;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain;charset=utf-8",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export function contentType(file: Bun.BunFile, path: string): string {
  const type = file.type;
  if (type && type !== FALLBACK && type !== "") return type;

  const ext = extname(path).toLowerCase();
  return EXT_MAP[ext] ?? FALLBACK;
}

export function isCompressible(type: string): boolean {
  const base = type.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    base.startsWith("text/") ||
    base === "application/javascript" ||
    base === "text/javascript" ||
    base === "application/json" ||
    base === "application/xml" ||
    base === "image/svg+xml" ||
    base.endsWith("+json") ||
    base.endsWith("+xml")
  );
}

export function isHtml(type: string): boolean {
  return type.startsWith("text/html");
}

export function makeEtag(size: number, mtimeMs: number, tag = ""): string {
  return `"${size}-${Math.trunc(mtimeMs)}${tag}"`;
}

export function notModified(req: Request, etag: string): boolean {
  const inm = req.headers.get("If-None-Match");
  if (!inm) return false;
  return inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

export function notModifiedSince(req: Request, mtimeMs: number): boolean {
  const ims = req.headers.get("If-Modified-Since");
  if (!ims) return false;
  const since = Date.parse(ims);
  if (Number.isNaN(since)) return false;
  return Math.trunc(mtimeMs / 1000) * 1000 <= since;
}

export function isNotModified(
  req: Request,
  etag: string,
  mtimeMs: number,
): boolean {
  const inm = req.headers.get("If-None-Match");
  return inm ? notModified(req, etag) : notModifiedSince(req, mtimeMs);
}

export function ifRangeSatisfied(
  req: Request,
  etag: string,
  mtimeMs: number,
): boolean {
  const ifRange = req.headers.get("If-Range");
  if (!ifRange) return true;

  if (ifRange.startsWith('"') || ifRange.startsWith("W/")) {
    return ifRange === etag;
  }

  const date = Date.parse(ifRange);
  if (Number.isNaN(date)) return false;
  return date === Math.trunc(mtimeMs / 1000) * 1000;
}

export function acceptsHtml(req: Request): boolean {
  const accept = req.headers.get("Accept");
  if (!accept || accept === "*/*") return true;
  return accept.includes("text/html") || accept.includes("application/xhtml");
}

type CompressionEncoding = "zstd" | "gzip";

// zstd compresses faster and smaller than gzip, but not every client speaks
// it yet (e.g. Safari), so negotiate rather than replacing gzip outright.
export function pickEncoding(req: Request): CompressionEncoding | null {
  const accept = req.headers.get("Accept-Encoding") ?? "";
  if (accept.includes("zstd")) return "zstd";
  if (accept.includes("gzip")) return "gzip";
  return null;
}

export function shouldSpaFallback(pathname: string): boolean {
  if (pathname.startsWith("/__")) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (!last) return true;
  if (last.includes(".")) return false;
  return true;
}

function resolveFileWithRoot(
  rootAbs: string,
  realRoot: string | null,
  pathname: string,
): ResolvedFile | null {
  if (!realRoot) return null;
  const relative = pathname.replace(/^\/+/, "");
  const candidates = buildCandidates(relative);

  for (const candidate of candidates) {
    const full = safeJoin(rootAbs, candidate);
    if (!full) continue;
    const real = containedPath(realRoot, full);
    if (!real) continue;
    try {
      const st = statSync(real);
      if (st.isFile()) {
        return {
          path: real,
          file: Bun.file(real),
          size: st.size,
          mtimeMs: st.mtimeMs,
          kind: candidateKind(candidate),
        };
      }
    } catch {}
  }

  return null;
}

// Cap on distinct pathnames tracked per handler; cleared wholesale past
// this rather than evicted LRU-style -- simpler, and a dev server only
// ever probes as many distinct paths as a human clicks through.
export const RESOLUTION_CACHE_LIMIT = 4096;

// Bounds staleness in non-watch mode: a newly-created or newly-deleted
// candidate (e.g. adding about.html for a pathname previously cached as a
// 404) becomes visible within this window. Half the ~1s ceiling this node
// targets, so it stays comfortably inside that budget while still
// amortizing across the many requests a benchmark (or a browser loading a
// page's assets) fires in a burst.
export const RESOLUTION_TTL_MS = 500;

type CachedResolution = { real: string; kind: ResolvedFile["kind"] } | null;

// Remembers which candidate (if any) a pathname resolves to, so a repeat
// request skips the safeJoin + realpath containment walk across up to 3
// candidates -- the dominant cost of a 404 probe. Deliberately does NOT
// cache size/mtime: a cache hit always re-stats the winning candidate, so
// content edits are visible on the very next request regardless of TTL or
// --watch. Only *which file wins* (or whether one exists at all) can go
// stale, and that's bounded by watch invalidation or RESOLUTION_TTL_MS. If
// the cached candidate no longer stats as a file (deleted, replaced by a
// dir, symlink now escapes root), resolution falls through and re-probes
// for real instead of trusting the stale entry.
function createResolutionCache(
  rootAbs: string,
  realRoot: string | null,
  watch: boolean,
) {
  const cache = new Map<string, { value: CachedResolution; at: number }>();

  function resolveCached(pathname: string): ResolvedFile | null {
    const cached = cache.get(pathname);
    if (cached && (watch || Date.now() - cached.at < RESOLUTION_TTL_MS)) {
      if (cached.value === null) return null;
      try {
        const st = statSync(cached.value.real);
        if (st.isFile()) {
          return {
            path: cached.value.real,
            file: Bun.file(cached.value.real),
            size: st.size,
            mtimeMs: st.mtimeMs,
            kind: cached.value.kind,
          };
        }
      } catch {}
      // Cached winner disappeared or changed kind -- re-probe below.
    }

    const resolved = resolveFileWithRoot(rootAbs, realRoot, pathname);
    if (cache.size >= RESOLUTION_CACHE_LIMIT) cache.clear();
    cache.set(pathname, {
      value: resolved ? { real: resolved.path, kind: resolved.kind } : null,
      at: Date.now(),
    });
    return resolved;
  }

  return {
    resolveCached,
    invalidate: () => cache.clear(),
    size: () => cache.size,
  };
}

function candidateKind(candidate: string): ResolvedFile["kind"] {
  if (candidate.endsWith("/index.html")) return "dir-index";
  if (candidate.endsWith(".html") && !candidate.endsWith("/index.html")) {
    return "html-ext";
  }
  return "file";
}

export function buildCandidates(relative: string): string[] {
  if (!relative || relative === ".") {
    return ["index.html"];
  }

  const base = relative.endsWith("/") ? relative.slice(0, -1) : relative;
  if (!base) return ["index.html"];

  if (relative.endsWith("/")) {
    return [`${base}/index.html`];
  }

  return [base, `${base}.html`, `${base}/index.html`];
}

export function safeJoin(root: string, relative: string): string | null {
  const rootAbs = resolve(root);
  const full = normalize(join(rootAbs, relative));
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
    return null;
  }
  return full;
}

function containedPath(realRoot: string, full: string): string | null {
  try {
    const real = realpathSync(full);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return real;
  } catch {
    return null;
  }
}

const realRootCache = new Map<string, string | null>();

function realpathRoot(rootAbs: string): string | null {
  let real = realRootCache.get(rootAbs);
  if (real === undefined) {
    try {
      real = realpathSync(rootAbs);
    } catch {
      real = null;
    }
    realRootCache.set(rootAbs, real);
  }
  return real;
}

export function realContainedPath(
  rootAbs: string,
  full: string,
): string | null {
  const realRoot = realpathRoot(rootAbs);
  return realRoot ? containedPath(realRoot, full) : null;
}

function resolveDirWithRoot(
  rootAbs: string,
  realRoot: string | null,
  pathname: string,
): string | null {
  if (!realRoot) return null;
  const relative = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const full = safeJoin(rootAbs, relative || ".");
  if (!full) return null;
  const real = containedPath(realRoot, full);
  if (!real) return null;
  try {
    if (statSync(real).isDirectory()) return real;
  } catch {
    return null;
  }
  return null;
}

export function listDir(dir: string): { name: string; dir: boolean }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .map((e) => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export function directoryListing(
  pathname: string,
  entries: { name: string; dir: boolean }[],
): string {
  const base = pathname.endsWith("/") ? pathname : `${pathname}/`;
  const encodedBase = encodeUrlPath(base);
  const parent = parentPath(pathname);

  const rows = entries
    .map((e) => {
      const href =
        joinUrl(encodedBase, encodeURIComponent(e.name)) + (e.dir ? "/" : "");
      const label = e.dir ? `${e.name}/` : e.name;
      return `  <li><a href="${escapeHTML(href)}">${escapeHTML(label)}</a></li>`;
    })
    .join("\n");

  const up =
    parent !== null
      ? `  <li><a href="${escapeHTML(encodeUrlPath(parent))}">../</a></li>\n`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Index of ${escapeHTML(pathname)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    body { max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.1rem; font-weight: 600; }
    ul { list-style: none; padding: 0; }
    li { padding: 0.2rem 0; }
    a { color: inherit; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Index of ${escapeHTML(pathname || "/")}</h1>
  <ul>
${up}${rows}
  </ul>
</body>
</html>
`;
}

function parentPath(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return null;
  const trimmed = pathname.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx + 1);
}

function encodeUrlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function joinUrl(base: string, name: string): string {
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

export function createHandler(opts: Options, hub?: Hub): Handler {
  const rootAbs = resolve(opts.root);
  const realRoot = realpathRoot(rootAbs);
  const resolution = createResolutionCache(rootAbs, realRoot, opts.watch);
  const compression = createCompressionCache();

  const handle = async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    let pathname: string;
    if (url.pathname.includes("%")) {
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        const res = new Response("Bad Request", { status: 400 });
        logRequest(method, 400, url.pathname, opts.quiet);
        return headify(method, withCors(res, opts));
      }
    } else {
      pathname = url.pathname;
    }

    try {
      return await handleDecoded(
        req,
        method,
        pathname,
        url,
        opts,
        hub,
        rootAbs,
        realRoot,
        resolution.resolveCached,
        compression.getCompressed,
      );
    } catch (err) {
      console.error(err);
      const res = new Response("Internal Server Error", { status: 500 });
      logRequest(method, 500, url.pathname, opts.quiet);
      return headify(method, withCors(res, opts));
    }
  } as Handler;

  handle.invalidateResolutionCache = resolution.invalidate;
  handle.invalidateCompressedCache = compression.invalidate;
  handle.resolutionCacheSize = resolution.size;
  handle.compressedCacheBytes = compression.bytes;
  return handle;
}

function directoryRedirect(url: URL, opts: Options): Response {
  const location = `${url.pathname}/${url.search}`;
  const res = new Response(null, {
    status: 301,
    headers: { Location: location },
  });
  return withCors(res, opts);
}

async function handleDecoded(
  req: Request,
  method: string,
  pathname: string,
  url: URL,
  opts: Options,
  hub: Hub | undefined,
  rootAbs: string,
  realRoot: string | null,
  resolveCached: (pathname: string) => ResolvedFile | null,
  getCompressed: GetCompressed,
): Promise<Response> {
  const send = (res: Response) => {
    logRequest(method, res.status, pathname, opts.quiet);
    return headify(method, withCors(res, opts));
  };

  if (method !== "GET" && method !== "HEAD") {
    const res = new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
    return send(res);
  }

  if (opts.watch && pathname === LIVE_PATH) {
    const res = new Response(LIVE_SCRIPT, {
      headers: {
        "Content-Type": "text/javascript;charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
    return send(res);
  }

  if (opts.watch && pathname === EVENTS_PATH && hub) {
    // HEAD must not consume an SSE slot, so don't use the standard send().
    const res = hub.subscribe();
    logRequest(method, 200, pathname, opts.quiet);
    return withCors(res, opts);
  }

  // Stale tabs may still ask after --watch was used; stay quiet.
  if (pathname === LIVE_PATH || pathname === EVENTS_PATH) {
    return headify(
      method,
      withCors(new Response("Not Found", { status: 404 }), opts),
    );
  }

  const resolved = resolveCached(pathname);

  if (resolved) {
    if (resolved.kind === "dir-index" && !pathname.endsWith("/")) {
      const res = directoryRedirect(url, opts);
      logRequest(method, res.status, pathname, opts.quiet);
      return headify(method, res);
    }
    const res = await serveFile(getCompressed, req, resolved, opts);
    return send(res);
  }

  if (opts.spa && acceptsHtml(req) && shouldSpaFallback(pathname)) {
    const index = resolveCached("/");
    if (index) {
      const res = await serveFile(getCompressed, req, index, opts, true);
      return send(res);
    }
  }

  if (opts.dir) {
    const dir = resolveDirWithRoot(rootAbs, realRoot, pathname);
    if (dir) {
      if (!pathname.endsWith("/")) {
        const res = directoryRedirect(url, opts);
        logRequest(method, res.status, pathname, opts.quiet);
        return headify(method, res);
      }
      const entries = listDir(dir);
      const html = directoryListing(pathname, entries);
      const body = opts.watch ? injectLiveReload(html) : html;
      const res = new Response(body, {
        headers: {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
      return send(res);
    }
  }

  if (acceptsHtml(req)) {
    const notFoundPage = resolveCached("/404.html");
    if (notFoundPage) {
      const html = await notFoundPage.file.text();
      // Error pages are small; skip compression to keep this path simple.
      const body = opts.watch ? injectLiveReload(html) : html;
      const res = new Response(body, {
        status: 404,
        headers: {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
      return send(res);
    }
  }

  const res = new Response("Not Found", { status: 404 });
  return send(res);
}

type CompressedEntry = {
  size: number;
  mtimeMs: number;
  data: Uint8Array<ArrayBuffer>;
};

// Bounded by total retained bytes, not entry count -- payload sizes vary
// too widely (a few KB of CSS vs a near-2MB image) for a count cap to
// bound memory in any useful way. Map iteration order is insertion order,
// and every touch (read or write) re-inserts its key, so the front of the
// map is always the least-recently-used entry -- evicting from there
// gives LRU behavior without a separate linked list.
export const COMPRESSED_CACHE_BYTE_BUDGET = 64 * 1024 * 1024;

// No Bun.gzip async API exists (only gzipSync); fall back to node:zlib so
// gzip, like zstd, runs off the main thread instead of blocking the loop.
const gzipAsync = promisify(gzip);

async function compress(
  encoding: CompressionEncoding,
  raw: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (encoding === "zstd") {
    return new Uint8Array(await Bun.zstdCompress(raw));
  }
  return new Uint8Array(await gzipAsync(raw));
}

type GetCompressed = (
  resolved: { key: string; size: number; mtimeMs: number },
  encoding: CompressionEncoding,
  loadRaw: () => Promise<Uint8Array<ArrayBuffer>>,
) => Promise<Uint8Array<ArrayBuffer> | null>;

/**
 * Compressed-output cache scoped to one handler instance -- like
 * createResolutionCache above, this keeps the (potentially large)
 * compressed byte buffers it retains reclaimable as soon as the handler
 * itself is no longer referenced, instead of pinning them for the life of
 * the process the way a module-level cache would.
 */
function createCompressionCache() {
  const cache = new Map<string, CompressedEntry>();
  let bytes = 0;

  // In-flight compressions, keyed the same as cache plus the file version
  // being compressed, so concurrent requests for a stale version in-flight
  // don't get handed a promise for an even-older result.
  const pending = new Map<
    string,
    {
      size: number;
      mtimeMs: number;
      promise: Promise<Uint8Array<ArrayBuffer> | null>;
    }
  >();

  function touch(cacheKey: string, entry: CompressedEntry): void {
    const prev = cache.get(cacheKey);
    if (prev) {
      cache.delete(cacheKey);
      bytes -= prev.data.byteLength;
    }
    cache.set(cacheKey, entry);
    bytes += entry.data.byteLength;

    while (bytes > COMPRESSED_CACHE_BYTE_BUDGET && cache.size > 1) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (oldest) bytes -= oldest.data.byteLength;
    }
  }

  /**
   * Compressed-output cache keyed by (key, encoding, size, mtimeMs). Pick a
   * distinct key when the same path can yield different bytes, like
   * watch-injected HTML. loadRaw runs on miss. Concurrent misses for the
   * same (key, encoding, version) single-flight onto one in-flight
   * compression.
   */
  const getCompressed: GetCompressed = async (resolved, encoding, loadRaw) => {
    const cacheKey = `${resolved.key}:${encoding}`;
    const cached = cache.get(cacheKey);
    if (
      cached &&
      cached.size === resolved.size &&
      cached.mtimeMs === resolved.mtimeMs
    ) {
      touch(cacheKey, cached); // bump recency on hit
      return cached.data;
    }

    const inFlight = pending.get(cacheKey);
    if (
      inFlight &&
      inFlight.size === resolved.size &&
      inFlight.mtimeMs === resolved.mtimeMs
    ) {
      return inFlight.promise;
    }

    const entry: {
      size: number;
      mtimeMs: number;
      promise: Promise<Uint8Array<ArrayBuffer> | null>;
    } = {
      size: resolved.size,
      mtimeMs: resolved.mtimeMs,
      promise: Promise.resolve(null),
    };

    entry.promise = (async () => {
      try {
        const raw = await loadRaw();
        const data = await compress(encoding, raw);
        touch(cacheKey, {
          size: resolved.size,
          mtimeMs: resolved.mtimeMs,
          data,
        });
        return data;
      } catch {
        return null;
      } finally {
        if (pending.get(cacheKey)?.promise === entry.promise) {
          pending.delete(cacheKey);
        }
      }
    })();

    pending.set(cacheKey, entry);
    return entry.promise;
  };

  // The byte budget above only bounds *how much* a stale entry can cost,
  // not *whether* one lingers -- a path that's deleted (e.g. a bundler's
  // content-hashed output on rebuild) is never requested again, so its
  // entry is never naturally replaced or evicted. Watch mode already knows
  // a change happened; the caller wires this into that same signal so
  // deleted paths' compressed bytes don't outlive the file.
  function invalidate(): void {
    cache.clear();
    bytes = 0;
    pending.clear();
  }

  return { getCompressed, invalidate, bytes: () => bytes };
}

async function tryCompress(
  getCompressed: GetCompressed,
  req: Request,
  headers: Headers,
  cacheKey: { key: string; size: number; mtimeMs: number },
  loadRaw: () => Promise<Uint8Array<ArrayBuffer>>,
): Promise<Response | null> {
  const encoding = pickEncoding(req);
  if (!encoding) return null;
  const compressed = await getCompressed(cacheKey, encoding, loadRaw);
  if (!compressed) return null;
  headers.set("Content-Encoding", encoding);
  headers.set("Content-Length", String(compressed.byteLength));
  headers.delete("Accept-Ranges");
  headers.set("Vary", "Accept-Encoding");
  return new Response(compressed, { status: 200, headers });
}

async function serveFile(
  getCompressed: GetCompressed,
  req: Request,
  resolved: ResolvedFile,
  opts: Options,
  forceHtmlCache = false,
): Promise<Response> {
  const { path, file, size, mtimeMs } = resolved;
  const type = contentType(file, path);
  const htmlish = forceHtmlCache || isHtml(type);
  // Injected HTML must not share the raw-file ETag or a later non-watch
  // run will 304 the old body (still requesting /__live.js).
  const etag = makeEtag(size, mtimeMs, opts.watch && htmlish ? "-live" : "");
  const varies = opts.compress && isCompressible(type);

  if (isNotModified(req, etag, mtimeMs)) {
    const notModifiedHeaders = baseHeaders(etag, opts, htmlish, mtimeMs);
    if (varies) notModifiedHeaders.set("Vary", "Accept-Encoding");
    return new Response(null, {
      status: 304,
      headers: notModifiedHeaders,
    });
  }

  const headers = baseHeaders(etag, opts, htmlish, mtimeMs);
  headers.set("Content-Type", type);
  headers.set("Accept-Ranges", "bytes");
  if (varies) headers.set("Vary", "Accept-Encoding");

  const range =
    req.headers.get("Range") && ifRangeSatisfied(req, etag, mtimeMs)
      ? req.headers.get("Range")
      : null;
  if (range && req.method === "GET") {
    const parsed = parseRange(range, size);
    if (parsed === "invalid") {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, {
        status: 416,
        headers,
      });
    }
    if (parsed) {
      const { start, end } = parsed;
      const length = end - start + 1;
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      headers.set("Content-Length", String(length));
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers,
      });
    }
  }

  if (req.method === "HEAD") {
    headers.set("Content-Length", String(size));
    return new Response(null, { status: 200, headers });
  }

  if (opts.watch && htmlish && req.method === "GET") {
    if (opts.compress && isCompressible(type)) {
      // NUL can't appear in a real path, so it safely namespaces the
      // live-injected variant from the raw-file cache entry below.
      const res = await tryCompress(
        getCompressed,
        req,
        headers,
        { key: `${path}\0live`, size, mtimeMs },
        async () => encoder.encode(injectLiveReload(await file.text())),
      );
      if (res) return res;
    }

    const html = injectLiveReload(await file.text());
    headers.set("Content-Length", String(Buffer.byteLength(html)));
    return new Response(html, { status: 200, headers });
  }

  if (
    opts.compress &&
    req.method === "GET" &&
    isCompressible(type) &&
    size < 2_000_000
  ) {
    const res = await tryCompress(
      getCompressed,
      req,
      headers,
      { key: path, size, mtimeMs },
      async () => new Uint8Array(await file.arrayBuffer()),
    );
    if (res) return res;
  }

  headers.set("Content-Length", String(size));
  return new Response(file, { status: 200, headers });
}

function baseHeaders(
  etag: string,
  opts: Options,
  isHtmlFile: boolean,
  mtimeMs: number,
): Headers {
  const headers = new Headers();
  headers.set("ETag", etag);
  headers.set("Last-Modified", new Date(mtimeMs).toUTCString());

  if (opts.watch || !opts.cache || isHtmlFile) {
    headers.set("Cache-Control", "no-cache");
    return headers;
  }

  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return headers;
}

function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null | "invalid" {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;

  const startStr = m[1];
  const endStr = m[2];

  let start: number;
  let end: number;

  if (startStr === "" && endStr === "") return "invalid";

  if (startStr === "") {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return "invalid";
  }

  end = Math.min(end, size - 1);
  return { start, end };
}

function withCors(res: Response, opts: Options): Response {
  if (!opts.cors) return res;
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Headers", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  return res;
}

function headify(method: string, res: Response): Response {
  if (method !== "HEAD") return res;
  return new Response(null, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
