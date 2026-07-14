import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  fixtureDir,
  freePort,
  removeFixture,
  startCli,
  write,
} from "./helpers";

const CLI = join(import.meta.dir, "../../src/cli.ts");

describe("e2e port conflict", () => {
  test("second instance on the same port fails cleanly instead of double-binding", async () => {
    const root = fixtureDir("port");
    write(root, "index.html", "<!doctype html><h1>home</h1>");

    const port = await freePort();
    const first = await startCli(root, [], port);
    try {
      const second = Bun.spawn(
        [
          "bun",
          CLI,
          root,
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--quiet",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      const exitCode = await second.exited;
      const stderr = await new Response(second.stderr).text();

      expect(exitCode).toBe(1);
      expect(stderr).toContain(`could not bind to 127.0.0.1:${port}`);
      expect(stderr).not.toContain("at startServer");

      // The first instance is unaffected and still serves requests.
      const res = await fetch(first.base);
      expect(res.status).toBe(200);
    } finally {
      first.stop();
      removeFixture(root);
    }
  });

  test("second instance on the default host fails cleanly instead of double-binding", async () => {
    const root = fixtureDir("port-default-host");
    write(root, "index.html", "<!doctype html><h1>home</h1>");

    const port = await freePort();
    const first = await startCli(root, [], port, null);
    try {
      const second = Bun.spawn(
        ["bun", CLI, root, "--port", String(port), "--quiet"],
        { stdout: "pipe", stderr: "pipe" },
      );

      const exitCode = await second.exited;
      const stderr = await new Response(second.stderr).text();

      expect(exitCode).toBe(1);
      expect(stderr).toContain(`could not bind to localhost:${port}`);
      expect(stderr).not.toContain("at startServer");

      // The first instance is unaffected and still serves requests.
      const res = await fetch(first.base);
      expect(res.status).toBe(200);
    } finally {
      first.stop();
      removeFixture(root);
    }
  });
});
