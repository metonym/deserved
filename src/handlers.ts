import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
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

  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash) return FALLBACK; // no extension, or a dotfile like ".env"
  const ext = path.slice(dot).toLowerCase();
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

/** Per RFC 9110 §13.1.2, If-None-Match takes precedence when both are present. */
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

/** False for /logo.png-style paths and /__ live-reload routes. */
export function shouldSpaFallback(pathname: string): boolean {
  if (pathname.startsWith("/__")) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (!last) return true;
  if (last.includes(".")) return false;
  return true;
}

/** Assumes pathname is already decoded. */
export function resolveFile(
  root: string,
  pathname: string,
): ResolvedFile | null {
  const rootAbs = resolve(root);
  const relative = pathname.replace(/^\/+/, "");
  const candidates = buildCandidates(relative);

  for (const candidate of candidates) {
    const full = safeJoin(rootAbs, candidate);
    if (!full) continue;
    const real = realContainedPath(rootAbs, full);
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

/** Null when relative would escape root. */
export function safeJoin(root: string, relative: string): string | null {
  const rootAbs = resolve(root);
  const full = normalize(join(rootAbs, relative));
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
    return null;
  }
  return full;
}

/**
 * Resolves symlinks in `full` and re-checks containment against the real
 * root, so a symlink inside root that points outside it can't be used to
 * escape. Null if `full` escapes root (after resolving symlinks) or doesn't
 * exist. `rootAbs` must already be resolved (see `safeJoin`).
 */
export function realContainedPath(
  rootAbs: string,
  full: string,
): string | null {
  try {
    const real = realpathSync(full);
    const realRoot = realpathSync(rootAbs);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return real;
  } catch {
    return null;
  }
}

/** Assumes pathname is already decoded. */
export function resolveDir(root: string, pathname: string): string | null {
  const rootAbs = resolve(root);
  const relative = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const full = safeJoin(rootAbs, relative || ".");
  if (!full) return null;
  const real = realContainedPath(rootAbs, full);
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
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method.toUpperCase();

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
  };
}

const compressedCache = new Map<
  string,
  { size: number; mtimeMs: number; gz: Uint8Array<ArrayBuffer> }
>();

/**
 * Cached by (size, mtimeMs) — the same identity used for the ETag. `loadRaw`
 * is only invoked on a cache miss, so an unchanged file is neither re-read
 * nor re-gzipped.
 */
async function getCompressed(
  resolved: ResolvedFile,
  loadRaw: () => Promise<Uint8Array<ArrayBuffer>>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const cached = compressedCache.get(resolved.path);
  if (
    cached &&
    cached.size === resolved.size &&
    cached.mtimeMs === resolved.mtimeMs
  ) {
    return cached.gz;
  }
  try {
    const gz = Bun.gzipSync(await loadRaw());
    compressedCache.set(resolved.path, {
      size: resolved.size,
      mtimeMs: resolved.mtimeMs,
      gz,
    });
    return gz;
  } catch {
    return null;
  }
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

  if (isNotModified(req, etag, mtimeMs)) {
    return new Response(null, {
      status: 304,
      headers: baseHeaders(etag, opts, htmlish, mtimeMs),
    });
  }

  const headers = baseHeaders(etag, opts, htmlish, mtimeMs);
  headers.set("Content-Type", type);
  headers.set("Accept-Ranges", "bytes");

  const range = req.headers.get("Range");
  if (range && req.method === "GET") {
    const parsed = parseRange(range, size);
    if (parsed === "invalid") {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    if (parsed) {
      const { start, end } = parsed;
      const length = end - start + 1;
      const slice = await file.slice(start, end + 1).arrayBuffer();
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      headers.set("Content-Length", String(length));
      return new Response(slice, { status: 206, headers });
    }
  }

  if (opts.watch && htmlish && req.method === "GET") {
    let html = await file.text();
    html = injectLiveReload(html);
    let body: string | Uint8Array = html;

    if (opts.compress && isCompressible(type)) {
      const compressed = maybeCompress(req, html, headers);
      if (compressed) body = compressed;
    } else {
      headers.set("Content-Length", String(Buffer.byteLength(html)));
    }

    return new Response(body, { status: 200, headers });
  }

  if (
    opts.compress &&
    req.method === "GET" &&
    isCompressible(type) &&
    size < 2_000_000
  ) {
    const accept = req.headers.get("Accept-Encoding") ?? "";
    if (accept.includes("gzip")) {
      const compressed = await getCompressed(resolved, async () => {
        return new Uint8Array(await file.arrayBuffer());
      });
      if (compressed) {
        headers.set("Content-Encoding", "gzip");
        headers.set("Content-Length", String(compressed.byteLength));
        headers.delete("Accept-Ranges");
        headers.append("Vary", "Accept-Encoding");
        return new Response(compressed, { status: 200, headers });
      }
    }
  }

  headers.set("Content-Length", String(size));
  return new Response(file, { status: 200, headers });
}

function baseHeaders(
  etag: string,
  opts: Options,
  isHtmlFile: boolean,
  mtimeMs?: number,
): Headers {
  const headers = new Headers();
  headers.set("ETag", etag);
  if (mtimeMs !== undefined) {
    headers.set("Last-Modified", new Date(mtimeMs).toUTCString());
  }

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

function maybeCompress(
  req: Request,
  data: string | ArrayBuffer,
  headers: Headers,
): Uint8Array | null {
  const accept = req.headers.get("Accept-Encoding") ?? "";
  const buf =
    typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);

  if (accept.includes("gzip")) {
    try {
      const out = Bun.gzipSync(buf);
      headers.set("Content-Encoding", "gzip");
      headers.set("Content-Length", String(out.byteLength));
      headers.delete("Accept-Ranges");
      headers.append("Vary", "Accept-Encoding");
      return out;
    } catch {
      return null;
    }
  }

  return null;
}

function withCors(res: Response, opts: Options): Response {
  if (!opts.cors) return res;
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function headify(method: string, res: Response): Response {
  if (method !== "HEAD") return res;
  return new Response(null, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
