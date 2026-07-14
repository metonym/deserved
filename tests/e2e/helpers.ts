import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const CLI = join(import.meta.dir, "../../src/cli.ts");
const TMP = join(import.meta.dir, ".tmp");

export function fixtureDir(name: string): string {
  mkdirSync(TMP, { recursive: true });
  const dir = join(TMP, `${name}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function write(root: string, relative: string, body: string) {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

export function removeFixture(root: string) {
  rmSync(root, { recursive: true, force: true });
}

export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("failed to allocate port");
  return port;
}

export type RunningCli = {
  base: string;
  port: number;
  proc: Subprocess;
  stop: () => void;
};

/** Spawn `bun src/cli.ts ...` and wait until it answers. */
export async function startCli(
  root: string,
  flags: string[] = [],
): Promise<RunningCli> {
  const port = await freePort();
  const proc = Bun.spawn(
    [
      "bun",
      CLI,
      root,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--quiet",
      ...flags,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`CLI exited early (${proc.exitCode}): ${err}`);
    }
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(200) });
      void res.arrayBuffer();
      return {
        base,
        port,
        proc,
        stop: () => {
          proc.kill();
        },
      };
    } catch {
      await Bun.sleep(40);
    }
  }

  proc.kill();
  throw new Error(`CLI did not become ready on ${base}`);
}
