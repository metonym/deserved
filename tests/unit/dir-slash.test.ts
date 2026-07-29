import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../../src/handlers";
import type { Options } from "../../src/server";

function makeOpts(root: string, overrides: Partial<Options> = {}): Options {
  return {
    root,
    port: 0,
    portExplicit: false,
    host: "127.0.0.1",
    spa: false,
    watch: false,
    open: false,
    cors: false,
    dir: false,
    cache: true,
    compress: false,
    quiet: true,
    ...overrides,
  };
}

describe("directory trailing-slash redirect", () => {
  const root = mkdtempSync(join(tmpdir(), "dir-slash-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "index.html"), "<h1>sub index</h1>");
  mkdirSync(join(root, "my docs"));
  writeFileSync(join(root, "my docs", "index.html"), "<h1>my docs</h1>");
  mkdirSync(join(root, "nodex"));
  writeFileSync(join(root, "nodex", "file.txt"), "hi");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("GET /sub redirects to /sub/", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(new Request("http://x/sub"));
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/sub/");
  });

  test("GET /sub/ serves the index directly", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(new Request("http://x/sub/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>sub index</h1>");
  });

  test("GET /sub?x=1 preserves the query string in the redirect", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(new Request("http://x/sub?x=1"));
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/sub/?x=1");
  });

  test("candidate precedence: sub.html wins over sub/index.html, no redirect", async () => {
    writeFileSync(join(root, "sub.html"), "<h1>sub.html</h1>");
    try {
      const handle = createHandler(makeOpts(root));
      const res = await handle(new Request("http://x/sub"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<h1>sub.html</h1>");
    } finally {
      rmSync(join(root, "sub.html"));
    }
  });

  test("GET /my%20docs redirects to /my%20docs/ (raw encoding preserved)", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(new Request("http://x/my%20docs"));
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/my%20docs/");
  });

  test("dir without an index, --dir enabled: redirects then lists", async () => {
    const handle = createHandler(makeOpts(root, { dir: true }));
    const redirect = await handle(new Request("http://x/nodex"));
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("Location")).toBe("/nodex/");

    const listing = await handle(new Request("http://x/nodex/"));
    expect(listing.status).toBe(200);
    expect(await listing.text()).toContain("file.txt");
  });

  test("HEAD on a slashless dir returns 301 with an empty body", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(new Request("http://x/sub", { method: "HEAD" }));
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/sub/");
    expect(await res.text()).toBe("");
  });
});
