import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { fixtureDir, removeFixture, startCli, write } from "./helpers";

describe("e2e symlink escape", () => {
  test("a symlink pointing outside root does not leak files", async () => {
    const outside = fixtureDir("symlink-outside");
    write(outside, "secret.txt", "top secret");

    const root = fixtureDir("symlink-root");
    write(root, "index.html", "<!doctype html><h1>home</h1>");
    symlinkSync(outside, `${root}/escape`);

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const file = await fetch(`${cli.base}/escape/secret.txt`);
      expect(file.status).toBe(404);

      const dir = await fetch(`${cli.base}/escape/`);
      expect(dir.status).toBe(404);
    } finally {
      cli.stop();
      removeFixture(root);
      removeFixture(outside);
    }
  });

  test("a symlink pointing directly at a file outside root does not leak it", async () => {
    const outside = fixtureDir("symlink-outside-file");
    write(outside, "secret.txt", "top secret");

    const root = fixtureDir("symlink-root-file");
    write(root, "index.html", "<!doctype html><h1>home</h1>");
    symlinkSync(`${outside}/secret.txt`, `${root}/leak.txt`);

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const res = await fetch(`${cli.base}/leak.txt`);
      expect(res.status).toBe(404);
    } finally {
      cli.stop();
      removeFixture(root);
      removeFixture(outside);
    }
  });
});
