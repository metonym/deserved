#!/usr/bin/env bun
/**
 * ostia micro-benchmarks for deserved's hot in-process functions.
 *
 * Complements scripts/bench.ts (which drives the real CLI over HTTP to
 * measure end-to-end req/s and RSS) by isolating the pure request-handling
 * logic from network and OS overhead, so it's precise enough to guide
 * function-level optimization. Establish a baseline before changing
 * src/handlers.ts, then re-run to compare.
 *
 * Usage: bun bench:micro [--filter <regex>]
 *
 * ostia prints ANSI-colored output to stdout; redirect and strip color
 * codes to save it to a file:
 *   bun bench:micro | sed 's/\x1b\[[0-9;]*m//g' > file.txt
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, keep, run, task } from "ostia";
import {
  acceptsHtml,
  baseHeaders,
  buildCandidates,
  compress,
  contentType,
  createHandler,
  directoryListing,
  ifRangeSatisfied,
  isCompressible,
  isNotModified,
  listDir,
  makeEtag,
  notModified,
  parseRange,
  pickEncoding,
  resolveDirWithRoot,
  resolveFileWithRoot,
  safeJoin,
  shouldSpaFallback,
} from "../src/handlers";
import { DEFAULT_OPTIONS, injectLiveReload, logRequest } from "../src/server";
import { assertRealistic, fakeHtml, fakeJs } from "./bench-fixture";

const root = mkdtempSync(join(tmpdir(), "deserved-bench-micro-"));
const realRoot = realpathSync(root);
const appJs = fakeJs(50_000);
const indexHtml = fakeHtml(24_000, "bench");
const appJsCompressed = assertRealistic("app.js", appJs);
assertRealistic("index.html", indexHtml);
console.log(`fixture app.js: ${appJs.length} B raw, ${appJsCompressed} B zstd`);
writeFileSync(join(root, "index.html"), indexHtml);
writeFileSync(join(root, "app.js"), appJs);
writeFileSync(join(root, "404.html"), fakeHtml(3_000, "not found"));
mkdirSync(join(root, "docs"), { recursive: true });
for (let i = 0; i < 40; i++) {
  writeFileSync(join(root, "docs", `page-${i}.html`), "<p>hi</p>");
}
mkdirSync(join(root, "docs1000"), { recursive: true });
for (let i = 0; i < 1000; i++) {
  writeFileSync(join(root, "docs1000", `f-${i}.txt`), "");
}

// Requests have no body here, so a fresh instance per call (mirroring real
// per-request allocation) is simpler and cheaper than cloning one.
const getReq = () => new Request("http://localhost/app.js");
const headReq = () =>
  new Request("http://localhost/app.js", { method: "HEAD" });
const identityReq = () =>
  new Request("http://localhost/app.js", {
    headers: { "Accept-Encoding": "identity" },
  });
const rangeReq = () =>
  new Request("http://localhost/app.js", {
    headers: { Range: "bytes=0-999" },
  });
// Explicit non-HTML Accept so this stays the plain-404 baseline now that
// 404.html exists in the fixture (an HTML client would hit that path
// instead -- see notFoundHtmlReq below).
const missReq = () =>
  new Request("http://localhost/nope.txt", {
    headers: { Accept: "image/png" },
  });
const notFoundHtmlReq = () =>
  new Request("http://localhost/nope.txt", {
    headers: { Accept: "text/html" },
  });
const dirReq = () => new Request("http://localhost/docs/");
const spaReq = () =>
  new Request("http://localhost/dashboard/settings", {
    headers: { Accept: "text/html" },
  });
const etagReq = (etag: string) =>
  new Request("http://localhost/app.js", {
    headers: { "If-None-Match": etag },
  });
let coldMissCounter = 0;
const coldMissReq = () =>
  new Request(`http://localhost/nope-${coldMissCounter++}.txt`, {
    headers: { Accept: "image/png" },
  });

const handler = createHandler({ ...DEFAULT_OPTIONS, root, quiet: true });
await handler(getReq()); // warm the resolution + compression caches
const warmEtag = (await handler(getReq())).headers.get("ETag") ?? "";

const corsHandler = createHandler({
  ...DEFAULT_OPTIONS,
  root,
  quiet: true,
  cors: true,
});
await corsHandler(getReq());
const loggingHandler = createHandler({
  ...DEFAULT_OPTIONS,
  root,
  quiet: false,
});
await loggingHandler(getReq());
const spaHandler = createHandler({
  ...DEFAULT_OPTIONS,
  root,
  quiet: true,
  spa: true,
});
await spaHandler(getReq());
const watchHandler = createHandler({
  ...DEFAULT_OPTIONS,
  root,
  quiet: true,
  watch: true,
});
await watchHandler(getReq());

group("request handling", () => {
  task("handle: cache hit (compressed)", () => handler(getReq()));
  task("handle: cache hit (compressed, watch)", () => watchHandler(getReq()));
  task("handle: cache hit (identity)", () => handler(identityReq()));
  task("handle: cache hit (HEAD)", () => handler(headReq()));
  task("handle: range 206", () => handler(rangeReq()));
  task("handle: 304 not-modified", () => handler(etagReq(warmEtag)));
  task("handle: 404 miss", () => handler(missReq()));
  task("handle: spa fallback", () => spaHandler(spaReq()));
  task("handle: 404 cold miss", () => handler(coldMissReq()), { gc: true });
  task(
    "handle: 404 with 404.html (HTML client)",
    () => handler(notFoundHtmlReq()),
    { gc: true },
  );
  task("handle: dir listing 40", () => handler(dirReq()), { gc: true });
  task("handle: cache hit + cors", () => corsHandler(getReq()));
  // Prints a log line per call -- run last, or pass --filter to skip the
  // spam (ostia prints its table after every group finishes).
  task("handle: cache hit, logging", () => loggingHandler(getReq()));
});

group("path resolution", () => {
  task("buildCandidates: bare path", () => keep(buildCandidates("docs/guide")));
  task("buildCandidates: trailing slash", () =>
    keep(buildCandidates("docs/guide/")),
  );
  task("safeJoin: contained", () => keep(safeJoin(root, "docs/page-1.html")));
  task("safeJoin: traversal attempt", () =>
    keep(safeJoin(root, "../../etc/passwd")),
  );
  task(
    "resolveFileWithRoot: cold, 3 candidates",
    () => keep(resolveFileWithRoot(root, realRoot, "/missing/path")),
    { gc: true },
  );
  task("resolveDirWithRoot", () =>
    keep(resolveDirWithRoot(root, realRoot, "/docs/")),
  );
});

group("content negotiation", () => {
  const file = Bun.file(join(root, "app.js"));
  const req = getReq();
  task("contentType", () => keep(contentType(file, "app.js")));
  task("isCompressible", () => keep(isCompressible("text/javascript")));
  task("pickEncoding", () => keep(pickEncoding(req)));
  task("acceptsHtml", () => keep(acceptsHtml(req)));
});

group("caching", () => {
  const req = getReq();
  const etaggedReq = etagReq(warmEtag);
  task("makeEtag", () => keep(makeEtag(12_345, 1_700_000_000_000)));
  task("notModified", () => keep(notModified(etaggedReq, warmEtag)));
  task("isNotModified", () =>
    keep(isNotModified(etaggedReq, warmEtag, 1_700_000_000_000)),
  );
  task("ifRangeSatisfied", () =>
    keep(ifRangeSatisfied(req, warmEtag, 1_700_000_000_000)),
  );
  task("shouldSpaFallback", () =>
    keep(shouldSpaFallback("/dashboard/settings")),
  );
  task("parseRange: valid", () =>
    keep(parseRange("bytes=0-999", appJs.length)),
  );
  task("parseRange: suffix", () =>
    keep(parseRange("bytes=-500", appJs.length)),
  );
  task("baseHeaders", () =>
    keep(baseHeaders(warmEtag, DEFAULT_OPTIONS, false, 1_700_000_000_000)),
  );
});

group("compression", () => {
  const encoder = new TextEncoder();
  const payload10k = encoder.encode(fakeJs(10_000, 42));
  const payload50k = encoder.encode(appJs);
  task("zstd 10 KB", () => compress("zstd", payload10k), { gc: true });
  task("zstd 50 KB", () => compress("zstd", payload50k), { gc: true });
  task("gzip 10 KB", () => compress("gzip", payload10k), { gc: true });
  task("gzip 50 KB", () => compress("gzip", payload50k), { gc: true });
});

group("directory listing", () => {
  const dir = join(root, "docs");
  const entries = listDir(dir);
  const dir1000 = join(root, "docs1000");
  const entries1000 = listDir(dir1000);
  task("listDir", () => keep(listDir(dir)));
  task("directoryListing render", () =>
    keep(directoryListing("/docs/", entries)),
  );
  task("listDir 1000", () => keep(listDir(dir1000)), { gc: true });
  task(
    "directoryListing render 1000",
    () => keep(directoryListing("/docs1000/", entries1000)),
    { gc: true },
  );
});

group("live reload", () => {
  task("injectLiveReload", () => keep(injectLiveReload(indexHtml)), {
    gc: true,
  });
  task("logRequest quiet", () => logRequest("GET", 200, "/app.js", true));
  task("logRequest console.log", () =>
    logRequest("GET", 200, "/app.js", false),
  );
});

function parseFilter(argv: string[]): string | undefined {
  const idx = argv.indexOf("--filter");
  return idx === -1 ? undefined : argv[idx + 1];
}

if (import.meta.main) {
  try {
    await run({ filter: parseFilter(process.argv.slice(2)) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
