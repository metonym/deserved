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
 *                   [--runs <n>] [--save <path>] [--compare <path>]
 *
 * --runs n     run each scenario n times (one warmup, then n measured runs)
 *              and report the median-by-req/s run.
 * --save path  write the result JSON (pretty-printed) to path, for a later
 *              --compare.
 * --compare path  diff this run's scenarios against a saved JSON file by
 *                 name and print percent-delta columns (|Δ| < 5% -> "~").
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  assertRealistic,
  fakeCss,
  fakeHtml,
  fakeJs,
  randomBytes,
} from "./bench-fixture";

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
  /** Extra CLI flags for the server this scenario runs against. Default: ["-q"]. */
  server?: string[];
};

type ScenarioResult = {
  name: string;
  requests: number;
  errors: number;
  seconds: number;
  reqPerSec: number;
  cpuUsPerReq: number | null;
  p50: number;
  p99: number;
  rssBeforeKb: number | null;
  rssPeakKb: number | null;
  server: string[];
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

/**
 * Server CPU time (user + system) in seconds, via /proc on Linux or `ps` on
 * macOS. req/s saturates once the harness and server share a CPU, but this
 * tracks handler cost regardless of client-side contention.
 */
async function cpuSeconds(pid: number): Promise<number | null> {
  const statPath = `/proc/${pid}/stat`;
  if (existsSync(statPath)) {
    try {
      const text = await Bun.file(statPath).text();
      const afterComm = text.slice(text.lastIndexOf(")") + 2);
      const fields = afterComm.split(" ");
      // Fields count from 1 at "pid"; afterComm starts at field 3 (state).
      const utimeTicks = Number(fields[14 - 3]);
      const stimeTicks = Number(fields[15 - 3]);
      if (!Number.isFinite(utimeTicks) || !Number.isFinite(stimeTicks))
        return null;
      return (utimeTicks + stimeTicks) / 100;
    } catch {
      return null;
    }
  }

  try {
    const proc = Bun.spawn(["ps", "-o", "utime=,stime=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const [utime, stime] = text.split(/\s+/, 2);
    const u = parseClockSeconds(utime);
    const s = parseClockSeconds(stime);
    return u === null || s === null ? null : u + s;
  } catch {
    return null;
  }
}

/** Parses `ps`'s `mm:ss.cc` or `hh:mm:ss` time format into seconds. */
function parseClockSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
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
  runs: number;
  save: string | null;
  compare: string | null;
} {
  let filter: string | null = null;
  let duration = DEFAULT_DURATION_S;
  let runs = 1;
  let save: string | null = null;
  let compare: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--filter") filter = argv[++i] ?? null;
    else if (a === "--duration")
      duration = Number(argv[++i]) || DEFAULT_DURATION_S;
    else if (a === "--runs") runs = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--save") save = argv[++i] ?? null;
    else if (a === "--compare") compare = argv[++i] ?? null;
  }
  return { filter, duration, runs, save, compare };
}

function buildFixture(): { dir: string; jsCompressedBytes: number } {
  const dir = mkdtempSync(join(tmpdir(), "deserved-bench-"));
  const html = fakeHtml(24_000, "bench");
  const js = fakeJs(50_000);
  const css = fakeCss(10_000);
  const jsCompressed = assertRealistic("app.js", js);
  assertRealistic("index.html", html);
  assertRealistic("style.css", css);
  console.log(`fixture app.js: ${js.length} B raw, ${jsCompressed} B zstd`);

  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "app.js"), js);
  writeFileSync(join(dir, "style.css"), css);
  writeFileSync(join(dir, "img.bin"), randomBytes(500_000));
  mkdirSync(join(dir, "docs/guide"), { recursive: true });
  writeFileSync(join(dir, "docs/guide/index.html"), fakeHtml(800, "guide"));
  return { dir, jsCompressedBytes: jsCompressed };
}

type RunningServer = { base: string; pid: number; stop: () => Promise<void> };

