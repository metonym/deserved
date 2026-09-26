// Plain text when piped (CI logs, `| tee`) or when NO_COLOR is set
// (https://no-color.org).
export function shouldColor(
  isTTY: boolean | undefined,
  env: Record<string, string | undefined>,
): boolean {
  return isTTY === true && !env.NO_COLOR;
}

const useColor = shouldColor(process.stdout.isTTY, process.env);
const ansi = (code: number) => (useColor ? `\x1b[${code}m` : "");

const c = {
  reset: ansi(0),
  dim: ansi(2),
  green: ansi(32),
  yellow: ansi(33),
  red: ansi(31),
  cyan: ansi(36),
  bold: ansi(1),
} as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control chars from logs
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: cheap pre-check so the common clean-path case skips replace()
const HAS_CONTROL = /[\x00-\x1f\x7f]/;

function sanitizeForLog(s: string): string {
  return HAS_CONTROL.test(s) ? s.replace(CONTROL_CHARS, "") : s;
}

const ICON_OK = `${c.green}✓${c.reset}`;
const ICON_REDIRECT = `${c.yellow}○${c.reset}`;
const ICON_ERR = `${c.red}✗${c.reset}`;
const DIM = c.dim;
const RESET = c.reset;

// Collapses many synchronous per-request writes into one per tick: a
// console.log/write per request costs a syscall each, which adds up under
// load. Lines queue here and flush once, at the end of the current
// microtask queue.
let pendingLines: string[] = [];

function scheduleFlush(): void {
  if (pendingLines.length === 1) queueMicrotask(flushLogs);
}

export function flushLogs(): void {
  if (pendingLines.length === 0) return;
  const out = pendingLines.join("\n");
  pendingLines = [];
  process.stdout.write(`${out}\n`);
}

export function logRequest(
  method: string,
  status: number,
  path: string,
  quiet: boolean,
) {
  if (quiet) return;
  const icon = status < 300 ? ICON_OK : status < 400 ? ICON_REDIRECT : ICON_ERR;
  pendingLines.push(
    `${icon} ${DIM}${method}${RESET} ${status} ${sanitizeForLog(path)}`,
  );
  scheduleFlush();
}

export function logInfo(msg: string, quiet = false) {
  if (quiet) return;
  console.log(`${c.cyan}│${c.reset} ${msg}`);
}

export function logBanner(
  url: string,
  root: string,
  flags: string[],
  networkUrl?: string,
) {
  console.log();
  console.log(
    `  ${c.bold}deserved${c.reset} ${c.dim}serving${c.reset} ${root}`,
  );
  console.log(`  ${c.green}->${c.reset}  ${c.cyan}${url}${c.reset}`);
  if (networkUrl) {
    console.log(`  ${c.green}->${c.reset}  ${c.cyan}${networkUrl}${c.reset}`);
  }
  if (flags.length) {
    console.log(`  ${c.dim}${flags.join("  ")}${c.reset}`);
  }
  console.log();
}

export function logReload(quiet: boolean, kind: "css" | "reload") {
  if (quiet) return;
  console.log(`${c.yellow}*${c.reset} ${kind}`);
}
