import { describe, expect, test } from "bun:test";
import { fixtureDir, removeFixture, startCli, write } from "./helpers";

describe("e2e gzip", () => {
  test("compresses text when Accept-Encoding allows it", async () => {
    const root = fixtureDir("gzip");
    write(root, "index.html", `<!doctype html><h1>${"x".repeat(2000)}</h1>`);

    const cli = await startCli(root);
    try {
      const res = await fetch(`${cli.base}/`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Encoding")).toBe("gzip");
      expect(await res.text()).toContain("<h1>");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });
});

describe("e2e zstd", () => {
  test("prefers zstd over gzip when the client advertises both", async () => {
    const root = fixtureDir("zstd");
    write(root, "index.html", `<!doctype html><h1>${"x".repeat(2000)}</h1>`);

    const cli = await startCli(root);
    try {
      const res = await fetch(`${cli.base}/`, {
        headers: { "Accept-Encoding": "gzip, zstd" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Encoding")).toBe("zstd");
      expect(await res.text()).toContain("<h1>");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("falls back to gzip when the client doesn't support zstd", async () => {
    const root = fixtureDir("zstd-fallback");
    write(root, "index.html", `<!doctype html><h1>${"x".repeat(2000)}</h1>`);

    const cli = await startCli(root);
    try {
      const res = await fetch(`${cli.base}/`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Encoding")).toBe("gzip");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });
});
