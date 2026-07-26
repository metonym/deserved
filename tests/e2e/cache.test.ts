import { describe, expect, test } from "bun:test";
import { fixtureDir, removeFixture, startCli, write } from "./helpers";

describe("e2e cache headers", () => {
  test("by default, every response is no-cache", async () => {
    const root = fixtureDir("no-cache");
    write(root, "index.html", "<!doctype html><h1>home</h1>");
    write(root, "app.js", "console.log(1)");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const html = await fetch(`${cli.base}/`);
      expect(html.headers.get("Cache-Control")).toBe("no-cache");

      const asset = await fetch(`${cli.base}/app.js`);
      expect(asset.headers.get("Cache-Control")).toBe("no-cache");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("--cache makes HTML no-cache but other assets long-lived and immutable", async () => {
    const root = fixtureDir("cache");
    write(root, "index.html", "<!doctype html><h1>home</h1>");
    write(root, "app.js", "console.log(1)");

    const cli = await startCli(root, ["--no-compress", "--cache"]);
    try {
      const html = await fetch(`${cli.base}/`);
      expect(html.headers.get("Cache-Control")).toBe("no-cache");

      const asset = await fetch(`${cli.base}/app.js`);
      expect(asset.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });
});
