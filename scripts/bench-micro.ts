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
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench, do_not_optimize, group, run, summary } from "mitata";
import {
  acceptsHtml,
  buildCandidates,
  contentType,
  createHandler,
  directoryListing,
  ifRangeSatisfied,
  isCompressible,
  isNotModified,
  listDir,
  makeEtag,
  notModified,
  pickEncoding,
  safeJoin,
  shouldSpaFallback,
} from "../src/handlers";
import { DEFAULT_OPTIONS } from "../src/server";
import { assertRealistic, fakeHtml, fakeJs } from "./bench-fixture";

const root = mkdtempSync(join(tmpdir(), "deserved-bench-micro-"));
const appJs = fakeJs(50_000);
const indexHtml = fakeHtml(24_000, "bench");
const appJsCompressed = assertRealistic("app.js", appJs);
assertRealistic("index.html", indexHtml);
console.log(`fixture app.js: ${appJs.length} B raw, ${appJsCompressed} B zstd`);
writeFileSync(join(root, "index.html"), indexHtml);
writeFileSync(join(root, "app.js"), appJs);
mkdirSync(join(root, "docs"), { recursive: true });
for (let i = 0; i < 40; i++) {
  writeFileSync(join(root, "docs", `page-${i}.html`), "<p>hi</p>");
}

// Requests have no body here, so a fresh instance per call (mirroring real
// per-request allocation) is simpler and cheaper than cloning one.
const getReq = () => new Request("http://localhost/app.js");
const headReq = () =>
  new Request("http://localhost/app.js", { method: "HEAD" });
const missReq = () => new Request("http://localhost/nope.txt");
const etagReq = (etag: string) =>
  new Request("http://localhost/app.js", {
    headers: { "If-None-Match": etag },
  });

const handler = createHandler({ ...DEFAULT_OPTIONS, root, quiet: true });
await handler(getReq()); // warm the resolution + compression caches
const warmEtag = (await handler(getReq())).headers.get("ETag") ?? "";

group("request handling", () => {
  summary(() => {
    bench("handle: cache hit (compressed)", () => handler(getReq()));
    bench("handle: cache hit (HEAD)", () => handler(headReq()));
    bench("handle: 304 not-modified", () => handler(etagReq(warmEtag)));
    bench("handle: 404 miss", () => handler(missReq()));
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
  });
});

group("directory listing", () => {
  const dir = join(root, "docs");
  const entries = listDir(dir);
  summary(() => {
    bench("listDir", () => do_not_optimize(listDir(dir)));
    bench("directoryListing render", () =>
      do_not_optimize(directoryListing("/docs/", entries)),
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