/** Spawns the CLI in quiet mode and discovers its port by reading stdout. */
async function startQuietServer(
  fixtureDir: string,
  flags: string[],
): Promise<RunningServer> {
  const proc: Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    ["bun", CLI, fixtureDir, ...flags, "-p", "0"],
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

async function allocateFreePort(): Promise<number> {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = srv.port;
  await srv.stop(true);
  if (!port) throw new Error("could not allocate a free port");
  return port;
}

/**
 * Spawns the CLI in non-quiet mode. stdout carries the request log, which
 * we don't need and don't want to pay for reading -- discard it to
 * /dev/null and poll the pre-allocated port instead of parsing the banner.
 */
async function startLoggingServer(
  fixtureDir: string,
  flags: string[],
): Promise<RunningServer> {
  const port = await allocateFreePort();
  const proc = Bun.spawn(
    ["bun", CLI, fixtureDir, ...flags, "-p", String(port)],
    {
      cwd: ROOT,
      stdout: Bun.file("/dev/null"),
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/`);
      await res.arrayBuffer();
      return {
        base,
        pid: proc.pid,
        stop: async () => {
          proc.kill();
          await proc.exited;
        },
      };
    } catch {
      await Bun.sleep(25);
    }
  }

  proc.kill();
  const err = await new Response(proc.stderr).text();
  throw new Error(`server did not respond on port ${port}: ${err}`);
}

async function startServer(
  fixtureDir: string,
  flags: string[],
): Promise<RunningServer> {
  return flags.includes("-q") || flags.includes("--quiet")
    ? startQuietServer(fixtureDir, flags)
    : startLoggingServer(fixtureDir, flags);
}

function buildScenarios(): Scenario[] {
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
    { name: "etag-304", path: "/app.js" },
    { name: "html-root-logging", path: "/", server: [] },
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

async function measureOnce(
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

  const rssBeforeKb = await sampleRssKb(serverPid);
  const cpuBefore = await cpuSeconds(serverPid);
  const sampler = new RssSampler(serverPid, RSS_SAMPLE_INTERVAL_MS);
  sampler.start();
  const { latencies, errors, actualSeconds } = await measure(
    CONCURRENCY,
    durationS,
    fire,
  );
  const { maxKb: rssPeakKb } = await sampler.stop();
  const cpuAfter = await cpuSeconds(serverPid);
  const sorted = [...latencies].sort((a, b) => a - b);

  const cpuUsPerReq =
    cpuBefore !== null && cpuAfter !== null && latencies.length > 0
      ? ((cpuAfter - cpuBefore) * 1e6) / latencies.length
      : null;

  return {
    name: scenario.name,
    requests: latencies.length,
    errors,
    seconds: actualSeconds,
    reqPerSec: latencies.length / actualSeconds,
    cpuUsPerReq,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    rssBeforeKb,
    rssPeakKb,
    server: scenario.server ?? ["-q"],
  };
}

/** Middle element by req/s; for an even count, the lower of the two middles. */
function medianByReqPerSec(runs: ScenarioResult[]): ScenarioResult {
  const sorted = [...runs].sort((a, b) => a.reqPerSec - b.reqPerSec);
  // biome-ignore lint/style/noNonNullAssertion: runs is never empty
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

async function runScenario(
  base: string,
  scenario: Scenario,
  durationS: number,
  serverPid: number,
  runs: number,
): Promise<ScenarioResult> {
  const url = base + scenario.path;
  const fire = async () => {
    const t0 = performance.now();
    const res = await fetch(url, { headers: scenario.headers });
    await res.arrayBuffer();
    return performance.now() - t0;
  };

  await measure(CONCURRENCY, WARMUP_S, fire);

  const attempts: ScenarioResult[] = [];
  for (let i = 0; i < runs; i++) {
    attempts.push(await measureOnce(base, scenario, durationS, serverPid));
  }
  return medianByReqPerSec(attempts);
}

function fmtMb(kb: number | null): string {
  return kb === null ? "n/a" : (kb / 1024).toFixed(1);
}

function fmtMbDelta(beforeKb: number | null, peakKb: number | null): string {
  if (beforeKb === null || peakKb === null) return "n/a";
  const deltaMb = (peakKb - beforeKb) / 1024;
  return `${deltaMb >= 0 ? "+" : ""}${deltaMb.toFixed(1)}`;
}

function fmtCpu(us: number | null): string {
  return us === null ? "n/a" : us.toFixed(2);
}

// Below this absolute percent, a delta is noise rather than a real change.
const NOISE_PCT = 5;

function pctDelta(before: number, after: number): number | null {
  return before === 0 ? null : ((after - before) / before) * 100;
}

function fmtPctDelta(pct: number | null): string {
  if (pct === null) return "n/a";
  if (Math.abs(pct) < NOISE_PCT) return "~";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function fmtPctDeltaCell(
  before: number | null | undefined,
  after: number,
): string {
  if (before === null || before === undefined) return "n/a";
  return fmtPctDelta(pctDelta(before, after));
}

type Judgement = "improved" | "regressed" | "unchanged" | "n/a";

/** cpu µs/req when both runs have it, else req/s. Negative cpu/p99 delta is an improvement; positive req/s delta is. */
function judgeScenario(
  r: ScenarioResult,
  baseline: ScenarioResult | undefined,
): Judgement {
  if (!baseline) return "n/a";
  const cpuPct =
    r.cpuUsPerReq !== null && baseline.cpuUsPerReq !== null
      ? pctDelta(baseline.cpuUsPerReq, r.cpuUsPerReq)
      : null;
  const pct = cpuPct ?? pctDelta(baseline.reqPerSec, r.reqPerSec);
  const positiveIsGood = cpuPct === null;
  if (pct === null) return "n/a";
  if (Math.abs(pct) < NOISE_PCT) return "unchanged";
  const good = positiveIsGood ? pct > 0 : pct < 0;
  return good ? "improved" : "regressed";
}

function printTable(
  results: ScenarioResult[],
  baseline: Map<string, ScenarioResult> | null,
) {
  const headers = [
    "scenario",
    "req/s",
    "cpu µs/req",
    "p50 (ms)",
    "p99 (ms)",
    "requests",
    "errors",
    "rss peak (MB)",
    "rss Δ (MB)",
    ...(baseline ? ["Δ req/s", "Δ cpu", "Δ p99"] : []),
  ];
  const rows = results.map((r) => {
    const b = baseline?.get(r.name);
    return [
      r.name,
      r.reqPerSec.toFixed(0),
      fmtCpu(r.cpuUsPerReq),
      r.p50.toFixed(2),
      r.p99.toFixed(2),
      String(r.requests),
      String(r.errors),
      fmtMb(r.rssPeakKb),
      fmtMbDelta(r.rssBeforeKb, r.rssPeakKb),
      ...(baseline
        ? [
            fmtPctDeltaCell(b?.reqPerSec, r.reqPerSec),
            b?.cpuUsPerReq != null && r.cpuUsPerReq !== null
              ? fmtPctDeltaCell(b.cpuUsPerReq, r.cpuUsPerReq)
              : "n/a",
            fmtPctDeltaCell(b?.p99, r.p99),
          ]
        : []),
    ];
  });

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );

  const formatRow = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");

  console.log(formatRow(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(formatRow(row));

  if (baseline) {
    const counts = { improved: 0, regressed: 0, unchanged: 0 };
    for (const r of results) {
      const j = judgeScenario(r, baseline.get(r.name));
      if (j !== "n/a") counts[j]++;
    }
    console.log(
      `${counts.improved} improved, ${counts.regressed} regressed, ${counts.unchanged} unchanged (threshold ${NOISE_PCT}%)`,
    );
  }
}

/** Groups scenarios by their (JSON-stringified) server flags, in first-seen order. */
function groupByServerFlags(scenarios: Scenario[]): Map<string, Scenario[]> {
  const groups = new Map<string, Scenario[]>();
  for (const s of scenarios) {
    const key = JSON.stringify(s.server ?? ["-q"]);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  return groups;
}

function gitSha(): string | null {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

function loadCompareBaseline(path: string): Map<string, ScenarioResult> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    results: ScenarioResult[];
  };
  return new Map(parsed.results.map((r) => [r.name, r]));
}

async function main() {
  const { filter, duration, runs, save, compare } = parseCliArgs(
    process.argv.slice(2),
  );
  const { dir: fixtureDir, jsCompressedBytes } = buildFixture();

  const scenarios = buildScenarios().filter(
    (s) => !filter || s.name.includes(filter),
  );

  if (scenarios.length === 0) {
    console.error(`No scenarios match --filter "${filter}"`);
    process.exit(1);
  }

  const compareBaseline = compare ? loadCompareBaseline(compare) : null;

  const results: ScenarioResult[] = [];
  let baselineRssKb: number | null = null;
  let finalRssKb: number | null = null;
  let usedNonQuiet = false;

  try {
    for (const [key, group] of groupByServerFlags(scenarios)) {
      const flags = JSON.parse(key) as string[];
      if (!flags.includes("-q") && !flags.includes("--quiet"))
        usedNonQuiet = true;

      const server = await startServer(fixtureDir, flags);
      try {
        if (baselineRssKb === null)
          baselineRssKb = await sampleRssKb(server.pid);

        for (const scenario of group) {
          if (scenario.name === "etag-304" && !scenario.headers) {
            const probe = await fetch(`${server.base}/app.js`);
            await probe.arrayBuffer();
            scenario.headers = {
              "If-None-Match": probe.headers.get("ETag") ?? "",
            };
          }
          console.log(`Running ${scenario.name}...`);
          results.push(
            await runScenario(
              server.base,
              scenario,
              duration,
              server.pid,
              runs,
            ),
          );
        }

        finalRssKb = await sampleRssKb(server.pid);
      } finally {
        await server.stop();
      }
    }

    console.log();
    printTable(results, compareBaseline);
    console.log();
    console.log(
      `rss baseline: ${fmtMb(baselineRssKb)} MB, final: ${fmtMb(finalRssKb)} MB, growth: ${fmtMbDelta(baselineRssKb, finalRssKb)} MB`,
    );
    if (usedNonQuiet) {
      console.log(
        "note: non-quiet scenarios' stdout is discarded to /dev/null, so their cpu µs/req is a lower bound on real terminal logging cost.",
      );
    }

    const output = {
      date: new Date().toISOString(),
      bunVersion: Bun.version,
      cpu: cpus()[0]?.model ?? null,
      gitSha: gitSha(),
      concurrency: CONCURRENCY,
      warmupS: WARMUP_S,
      durationS: duration,
      runs,
      fixtureCompressedBytes: jsCompressedBytes,
      baselineRssKb,
      finalRssKb,
      results,
    };

    if (save) {
      writeFileSync(save, `${JSON.stringify(output, null, 2)}\n`);
    }
    console.log(`bench-json: ${JSON.stringify(output)}`);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

await main();
