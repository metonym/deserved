import { describe, expect, test } from "bun:test";
import { fixtureDir, removeFixture, startCli, write } from "./helpers";

describe("e2e spa", () => {
  test("falls back to index.html for routes, not assets", async () => {
    const root = fixtureDir("spa");
    write(root, "index.html", "<!doctype html><h1>app</h1>");
    write(root, "app.js", "console.log(1)");

    const cli = await startCli(root, ["--spa", "--no-compress"]);
    try {
      const route = await fetch(`${cli.base}/dashboard`, {
        headers: { Accept: "text/html" },
      });
      expect(route.status).toBe(200);
      expect(await route.text()).toContain("app");

      const nested = await fetch(`${cli.base}/users/42`, {
        headers: { Accept: "text/html" },
      });
      expect(nested.status).toBe(200);
      expect(await nested.text()).toContain("app");

      const asset = await fetch(`${cli.base}/missing.png`);
      expect(asset.status).toBe(404);

      const js = await fetch(`${cli.base}/app.js`);
      expect(js.status).toBe(200);
      expect(await js.text()).toContain("console.log");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("without --spa, unknown routes 404", async () => {
    const root = fixtureDir("no-spa");
    write(root, "index.html", "<!doctype html><h1>home</h1>");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const res = await fetch(`${cli.base}/dashboard`, {
        headers: { Accept: "text/html" },
      });
      expect(res.status).toBe(404);
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });
});
