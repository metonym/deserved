import {
  ASCII_GLYPHS,
  formatDuration,
  type Look,
  readyLines,
  UNICODE_GLYPHS,
  wantsAscii,
  wantsRedraw,
} from "./live";
import {
  closingLine,
  createPaint,
  isAgent,
  MEASURE,
  PLAIN,
  SEPARATOR,
  wantsColor,
} from "./terminal";

type Env = Readonly<Record<string, string | undefined>>;

// Color only for a person at a terminal: piped output (CI logs, `| tee`),
// NO_COLOR (no-color.org), TERM=dumb and a coding agent all get plain
// text, and FORCE_COLOR colors a pipe.
function lookFor(
  terminal: boolean,
  env: Env,
  columns: number | undefined,
): Look {
  return {
    paint: wantsColor(undefined, terminal, env, isAgent(env))
      ? createPaint()
      : PLAIN,
    glyphs: wantsAscii(env) ? ASCII_GLYPHS : UNICODE_GLYPHS,
    columns: columns || MEASURE,
  };
}

// invariant: the one read of the environment, for NO_COLOR, FORCE_COLOR,
// TERM, the locale and the coding agent's variables.
const env = process.env;
const terminal = process.stdout.isTTY === true;
const look = lookFor(terminal, env, process.stdout.columns);

// Only on a terminal a person reads does it write the escape code that
// erases the ^C a terminal echoes: an agent's and TERM=dumb get none.
export const erasesEcho: boolean = wantsRedraw(terminal, env, isAgent(env));
const { paint, glyphs } = look;

// C0 and C1 controls, since either can start a terminal escape (ESC, CSI).
const CONTROL_CHARS = /\p{Cc}/gu;
// A pre-check, so a clean path, the common case, skips the replace.
const HAS_CONTROL = /\p{Cc}/u;

function sanitizeForLog(s: string): string {
  return HAS_CONTROL.test(s) ? s.replace(CONTROL_CHARS, "") : s;
}

const ICON_OK = paint.good(glyphs.done);
const ICON_REDIRECT = paint.warn(glyphs.pending);
const ICON_ERR = paint.bad(glyphs.failed);

// Lines queue here and flush once per tick, at the end of the current
// microtask queue, because a console.log/write per request costs a syscall
// each, which adds up under load.
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
): void {
  if (quiet) return;
  const icon = status < 300 ? ICON_OK : status < 400 ? ICON_REDIRECT : ICON_ERR;
  pendingLines.push(
    `${icon} ${paint.dim(method)} ${status} ${sanitizeForLog(path)}`,
  );
  scheduleFlush();
}

type Banner = {
  url: string;
  root: string;
  flags: readonly string[];
  tookMs: number;
  networkUrl?: string | undefined;
  /** The default port, when it was taken and the server hopped past it. */
  taken?: number | undefined;
};

// The address first, so it reads and copies whole; what's served and how
// under it, dim, since a person reads it once.
function bannerLines(banner: Banner, shown: Look = look): string[] {
  const { paint: p } = shown;
  const served = [`serving ${banner.root}`, ...banner.flags].join(" ");
  return [
    ...readyLines(shown, { address: banner.url, tookMs: banner.tookMs }),
    `  ${p.dim(banner.taken === undefined ? served : `${served}${SEPARATOR}port ${banner.taken} was taken`)}`,
    ...(banner.networkUrl === undefined
      ? []
      : [`  ${p.dim("on your network at")} ${p.bold(banner.networkUrl)}`]),
  ];
}

export function logBanner(banner: Banner): void {
  console.log(bannerLines(banner).join("\n"));
}

// A stopped server leaves a record, so the scrollback says it ended.
export function logStopped(upMs: number): void {
  console.log(
    closingLine(paint, "Stopped", `served for ${formatDuration(upMs)}`),
  );
}

export function logReload(quiet: boolean, kind: "css" | "reload"): void {
  if (quiet) return;
  console.log(`${paint.warn("*")} ${kind}`);
}
