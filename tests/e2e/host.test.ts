import { describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  fixtureDir,
  freePort,
  removeFixture,
  startCli,
  write,
} from "./helpers";

const CLI = join(import.meta.dir, "../../src/cli.ts");

function lanAddress(): string | null {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

describe("e2e host / root resolution", () => {
  test("serves successfully with no --host flag (the CLI's real default)", async () => {
    const root = fixtureDir("default-host");
    write(root, "index.html", "<!doctype html><h1>home</h1>");

    const cli = await startCli(root, ["--no-compress"], undefined, null);
    try {
      const res = await fetch(cli.base);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("home");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("a nonexistent root starts cleanly and 404s every request", async () => {
    const port = await freePort();
    const proc = Bun.spawn(
      [
        "bun",
        CLI,
        "/tmp/deserved-e2e-nonexistent-root",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--quiet",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      const base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 5000;
      let res: Response | null = null;
      while (Date.now() < deadline) {
        try {
          res = await fetch(base, { signal: AbortSignal.timeout(200) });
          break;
        } catch {
          await Bun.sleep(40);
        }
      }
      expect(res?.status).toBe(404);
    } finally {
      proc.kill();
    }
  });

  test("--host 0.0.0.0 prints the local URL, plus a network URL when a LAN address exists", async () => {
    const root = fixtureDir("wildcard-host");
    write(root, "index.html", "<!doctype html><h1>home</h1>");

    const port = await freePort();
    const proc = Bun.spawn(
      ["bun", CLI, root, "--host", "0.0.0.0", "--port", String(port)],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      const base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          await fetch(base, { signal: AbortSignal.timeout(200) });
          break;
        } catch {
          await Bun.sleep(40);
        }
      }

      // Give the already-synchronous banner a moment to flush to the pipe.
      await Bun.sleep(100);
      const reader = proc.stdout.getReader();
      const { value } = await Promise.race([
        reader.read(),
        Bun.sleep(500).then(() => ({ value: undefined })),
      ]);
      await reader.cancel().catch(() => {});
      const out = value ? new TextDecoder().decode(value) : "";

      expect(out).toContain(`http://localhost:${port}`);
      const ip = lanAddress();
      if (ip) {
        expect(out).toContain(`http://${ip}:${port}`);
      }
    } finally {
      proc.kill();
      removeFixture(root);
    }
  });
});
