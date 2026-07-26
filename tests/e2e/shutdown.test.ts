import { describe, expect, test } from "bun:test";
import { fixtureDir, removeFixture, startCli, write } from "./helpers";

describe("e2e graceful shutdown", () => {
  test("exits on SIGTERM without --watch", async () => {
    const root = fixtureDir("shutdown-sigterm");
    write(root, "index.html", "<!doctype html><h1>v1</h1>");

    const cli = await startCli(root);
    try {
      cli.proc.kill("SIGTERM");
      const exitCode = await Promise.race([
        cli.proc.exited,
        Bun.sleep(3000).then(() => "timed out"),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("exits on SIGINT without --watch", async () => {
    const root = fixtureDir("shutdown-sigint");
    write(root, "index.html", "<!doctype html><h1>v1</h1>");

    const cli = await startCli(root);
    try {
      cli.proc.kill("SIGINT");
      const exitCode = await Promise.race([
        cli.proc.exited,
        Bun.sleep(3000).then(() => "timed out"),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("exits on SIGTERM with --watch", async () => {
    const root = fixtureDir("shutdown-watch-sigterm");
    write(root, "index.html", "<!doctype html><h1>v1</h1>");

    const cli = await startCli(root, ["--watch"]);
    try {
      cli.proc.kill("SIGTERM");
      const exitCode = await Promise.race([
        cli.proc.exited,
        Bun.sleep(3000).then(() => "timed out"),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });
});
