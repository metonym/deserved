#!/usr/bin/env bun
/**
 * Zero-dependency benchmark harness for deserved's serving path.
 *
 * Spawns the real CLI (the same `Bun.serve` path the published binary
 * uses) against a generated fixture tree, then drives it with concurrent
 * `fetch()` workers and reports req/s, p50, and p99 latency per scenario.
 *
 * Numbers are for relative comparison on one machine (e.g. before/after a
 * change to src/), not an absolute throughput claim you can compare across
 * machines or against other servers.
 *
 * Usage: bun bench [--filter <scenario>] [--duration <seconds>]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli.ts");

const CONCURRENCY = 32;
const WARMUP_S = 1;
const DEFAULT_DURATION_S = 4;
const READY_TIMEOUT_MS = 5000;
const RSS_SAMPLE_INTERVAL_MS = 150;

type Scenario = {
  name: string;
  path: string;
  headers?: Record<string, string>;
};

type ScenarioResult = {
  name: string;
  requests: number;
  errors: number;
  seconds: number;
  reqPerSec: number;
  p50: number;
  p99: number;
  rssBeforeKb: number | null;
  rssPeakKb: number | null;
};

/** Server RSS in KB via `ps` (macOS and Linux). Comparable on one machine only. */
async function sampleRssKb(pid: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const kb = Number(text);
    return Number.isFinite(kb) && kb > 0 ? kb : null;
  } catch {
    return null;
  }
}

/** Poll RSS during a scenario. Catches the peak under load, not only before/after. */
class RssSampler {
  private samples: number[] = [];
  private running = false;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(
    private pid: number,
    private intervalMs: number,
  ) {}

  start(): void {
    this.running = true;
    this.loopDone = (async () => {
      while (this.running) {
        const kb = await sampleRssKb(this.pid);
        if (kb !== null) this.samples.push(kb);
        await Bun.sleep(this.intervalMs);
      }
    })();
  }

  async stop(): Promise<{ maxKb: number | null }> {
    this.running = false;
    await this.loopDone;
    if (this.samples.length === 0) return { maxKb: null };
    return { maxKb: Math.max(...this.samples) };
  }
}

function parseCliArgs(argv: string[]): {
  filter: string | null;
  duration: number;
} {
  let filter: string | null = null;
  let duration = DEFAULT_DURATION_S;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--filter") filter = argv[++i] ?? null;
    else if (a === "--duration")
      duration = Number(argv[++i]) || DEFAULT_DURATION_S;
  }
  return { filter, duration };
}

function randomBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  const chunk = 65536;
  for (let i = 0; i < size; i += chunk) {
    crypto.getRandomValues(buf.subarray(i, Math.min(i + chunk, size)));
  }
  return buf;
}

function repeatToSize(unit: string, size: number): string {
  const times = Math.ceil(size / unit.length);
  return unit.repeat(times).slice(0, size);
}

function jsFixture(size: number): string {
  const unit =
    "function add(a, b) { return a + b; }\nconst value = add(1, 2);\nexport { value };\n";
  return repeatToSize(unit, size);
}

function cssFixture(size: number): string {
  const unit =
    ".card { display: flex; padding: 1rem; margin: 0 auto; color: #333; }\n";
  return repeatToSize(unit, size);
}

function htmlFixture(title: string): string {
  const body = repeatToSize("<p>lorem ipsum dolor sit amet</p>\n", 700);
  return `<!DOCTYPE html>\n<html><head><title>${title}</title></head><body>\n${body}</body></html>\n`;
}

function buildFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "deserved-bench-"));
  writeFileSync(join(dir, "index.html"), htmlFixture("bench"));
  writeFileSync(join(dir, "app.js"), jsFixture(50_000));
  writeFileSync(join(dir, "style.css"), cssFixture(10_000));
  writeFileSync(join(dir, "img.bin"), randomBytes(500_000));
  mkdirSync(join(dir, "docs/guide"), { recursive: true });
  writeFileSync(join(dir, "docs/guide/index.html"), htmlFixture("guide"));
  return dir;
}

type RunningServer = { base: string; pid: number; stop: () => Promise<void> };

async function startServer(fixtureDir: string): Promise<RunningServer> {
  const proc: Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    ["bun", CLI, fixtureDir, "-q", "-p", "0"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + READY_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const match = buffered.match(/http:\/\/\S+:(\d+)/);
      if (match) {
        return {
          base: match[0],
          pid: proc.pid,
          stop: async () => {
            proc.kill();
            await proc.exited;
          },
        };
      }
    }
  } finally {
    reader.releaseLock();
  }

  proc.kill();
  const err = await new Response(proc.stderr).text();
  throw new Error(`server did not report a bound URL: ${err}`);
}

