import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli";

describe("parseArgs", () => {
  test("defaults", () => {
    const opts = parseArgs(["bun", "deserved"]);
    expect(opts.port).toBe(3000);
    expect(opts.host).toBe("localhost");
    expect(opts.spa).toBe(false);
    expect(opts.watch).toBe(false);
    expect(opts.dir).toBe(true);
    expect(opts.cache).toBe(true);
    expect(opts.compress).toBe(true);
    expect(opts.cors).toBe(false);
    expect(opts.quiet).toBe(false);
  });

  test("path and common flags", () => {
    const opts = parseArgs([
      "bun",
      "deserved",
      "dist",
      "--spa",
      "--port",
      "8080",
      "--host",
      "0.0.0.0",
      "--watch",
      "--cors",
      "--no-dir",
      "--no-cache",
      "--no-compress",
      "--quiet",
    ]);
    expect(opts.root.endsWith("dist")).toBe(true);
    expect(opts.spa).toBe(true);
    expect(opts.port).toBe(8080);
    expect(opts.host).toBe("0.0.0.0");
    expect(opts.watch).toBe(true);
    expect(opts.cors).toBe(true);
    expect(opts.dir).toBe(false);
    expect(opts.cache).toBe(false);
    expect(opts.compress).toBe(false);
    expect(opts.quiet).toBe(true);
  });

  test("short flag aliases", () => {
    const opts = parseArgs([
      "bun",
      "deserved",
      "dist",
      "-s",
      "-p",
      "8080",
      "-H",
      "0.0.0.0",
      "-w",
      "-o",
      "-q",
    ]);
    expect(opts.root.endsWith("dist")).toBe(true);
    expect(opts.spa).toBe(true);
    expect(opts.port).toBe(8080);
    expect(opts.host).toBe("0.0.0.0");
    expect(opts.watch).toBe(true);
    expect(opts.open).toBe(true);
    expect(opts.quiet).toBe(true);
  });

  test("equals form for port and host", () => {
    const opts = parseArgs([
      "bun",
      "deserved",
      "--port=4000",
      "--host=127.0.0.1",
    ]);
    expect(opts.port).toBe(4000);
    expect(opts.host).toBe("127.0.0.1");
  });
});
