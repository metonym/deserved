import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli";
import { serve } from "../../src/index";

const TMP = join(import.meta.dir, ".tmp-port-fallback");

function fixtureDir(name: string): string {
  mkdirSync(TMP, { recursive: true });
  const dir = join(TMP, `${name}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function removeFixture(root: string) {
  rmSync(root, { recursive: true, force: true });
}

describe("port fallback", () => {
  test("non-explicit port in use hops to a nearby free port", async () => {
    const root = fixtureDir("hop");
    writeFileSync(join(root, "index.html"), "<!doctype html><h1>hi</h1>");

    const occupant = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok"),
    });
    const occupiedPort = occupant.port;
    if (occupiedPort === undefined) throw new Error("failed to allocate port");

    try {
      const server = await serve({
        root,
        port: occupiedPort,
        portExplicit: false,
        quiet: true,
      });
      try {
        expect(server.port).toBeGreaterThan(occupiedPort);
        expect(server.port).toBeLessThanOrEqual(occupiedPort + 10);

        // Fetch via the literal loopback IP: "localhost" can resolve to ::1
        // first, which isn't where we bound, and isn't what this test checks.
        const res = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(res.status).toBe(200);
      } finally {
        await server.stop();
      }
    } finally {
      occupant.stop(true);
      removeFixture(root);
    }
  });

  test("explicit port in use rejects instead of hopping", async () => {
    const root = fixtureDir("explicit");
    writeFileSync(join(root, "index.html"), "<!doctype html><h1>hi</h1>");

    const occupant = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok"),
    });
    const occupiedPort = occupant.port;
    if (occupiedPort === undefined) throw new Error("failed to allocate port");

    try {
      await expect(
        serve({ root, port: occupiedPort, quiet: true }),
      ).rejects.toThrow(`could not bind to localhost:${occupiedPort}`);
    } finally {
      occupant.stop(true);
      removeFixture(root);
    }
  });

  test("port 0 (random free port) never falls back", async () => {
    const root = fixtureDir("zero");
    writeFileSync(join(root, "index.html"), "<!doctype html><h1>hi</h1>");

    const server = await serve({ root, port: 0, quiet: true });
    try {
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await server.stop();
      removeFixture(root);
    }
  });
});

describe("parseArgs PORT env", () => {
  test("uses $PORT when no --port flag is given", () => {
    const opts = parseArgs(["bun", "deserved"], { PORT: "8123" });
    expect(opts.port).toBe(8123);
    expect(opts.portExplicit).toBe(false);
  });

  test("--port overrides $PORT and is marked explicit", () => {
    const opts = parseArgs(["bun", "deserved", "--port", "9000"], {
      PORT: "8123",
    });
    expect(opts.port).toBe(9000);
    expect(opts.portExplicit).toBe(true);
  });

  test("no --port and no $PORT keeps the default and is non-explicit", () => {
    const opts = parseArgs(["bun", "deserved"], {});
    expect(opts.port).toBe(3000);
    expect(opts.portExplicit).toBe(false);
  });

  test("invalid $PORT fails like an invalid --port value", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() =>
        parseArgs(["bun", "deserved"], { PORT: "not-a-port" }),
      ).toThrow("process.exit called");
      expect(errSpy).toHaveBeenCalledWith("Error: Invalid port: not-a-port");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