async function buildScenarios(base: string): Promise<Scenario[]> {
  const probe = await fetch(`${base}/app.js`);
  await probe.arrayBuffer();
  const etag = probe.headers.get("ETag") ?? "";

  return [
    { name: "html-root", path: "/" },
    { name: "js-50k", path: "/app.js", headers: { "Accept-Encoding": "zstd" } },
    {
      name: "js-50k-identity",
      path: "/app.js",
      headers: { "Accept-Encoding": "identity" },
    },
    { name: "bin-500k", path: "/img.bin" },
    { name: "nested-index", path: "/docs/guide/" },
    { name: "miss-404", path: "/nope" },
    { name: "etag-304", path: "/app.js", headers: { "If-None-Match": etag } },
  ];
}

async function measure(
  concurrency: number,
  durationS: number,
  task: () => Promise<number>,
): Promise<{ latencies: number[]; errors: number; actualSeconds: number }> {
  const start = Date.now();
  const endTime = start + durationS * 1000;
  const latencies: number[] = [];
  let errors = 0;

  async function worker() {
    while (Date.now() < endTime) {
      try {
        latencies.push(await task());
      } catch {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { latencies, errors, actualSeconds: (Date.now() - start) / 1000 };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(p * sortedAsc.length) - 1),
  );
  return sortedAsc[idx] ?? 0;
}

async function runScenario(
  base: string,
  scenario: Scenario,
  durationS: number,
  serverPid: number,
): Promise<ScenarioResult> {
  const url = base + scenario.path;
  const fire = async () => {
    const t0 = performance.now();
    const res = await fetch(url, { headers: scenario.headers });
    await res.arrayBuffer();
    return performance.now() - t0;
  };

  await measure(CONCURRENCY, WARMUP_S, fire);

  const rssBeforeKb = await sampleRssKb(serverPid);
  const sampler = new RssSampler(serverPid, RSS_SAMPLE_INTERVAL_MS);
  sampler.start();
  const { latencies, errors, actualSeconds } = await measure(
    CONCURRENCY,
    durationS,
    fire,
  );
  const { maxKb: rssPeakKb } = await sampler.stop();
  const sorted = [...latencies].sort((a, b) => a - b);

  return {
    name: scenario.name,
    requests: latencies.length,
    errors,
    seconds: actualSeconds,
    reqPerSec: latencies.length / actualSeconds,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    rssBeforeKb,
    rssPeakKb,
  };
}

function fmtMb(kb: number | null): string {
  return kb === null ? "n/a" : (kb / 1024).toFixed(1);
}

function fmtMbDelta(beforeKb: number | null, peakKb: number | null): string {
  if (beforeKb === null || peakKb === null) return "n/a";
  const deltaMb = (peakKb - beforeKb) / 1024;
  return `${deltaMb >= 0 ? "+" : ""}${deltaMb.toFixed(1)}`;
}

function printTable(results: ScenarioResult[]) {
  const headers = [
    "scenario",
    "req/s",
    "p50 (ms)",
    "p99 (ms)",
    "requests",
    "errors",
    "rss peak (MB)",
    "rss Δ (MB)",
  ];
  const rows = results.map((r) => [
    r.name,
    r.reqPerSec.toFixed(0),
    r.p50.toFixed(2),
    r.p99.toFixed(2),
    String(r.requests),
    String(r.errors),
    fmtMb(r.rssPeakKb),
    fmtMbDelta(r.rssBeforeKb, r.rssPeakKb),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );

  const formatRow = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");

  console.log(formatRow(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(formatRow(row));
}

async function main() {
  const { filter, duration } = parseCliArgs(process.argv.slice(2));
  const fixtureDir = buildFixture();
  let server: RunningServer | undefined;

  try {
    server = await startServer(fixtureDir);
    const scenarios = (await buildScenarios(server.base)).filter(
      (s) => !filter || s.name.includes(filter),
    );

    if (scenarios.length === 0) {
      console.error(`No scenarios match --filter "${filter}"`);
      process.exit(1);
    }

    const baselineRssKb = await sampleRssKb(server.pid);

    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
      console.log(`Running ${scenario.name}...`);
      results.push(
        await runScenario(server.base, scenario, duration, server.pid),
      );
    }

    const finalRssKb = await sampleRssKb(server.pid);

    console.log();
    printTable(results);
    console.log();
    console.log(
      `rss baseline: ${fmtMb(baselineRssKb)} MB, final: ${fmtMb(finalRssKb)} MB, growth: ${fmtMbDelta(baselineRssKb, finalRssKb)} MB`,
    );
    console.log(
      `bench-json: ${JSON.stringify({ concurrency: CONCURRENCY, warmupS: WARMUP_S, durationS: duration, baselineRssKb, finalRssKb, results })}`,
    );
  } finally {
    await server?.stop();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

await main();
