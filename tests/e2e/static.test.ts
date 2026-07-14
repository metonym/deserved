import { describe, expect, test } from "bun:test";
import { fixtureDir, removeFixture, startCli, write } from "./helpers";

describe("e2e static", () => {
  test("serves files, etags, ranges, and HEAD", async () => {
    const root = fixtureDir("static");
    write(root, "index.html", "<!doctype html><h1>home</h1>");
    write(root, "about.html", "<!doctype html><h1>about</h1>");
    write(root, "docs/index.html", "<!doctype html><h1>docs</h1>");
    write(root, "logo.png", "fakepng");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const home = await fetch(`${cli.base}/`);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("home");

      const about = await fetch(`${cli.base}/about`);
      expect(about.status).toBe(200);
      expect(await about.text()).toContain("about");

      const docs = await fetch(`${cli.base}/docs`);
      expect(docs.status).toBe(200);
      expect(await docs.text()).toContain("docs");

      const first = await fetch(`${cli.base}/logo.png`);
      const etag = first.headers.get("ETag");
      expect(etag).toBeTruthy();
      if (!etag) throw new Error("expected ETag");
      const cached = await fetch(`${cli.base}/logo.png`, {
        headers: { "If-None-Match": etag },
      });
      expect(cached.status).toBe(304);

      const range = await fetch(`${cli.base}/logo.png`, {
        headers: { Range: "bytes=0-2" },
      });
      expect(range.status).toBe(206);
      expect(await range.text()).toBe("fak");

      const head = await fetch(`${cli.base}/`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");

      const missing = await fetch(`${cli.base}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });
});
