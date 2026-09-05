import { readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
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
  const semi = type.indexOf(";");
  const base = (semi === -1 ? type : type.slice(0, semi)).trim().toLowerCase();
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

function stripWeak(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

function etagMatches(inm: string, etag: string): boolean {
  // Common case is a single value with no comma -- skip the split() array
  // allocation entirely when there's nothing to split.
  if (inm.indexOf(",") === -1) return stripWeak(inm.trim()) === etag;
  return inm.split(",").some((t) => stripWeak(t.trim()) === etag);
}

export function notModified(req: Request, etag: string): boolean {
  const inm = req.headers.get("If-None-Match");
  return inm ? etagMatches(inm, etag) : false;
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
  return inm ? etagMatches(inm, etag) : notModifiedSince(req, mtimeMs);
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
  const slashIdx = pathname.lastIndexOf("/");
  if (slashIdx === pathname.length - 1) return true;
  return pathname.indexOf(".", slashIdx + 1) === -1;
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
    const resolved = statFile(real, candidateKind(candidate));
    if (resolved) return resolved;
  }

  return null;
}

function statFile(
  real: string,
  kind: ResolvedFile["kind"],
): ResolvedFile | null {
  try {
    const st = statSync(real);
    if (st.isFile()) {
      return {
        path: real,
        file: Bun.file(real),
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind,
      };
    }
  } catch {}
  return null;
}

// Cap on distinct pathnames tracked per handler; cleared wholesale past
// this rather than evicted LRU-style -- simpler, and a dev server only
// ever probes as many distinct paths as a human clicks through.
export const RESOLUTION_CACHE_LIMIT = 4096;

// Bounds staleness in non-watch mode: a newly created or deleted candidate
// (e.g. adding about.html for a pathname previously cached as a 404)
// becomes visible within this window.
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
      const hit = statFile(cached.value.real, cached.value.kind);
      if (hit) return hit;
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
  if (candidate.endsWith(".html")) return "html-ext";
  return "file";
}

export function buildCandidates(relative: string): string[] {
  if (!relative || relative === ".") {
    return ["index.html"];
  }

  const trailingSlash = relative.endsWith("/");
  const base = trailingSlash ? relative.slice(0, -1) : relative;
  if (!base) return ["index.html"];

  if (trailingSlash) {
    return [`${base}/index.html`];
  }

  return [base, `${base}.html`, `${base}/index.html`];
}

