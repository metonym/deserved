#!/usr/bin/env bun
/**
 * mitata micro-benchmarks for deserved's hot in-process functions.
 *
 * Complements scripts/bench.ts (which drives the real CLI over HTTP to
 * measure end-to-end req/s and RSS) by isolating the pure request-handling
 * logic from network and OS overhead, so it's precise enough to guide
 * function-level optimization. Establish a baseline before changing
 * src/handlers.ts, then re-run to compare.
 *
 * Usage: bun bench:micro [--filter <regex>]
 *
 * mitata prints ANSI-colored output to stdout; redirect and strip color
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
import { bench, do_not_optimize, group, run, summary } from "mitata";
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

group("request handling", () => {
  summary(() => {
    bench("handle: cache hit (compressed)", () => handler(getReq()));
    bench("handle: cache hit (identity)", () => handler(identityReq()));
    bench("handle: cache hit (HEAD)", () => handler(headReq()));
    bench("handle: range 206", () => handler(rangeReq()));
    bench("handle: 304 not-modified", () => handler(etagReq(warmEtag)));
    bench("handle: 404 miss", () => handler(missReq()));
    bench("handle: spa fallback", () => spaHandler(spaReq()));
    bench("handle: 404 cold miss", () => handler(coldMissReq())).gc("inner");
    bench("handle: 404 with 404.html (HTML client)", () =>
      handler(notFoundHtmlReq()),
    ).gc("inner");
    bench("handle: dir listing 40", () => handler(dirReq())).gc("inner");
    bench("handle: cache hit + cors", () => corsHandler(getReq()));
    // Prints a log line per call -- run last, or pass --filter to skip the
    // spam (mitata prints its table after every group finishes).
    bench("handle: cache hit, logging", () => loggingHandler(getReq()));
  });
});

group("path resolution", () => {
  summary(() => {
    bench("buildCandidates: bare path", () =>
      do_not_optimize(buildCandidates("docs/guide")),
    );
    bench("buildCandidates: trailing slash", () =>
      do_not_optimize(buildCandidates("docs/guide/")),
    );
    bench("safeJoin: contained", () =>
      do_not_optimize(safeJoin(root, "docs/page-1.html")),
    );
    bench("safeJoin: traversal attempt", () =>
      do_not_optimize(safeJoin(root, "../../etc/passwd")),
    );
    bench("resolveFileWithRoot: cold, 3 candidates", () =>
      do_not_optimize(resolveFileWithRoot(root, realRoot, "/missing/path")),
    ).gc("inner");
    bench("resolveDirWithRoot", () =>
      do_not_optimize(resolveDirWithRoot(root, realRoot, "/docs/")),
    );
  });
});

group("content negotiation", () => {
  const file = Bun.file(join(root, "app.js"));
  const req = getReq();
  summary(() => {
    bench("contentType", () => do_not_optimize(contentType(file, "app.js")));
    bench("isCompressible", () =>
      do_not_optimize(isCompressible("text/javascript")),
    );
    bench("pickEncoding", () => do_not_optimize(pickEncoding(req)));
    bench("acceptsHtml", () => do_not_optimize(acceptsHtml(req)));
  });
});

group("caching", () => {
  const req = getReq();
  const etaggedReq = etagReq(warmEtag);
  summary(() => {
    bench("makeEtag", () =>
      do_not_optimize(makeEtag(12_345, 1_700_000_000_000)),
    );
    bench("notModified", () =>
      do_not_optimize(notModified(etaggedReq, warmEtag)),
    );
    bench("isNotModified", () =>
      do_not_optimize(isNotModified(etaggedReq, warmEtag, 1_700_000_000_000)),
    );
    bench("ifRangeSatisfied", () =>
      do_not_optimize(ifRangeSatisfied(req, warmEtag, 1_700_000_000_000)),
    );
    bench("shouldSpaFallback", () =>
      do_not_optimize(shouldSpaFallback("/dashboard/settings")),
    );
    bench("parseRange: valid", () =>
      do_not_optimize(parseRange("bytes=0-999", appJs.length)),
    );
    bench("parseRange: suffix", () =>
      do_not_optimize(parseRange("bytes=-500", appJs.length)),
    );
    bench("baseHeaders", () =>
      do_not_optimize(
        baseHeaders(warmEtag, DEFAULT_OPTIONS, false, 1_700_000_000_000),
      ),
    );
  });
});

group("compression", () => {
  const encoder = new TextEncoder();
  const payload10k = encoder.encode(fakeJs(10_000, 42));
  const payload50k = encoder.encode(appJs);
  summary(() => {
    bench("zstd 10 KB", () => compress("zstd", payload10k)).gc("inner");
    bench("zstd 50 KB", () => compress("zstd", payload50k)).gc("inner");
    bench("gzip 10 KB", () => compress("gzip", payload10k)).gc("inner");
    bench("gzip 50 KB", () => compress("gzip", payload50k)).gc("inner");
  });
});

group("directory listing", () => {
  const dir = join(root, "docs");
  const entries = listDir(dir);
  const dir1000 = join(root, "docs1000");
  const entries1000 = listDir(dir1000);
  summary(() => {
    bench("listDir", () => do_not_optimize(listDir(dir)));
    bench("directoryListing render", () =>
      do_not_optimize(directoryListing("/docs/", entries)),
    );
    bench("listDir 1000", () => do_not_optimize(listDir(dir1000))).gc("inner");
    bench("directoryListing render 1000", () =>
      do_not_optimize(directoryListing("/docs1000/", entries1000)),
    ).gc("inner");
  });
});

group("live reload", () => {
  summary(() => {
    bench("injectLiveReload", () =>
      do_not_optimize(injectLiveReload(indexHtml)),
    ).gc("inner");
    bench("logRequest quiet", () => logRequest("GET", 200, "/app.js", true));
    bench("logRequest console.log", () =>
      logRequest("GET", 200, "/app.js", false),
    );
  });
});

function parseFilter(argv: string[]): RegExp | undefined {
  const idx = argv.indexOf("--filter");
  const pattern = idx === -1 ? undefined : argv[idx + 1];
  return pattern ? new RegExp(pattern) : undefined;
}

try {
  await run({ filter: parseFilter(process.argv.slice(2)) });
} finally {
  rmSync(root, { recursive: true, force: true });
}
