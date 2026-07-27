import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../../src/handlers";
import type { Options } from "../../src/server";

function makeOpts(root: string, overrides: Partial<Options> = {}): Options {
  return {
    root,
    port: 0,
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

describe("404.html convention", () => {
  const root = mkdtempSync(join(tmpdir(), "notfound-"));
  writeFileSync(join(root, "404.html"), "<html><body>nope</body></html>");
  writeFileSync(join(root, "real.png"), "fake-png-bytes");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("html-accepting client gets the custom 404 body", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(
      new Request("http://x/missing", {
        headers: { Accept: "text/html" },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<html><body>nope</body></html>");
    expect(res.headers.get("Content-Type")).toBe("text/html;charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("non-html client gets the plain-text 404", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(
      new Request("http://x/missing", {
        headers: { Accept: "application/json" },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  test("HEAD request has empty body", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(
      new Request("http://x/missing", {
        method: "HEAD",
        headers: { Accept: "text/html" },
      }),
    );
    expect(res.status).toBe(404);
    expect(res.body).toBeNull();
  });

  test("watch mode injects the live-reload script", async () => {
    const handle = createHandler(makeOpts(root, { watch: true }));
    const res = await handle(
      new Request("http://x/missing", {
        headers: { Accept: "text/html" },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("/__live.js");
  });

  test("SPA fallback still wins for extensionless routes", async () => {
    writeFileSync(join(root, "index.html"), "<html><body>app</body></html>");
    const handle = createHandler(makeOpts(root, { spa: true }));
    const res = await handle(
      new Request("http://x/some/route", {
        headers: { Accept: "text/html" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html><body>app</body></html>");
  });

  test("404.html serves when SPA declines (asset-like miss)", async () => {
    const handle = createHandler(makeOpts(root, { spa: true }));
    const res = await handle(
      new Request("http://x/missing.png", {
        headers: { Accept: "text/html" },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<html><body>nope</body></html>");
  });
});

describe("without 404.html", () => {
  const root = mkdtempSync(join(tmpdir(), "notfound-plain-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("plain-text 404 unchanged", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(
      new Request("http://x/missing", {
        headers: { Accept: "text/html" },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});
