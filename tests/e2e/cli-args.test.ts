import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli.ts");

async function run(args: string[]): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe("e2e cli argument errors", () => {
  test("invalid port value exits 1 with a clear message", async () => {
    const { exitCode, stderr } = await run(["--port", "not-a-number"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid port");
  });

  test("out-of-range port value exits 1", async () => {
    const { exitCode, stderr } = await run(["--port", "70000"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid port");
  });

  test("invalid --port= form exits 1", async () => {
    const { exitCode, stderr } = await run(["--port=-1"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid port");
  });

  test("missing value for --port exits 1", async () => {
    const { exitCode, stderr } = await run(["--port"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Missing value for --port");
  });

  test("missing value for --host exits 1", async () => {
    const { exitCode, stderr } = await run(["--host"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Missing value for --host");
  });

  test("unknown flag exits 1", async () => {
    const { exitCode, stderr } = await run(["--bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown option: --bogus");
  });

  test("--help exits 0 and prints usage", async () => {
    const { exitCode, stdout } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage");
  });

  test("--version exits 0 and prints the package version", async () => {
    const pkg = await Bun.file(
      join(import.meta.dir, "../../package.json"),
    ).json();
    const { exitCode, stdout } = await run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });
});