export function safeJoin(root: string, relative: string): string | null {
  // join() already normalizes its result, and every caller here already
  // passes an absolute root -- resolve() only matters for the rare caller
  // that doesn't, so skip it (and the cwd lookup it implies) when we can.
  const rootAbs = isAbsolute(root) ? root : resolve(root);
  const full = join(rootAbs, relative);
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

function realpathRoot(rootAbs: string): string | null {
  try {
    return realpathSync(rootAbs);
  } catch {
    return null;
  }
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
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

type DirEntry = {
  name: string;
  dir: boolean;
  size: number | null;
  mtimeMs: number | null;
};

function formatSize(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(mtimeMs: number | null): string {
  if (mtimeMs === null) return "-";
  const d = new Date(mtimeMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${date} ${hours}:${minutes}`;
}

export function listDir(dir: string): DirEntry[] {
  const dirents = readdirSync(dir, { withFileTypes: true });
  const entries: DirEntry[] = [];

  for (const e of dirents) {
    if (e.name.startsWith(".")) continue;
    const isDir = e.isDirectory();
    let size: number | null = null;
    let mtimeMs: number | null = null;
    if (!isDir) {
      try {
        const st = statSync(join(dir, e.name));
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {}
    }
    entries.push({ name: e.name, dir: isDir, size, mtimeMs });
  }

  return entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function directoryListing(
  pathname: string,
  entries: DirEntry[],
): string {
  const base = pathname.endsWith("/") ? pathname : `${pathname}/`;
  const encodedBase = encodeUrlPath(base);
  const parent = parentPath(pathname);
  const escapedPathname = escapeHTML(pathname);

  const rows = entries
    .map((e) => {
      const href =
        joinUrl(encodedBase, encodeURIComponent(e.name)) + (e.dir ? "/" : "");
      const label = e.dir ? `${e.name}/` : e.name;
      const size = formatSize(e.size);
      const date = formatDate(e.mtimeMs);
      return `  <li><a href="${escapeHTML(href)}">${escapeHTML(label)}</a> <span class="meta">${escapeHTML(size)}</span> <span class="meta">${escapeHTML(date)}</span></li>`;
    })
    .join("\n");

  const up =
    parent !== null
      ? `  <li><a href="${escapeHTML(encodeUrlPath(parent))}">../</a> <span class="meta">-</span> <span class="meta">-</span></li>\n`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Index of ${escapedPathname}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    body { max-width: 60rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.1rem; font-weight: 600; }
    ul { list-style: none; padding: 0; }
    li { padding: 0.2rem 0; display: flex; gap: 2rem; }
    li a { color: inherit; text-decoration: none; flex: 1; }
    li a:hover { text-decoration: underline; }
    .meta { text-align: right; min-width: 5rem; opacity: 0.6; }
  </style>
</head>
<body>
  <h1>Index of ${escapedPathname || "/"}</h1>
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

type HandlerContext = {
  opts: Options;
  hub: Hub | undefined;
  rootAbs: string;
  realRoot: string | null;
  resolveCached: (pathname: string) => ResolvedFile | null;
  getCompressed: GetCompressed;
};

export function createHandler(opts: Options, hub?: Hub): Handler {
  const rootAbs = resolve(opts.root);
  const realRoot = realpathRoot(rootAbs);
  const resolution = createResolutionCache(rootAbs, realRoot, opts.watch);
  const compression = createCompressionCache();
  const ctx: HandlerContext = {
    opts,
    hub,
    rootAbs,
    realRoot,
    resolveCached: resolution.resolveCached,
    getCompressed: compression.getCompressed,
  };

  const handle = async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    let pathname: string;
    if (url.pathname.includes("%")) {
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        const res = new Response("Bad Request", { status: 400 });
        return finish(method, url.pathname, opts, res);
      }
    } else {
      pathname = url.pathname;
    }

    try {
      return await handleDecoded(req, method, pathname, url, ctx);
    } catch (err) {
      console.error(err);
      const res = new Response("Internal Server Error", { status: 500 });
      return finish(method, url.pathname, opts, res);
    }
  } as Handler;

  handle.invalidateResolutionCache = resolution.invalidate;
  handle.invalidateCompressedCache = compression.invalidate;
  handle.resolutionCacheSize = resolution.size;
  handle.compressedCacheBytes = compression.bytes;
  return handle;
}

function finish(
  method: string,
  pathname: string,
  opts: Options,
  res: Response,
): Response {
  logRequest(method, res.status, pathname, opts.quiet);
  return headify(method, withCors(res, opts));
}

function directoryRedirect(url: URL): Response {
  return new Response(null, {
    status: 301,
    headers: { Location: `${url.pathname}/${url.search}` },
  });
}

function htmlPage(html: string, opts: Options, status = 200): Response {
  return new Response(opts.watch ? injectLiveReload(html) : html, {
    status,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

async function handleDecoded(
  req: Request,
  method: string,
  pathname: string,
  url: URL,
  {
    opts,
    hub,
    rootAbs,
    realRoot,
    resolveCached,
    getCompressed,
  }: HandlerContext,
): Promise<Response> {
  const send = (res: Response) => finish(method, pathname, opts, res);

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
      return send(directoryRedirect(url));
    }
    return send(await serveFile(getCompressed, req, resolved, opts));
  }

  const wantsHtml = acceptsHtml(req);

  if (opts.spa && wantsHtml && shouldSpaFallback(pathname)) {
    const index = resolveCached("/");
    if (index) {
      return send(await serveFile(getCompressed, req, index, opts, true));
    }
  }

  if (opts.dir) {
    const dir = resolveDirWithRoot(rootAbs, realRoot, pathname);
    if (dir) {
      if (!pathname.endsWith("/")) return send(directoryRedirect(url));
      const html = directoryListing(pathname, listDir(dir));
      return send(htmlPage(html, opts));
    }
  }

  if (wantsHtml) {
    const notFoundPage = resolveCached("/404.html");
    if (notFoundPage) {
      // Error pages are small; skip compression to keep this path simple.
      const html = await notFoundPage.file.text();
      return send(htmlPage(html, opts, 404));
    }
  }

  return send(new Response("Not Found", { status: 404 }));
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

// Bun 1.4's CompressionStream is native, so gzip runs off the main thread
// the same way Bun.zstdCompress does.
async function gzipCompress(
  raw: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function compress(
  encoding: CompressionEncoding,
  raw: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (encoding === "zstd") {
    return new Uint8Array(await Bun.zstdCompress(raw));
  }
  return gzipCompress(raw);
}

type GetCompressed = (
  resolved: { key: string; size: number; mtimeMs: number },
  encoding: CompressionEncoding,
  loadRaw: () => Promise<Uint8Array<ArrayBuffer>>,
) => Promise<Uint8Array<ArrayBuffer> | null>;

type PendingCompression = {
  size: number;
  mtimeMs: number;
  promise: Promise<Uint8Array<ArrayBuffer> | null>;
};

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
  const pending = new Map<string, PendingCompression>();

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
      touch(cacheKey, cached);
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

    const promise = (async () => {
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
      }
    })();

    const entry: PendingCompression = {
      size: resolved.size,
      mtimeMs: resolved.mtimeMs,
      promise,
    };
    pending.set(cacheKey, entry);
    // Only drop our own entry: a newer version may have replaced it.
    promise.finally(() => {
      if (pending.get(cacheKey) === entry) pending.delete(cacheKey);
    });
    return promise;
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
  const compressible = opts.compress && isCompressible(type);

  if (isNotModified(req, etag, mtimeMs)) {
    const notModifiedHeaders = baseHeaders(etag, opts, htmlish, mtimeMs);
    if (compressible) notModifiedHeaders.set("Vary", "Accept-Encoding");
    return new Response(null, {
      status: 304,
      headers: notModifiedHeaders,
    });
  }

  const headers = baseHeaders(etag, opts, htmlish, mtimeMs);
  headers.set("Content-Type", type);
  headers.set("Accept-Ranges", "bytes");
  if (compressible) headers.set("Vary", "Accept-Encoding");

  const rangeHeader = req.headers.get("Range");
  const range =
    rangeHeader && ifRangeSatisfied(req, etag, mtimeMs) ? rangeHeader : null;
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
    if (compressible) {
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

  if (compressible && req.method === "GET" && size < 2_000_000) {
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

export function withCors(res: Response, opts: Options): Response {
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
