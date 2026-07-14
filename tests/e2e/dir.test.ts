import { describe, expect, test } from "bun:test";
import { fixtureDir, removeFixture, startCli, write } from "./helpers";

describe("e2e directory listing", () => {
  test("lists directories when there is no index", async () => {
    const root = fixtureDir("dir");
    write(root, "readme.txt", "hi");
    write(root, "css/app.css", "body{}");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const res = await fetch(`${cli.base}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("readme.txt");
      expect(html).toContain("css/");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("--no-dir returns 404 for bare directories", async () => {
    const root = fixtureDir("no-dir");
    write(root, "readme.txt", "hi");

    const cli = await startCli(root, ["--no-dir", "--no-compress"]);
    try {
      const res = await fetch(`${cli.base}/`);
      expect(res.status).toBe(404);
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });
});
