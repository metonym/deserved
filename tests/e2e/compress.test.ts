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
