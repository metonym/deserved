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

export function acceptsHtml(req: Request): boolean {
  const accept = req.headers.get("Accept");
  if (!accept || accept === "*/*") return true;
  return accept.includes("text/html") || accept.includes("application/xhtml");
}

export function acceptsGzip(req: Request): boolean {
  return (req.headers.get("Accept-Encoding") ?? "").includes("gzip");
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

function resolveFile(root: string, pathname: string): ResolvedFile | null {
  const rootAbs = resolve(root);
  const realRoot = realpathRoot(rootAbs);
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
        };
      }
    } catch {}
  }

  return null;
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

function resolveDir(root: string, pathname: string): string | null {
  const rootAbs = resolve(root);
  const realRoot = realpathRoot(rootAbs);
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
  const parent = parentPath(pathname);

  const rows = entries
    .map((e) => {
      const href = joinUrl(base, e.name) + (e.dir ? "/" : "");
      const label = e.dir ? `${e.name}/` : e.name;
      return `  <li><a href="${escapeHTML(href)}">${escapeHTML(label)}</a></li>`;
    })
    .join("\n");

  const up =
    parent !== null
      ? `  <li><a href="${escapeHTML(parent)}">../</a></li>\n`
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

function joinUrl(base: string, name: string): string {
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

export function createHandler(opts: Options, hub?: Hub) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      const res = new Response("Bad Request", { status: 400 });
      logRequest(method, 400, url.pathname, opts.quiet);
      return headify(method, withCors(res, opts));
    }

    try {
      return await handleDecoded(req, method, pathname, opts, hub);
    } catch (err) {
      console.error(err);
      const res = new Response("Internal Server Error", { status: 500 });
      return withCors(res, opts);
    }
  };
}

async function handleDecoded(
  req: Request,
  method: string,
  pathname: string,
  opts: Options,
  hub?: Hub,
): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") {
    const res = new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
    logRequest(method, 405, pathname, opts.quiet);
    return withCors(res, opts);
  }

  if (opts.watch && pathname === LIVE_PATH) {
    const res = new Response(LIVE_SCRIPT, {
      headers: {
        "Content-Type": "text/javascript;charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
    logRequest(method, 200, pathname, opts.quiet);
    return headify(method, withCors(res, opts));
  }

  if (opts.watch && pathname === EVENTS_PATH && hub) {
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

  const resolved = resolveFile(opts.root, pathname);

  if (resolved) {
    const res = await serveFile(req, resolved, opts);
    logRequest(method, res.status, pathname, opts.quiet);
    return headify(method, withCors(res, opts));
  }

  if (opts.spa && acceptsHtml(req) && shouldSpaFallback(pathname)) {
    const index = resolveFile(opts.root, "/");
    if (index) {
      const res = await serveFile(req, index, opts, true);
      logRequest(method, res.status, pathname, opts.quiet);
      return headify(method, withCors(res, opts));
    }
  }

  if (opts.dir) {
    const dir = resolveDir(opts.root, pathname);
    if (dir) {
      const entries = listDir(dir);
      const html = directoryListing(pathname, entries);
      const body = opts.watch ? injectLiveReload(html) : html;
      const res = new Response(body, {
        headers: {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
      logRequest(method, 200, pathname, opts.quiet);
      return headify(method, withCors(res, opts));
    }
  }

  const res = new Response("Not Found", { status: 404 });
  logRequest(method, 404, pathname, opts.quiet);
  return headify(method, withCors(res, opts));
}

// Unbounded, but grows only with distinct files actually requested — fine
// for a dev-server process serving one directory tree, not worth an LRU.
const compressedCache = new Map<
  string,
  { size: number; mtimeMs: number; data: Uint8Array<ArrayBuffer> }
>();

// In-flight compressions, keyed the same as compressedCache plus the file
// version being compressed, so concurrent requests for a stale version
// in-flight don't get handed a promise for an even-older result.
const pendingCompression = new Map<
  string,
  {
    size: number;
    mtimeMs: number;
    promise: Promise<Uint8Array<ArrayBuffer> | null>;
  }
>();

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

/**
 * Compressed-output cache keyed by (key, encoding, size, mtimeMs). Pick a
 * distinct key when the same path can yield different bytes, like
 * watch-injected HTML. loadRaw runs on miss. Concurrent misses for the same
 * (key, encoding, version) single-flight onto one in-flight compression.
 */
async function getCompressed(
  resolved: { key: string; size: number; mtimeMs: number },
  encoding: CompressionEncoding,
  loadRaw: () => Promise<Uint8Array<ArrayBuffer>>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const cacheKey = `${resolved.key}:${encoding}`;
  const cached = compressedCache.get(cacheKey);
  if (
    cached &&
    cached.size === resolved.size &&
    cached.mtimeMs === resolved.mtimeMs
  ) {
    return cached.data;
  }

  const pending = pendingCompression.get(cacheKey);
  if (
    pending &&
    pending.size === resolved.size &&
    pending.mtimeMs === resolved.mtimeMs
  ) {
    return pending.promise;
  }

  const entry = {
    size: resolved.size,
    mtimeMs: resolved.mtimeMs,
  } as {
    size: number;
    mtimeMs: number;
    promise: Promise<Uint8Array<ArrayBuffer> | null>;
  };
  entry.promise = (async () => {
    try {
      const raw = await loadRaw();
      const data = await compress(encoding, raw);
      compressedCache.set(cacheKey, {
        size: resolved.size,
        mtimeMs: resolved.mtimeMs,
        data,
      });
      return data;
    } catch {
      return null;
    } finally {
      if (pendingCompression.get(cacheKey) === entry) {
        pendingCompression.delete(cacheKey);
      }
    }
  })();

  pendingCompression.set(cacheKey, entry);
  return entry.promise;
}

async function tryCompress(
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

  const range = req.headers.get("Range");
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
