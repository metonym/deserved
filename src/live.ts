// Output that moves while a tool works: a task list, a status line
// pinned under a log, the ready and waiting lines, and Ctrl-C handled
// as a result. Each component renders its data to lines in a pure
// function and a small driver writes them, so the lines are tested
// without a terminal. Like terminal.ts, a package carries an identical
// copy, beside its copy of terminal.ts, and it runs on Node as on Bun.
import {
  aligned,
  fitWidth,
  isDumb,
  MEASURE,
  type Paint,
  plural,
  SEPARATOR,
  textWidth,
  truncateWords,
} from "./terminal.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The marks a live component draws, one per state. */
export type Glyphs = {
  done: string;
  failed: string;
  skipped: string;
  pending: string;
  spinner: readonly string[];
};

/** The marks for a terminal whose locale is UTF-8. */
export const UNICODE_GLYPHS: Glyphs = {
  done: "✓",
  failed: "✗",
  skipped: "-",
  pending: "○",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

// One frame for running, since an ASCII spinner's `-` would read as
// skipped for a frame; the seconds still move past one.
/** The same marks in ASCII, each its own shape, so none needs color. */
export const ASCII_GLYPHS: Glyphs = {
  done: "+",
  failed: "x",
  skipped: "-",
  pending: ".",
  spinner: [">"],
};

// An unset locale is taken as UTF-8, every current system's default,
// since CI and a GUI's shell often set none; one that names C or
// another charset gets ASCII, as TERM=dumb does.
/**
 * Whether to draw ASCII_GLYPHS: under TERM=dumb, or a locale that
 * isn't UTF-8.
 */
export function wantsAscii(env: Env): boolean {
  if (isDumb(env)) return true;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return locale !== undefined && locale !== "" && !/utf-?8/i.test(locale);
}

// A coding agent and a log file read every frame a redraw writes, and
// TERM=dumb knows no cursor movement, so each gets plain lines instead.
/** Whether a live view redraws in place, from where its stream goes. */
export const wantsRedraw = (
  terminal: boolean,
  env: Env,
  agent: boolean,
): boolean => terminal && !agent && !isDumb(env);

// A line that appears and vanishes within 300 ms reads as a glitch;
// 10 frames a second looks alive and costs little; and seconds counted
// before one would only flicker.
/**
 * When live output appears, how often it redraws, and when it
 * counts seconds.
 */
export const TIMING = {
  showAfterMs: 300,
  frameMs: 100,
  countAfterMs: 1000,
} as const;

/**
 * Formats a finished step's time at three significant figures: `812 ms`,
 * `1.23 s`, `2 min 5 s`.
 */
export function formatDuration(ms: number): string {
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`;
  const seconds = (ms / 1000).toPrecision(3);
  if (Number(seconds) < 100) return `${seconds} s`;
  return minutes(Math.round(ms / 1000));
}

const minutes = (seconds: number) =>
  `${Math.floor(seconds / 60)} min ${seconds % 60} s`;

// Whole seconds while it runs, since a tenth that changes every frame
// is motion that says nothing.
const formatElapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 100 ? `${seconds} s` : minutes(seconds);
};

/** What a component draws with: the colors, the glyphs and the width. */
export type Look = { paint: Paint; glyphs: Glyphs; columns: number };

/** A key a person can press, and what it does, for a hint line. */
export type Key = { key: string; does: string };

/** Renders keys as one faint hint: `o open · q quit`. */
export const keyHints = (paint: Paint, keys: readonly Key[]): string =>
  paint.faint(keys.map((k) => `${k.key} ${k.does}`).join(SEPARATOR));

/** One task of a task list, in one of its five states. */
export type Task =
  | { name: string; status: "pending" }
  | { name: string; status: "running"; startedMs: number; detail?: string }
  | {
      name: string;
      status: "done" | "failed";
      tookMs: number;
      detail?: string;
    }
  | { name: string; status: "skipped"; detail?: string };

/** The moment a frame shows: the clock, and the spinner's frame. */
export type Moment = { nowMs: number; frame: number };

const asIs = (text: string) => text;

type Cell = readonly [text: string, paint: (text: string) => string];

// The glyph and the name are one cell, a space apart, since a second
// column's gap would set the name adrift from its mark.
const label = (
  glyph: string,
  paintGlyph: (text: string) => string,
  name: string,
  paintName: (text: string) => string,
): Cell => [
  `${glyph} ${name}`,
  () => `${paintGlyph(glyph)} ${paintName(name)}`,
];

// A label, a time and a detail, so the times line up in a column; a
// state reads from its glyph's shape, and its color repeats it.
function taskCells(task: Task, look: Look, moment?: Moment): Cell[] {
  const { paint, glyphs } = look;
  switch (task.status) {
    case "pending":
      return [label(glyphs.pending, paint.dim, task.name, paint.dim)];
    case "running": {
      const ms = moment === undefined ? 0 : moment.nowMs - task.startedMs;
      const spinner = glyphs.spinner;
      const frame = spinner[(moment?.frame ?? 0) % spinner.length] ?? "";
      return [
        label(frame, asIs, task.name, asIs),
        [ms >= TIMING.countAfterMs ? formatElapsed(ms) : "", paint.dim],
        [task.detail ?? "", paint.dim],
      ];
    }
    case "done":
      return [
        label(glyphs.done, paint.good, task.name, asIs),
        [formatDuration(task.tookMs), paint.dim],
        [task.detail ?? "", paint.dim],
      ];
    case "failed":
      return [
        label(glyphs.failed, paint.bad, task.name, asIs),
        [formatDuration(task.tookMs), paint.dim],
        [task.detail ?? "", asIs],
      ];
    case "skipped":
      return [
        label(glyphs.skipped, paint.dim, task.name, paint.dim),
        ["", asIs],
        [task.detail ?? "skipped", paint.dim],
      ];
    default:
      return task satisfies never;
  }
}

const TIME_COLUMN = 1;
const DETAIL_COLUMN = 2;

// A line wider than the terminal wraps, and a redraw that counts lines
// then erases the wrong ones, so a frame's detail shortens at a word,
// and anything still too wide is cut.
function fitCells(rows: readonly Cell[][], columns: number): string[] {
  const plainLines = aligned(
    rows.map((row) => row.map(([text]) => text)),
    [TIME_COLUMN],
    asIs,
    "",
  );
  const fitted = rows.map((row, i) => {
    const over = textWidth(plainLines[i] ?? "") - columns;
    const detail = row[DETAIL_COLUMN];
    if (over <= 0 || detail === undefined) return row;
    const room = textWidth(detail[0]) - over;
    const shorter = room >= 4 ? truncateWords(detail[0], room) : "";
    return row.with(DETAIL_COLUMN, [shorter, detail[1]]);
  });
  return aligned(
    fitted.map((row) => row.map(([text, paint]) => paint(text))),
    [TIME_COLUMN],
    asIs,
    "",
  ).map((line) => cutLine(line, columns));
}

// eslint-disable-next-line no-control-regex -- escape codes are what it skips
const SGR = /^\x1b\[[0-9;]*m/;
// eslint-disable-next-line no-control-regex -- escape codes are what it keeps
const TRAILING_SPACE = / +((?:\x1b\[[0-9;]*m)*)$/;

function cutLine(line: string, columns: number): string {
  if (textWidth(line) <= columns) return line;
  let out = "";
  let seen = 0;
  let i = 0;
  while (i < line.length) {
    const code = SGR.exec(line.slice(i));
    if (code) {
      out += code[0];
      i += code[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i) ?? 32);
    if (seen + textWidth(ch) > columns - 1) break;
    out += ch;
    seen += textWidth(ch);
    i += ch.length;
  }
  // The ellipsis follows the last word, not a column's gap; and a cut
  // can fall inside a color, which would bleed into what follows.
  const cut = out.replace(TRAILING_SPACE, "$1");
  return line.includes("\x1b") ? `${cut}…\x1b[0m` : `${cut}…`;
}

/**
 * Renders a task list as aligned lines; with a moment, the live frame,
 * and without one, the static record that stays in the scrollback.
 */
export function renderTasks(
  tasks: readonly Task[],
  look: Look,
  moment?: Moment,
): string[] {
  return fitCells(
    tasks.map((task) => taskCells(task, look, moment)),
    look.columns,
  );
}

// Unaligned, since piped lines print one at a time as tasks finish, and
// a program or grep reads each alone.
/** Renders one finished task as a line for a pipe: `✓ lint · 812 ms`. */
export function renderTaskLine(task: Task, look: Look): string {
  return taskCells(task, look)
    .flatMap(([text, paint]) => (text === "" ? [] : [paint(text)]))
    .join(SEPARATOR);
}

const markLine = (mark: string, what: string, paint: Paint, detail: string) =>
  `${mark} ${what}${paint.dim(`${SEPARATOR}${detail}`)}`;

/**
 * Renders the closing line: what ran, what failed or was skipped, and
 * how long, or, when it was stopped, how far it got.
 */
export function renderTaskSummary(
  tasks: readonly Task[],
  tookMs: number,
  look: Look,
  options: { noun?: string; stopped?: boolean } = {},
): string {
  const { paint, glyphs } = look;
  const noun = options.noun ?? "task";
  const took = formatDuration(tookMs);
  const total = tasks.length;
  const count = (status: Task["status"]) =>
    tasks.filter((t) => t.status === status).length;
  const failed = tasks.filter((t) => t.status === "failed");
  const bad = paint.bad(glyphs.failed);
  if (options.stopped === true) {
    return markLine(
      bad,
      "Stopped",
      paint,
      `${count("done")} of ${plural(total, noun)} done${SEPARATOR}${took}`,
    );
  }
  if (failed.length > 0) {
    const names = truncateWords(failed.map((t) => t.name).join(", "), 40);
    return markLine(
      bad,
      `${failed.length} of ${plural(total, noun)} failed: ${names}`,
      paint,
      took,
    );
  }
  const skipped = count("skipped");
  const ran = total - skipped;
  return markLine(
    paint.good(glyphs.done),
    skipped === 0
      ? `Ran ${plural(total, noun)}`
      : `Ran ${ran} of ${plural(total, noun)}`,
    paint,
    skipped === 0 ? took : `${skipped} skipped${SEPARATOR}${took}`,
  );
}

// A stopped run's record keeps every task, so it shows what never
// finished as well as what did.
/** Marks each running task stopped and each pending one not started. */
export const stopTasks = (tasks: readonly Task[]): Task[] =>
  tasks.map((task) => {
    if (task.status === "running") {
      return { name: task.name, status: "skipped", detail: "stopped" };
    }
    if (task.status === "pending") {
      return { name: task.name, status: "skipped", detail: "not started" };
    }
    return task;
  });

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
// Mode 2026 holds a frame until it's whole, so a terminal that knows it
// never shows half of one; the rest ignore it.
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/**
 * Returns the codes that erase a drawn region, `lineCount` lines above
 * the cursor.
 */
export const erase = (lineCount: number): string =>
  lineCount === 0 ? "" : `\x1b[${lineCount}A\r\x1b[J`;

// The cursor rests at the start of the line under the region, so
// anything else written, a log line or a crash's trace, starts on a line
// of its own.
/**
 * Returns the codes that turn the region drawn as `previous` into
 * `next`, rewriting only the lines that changed, so a screen reader
 * hears each line once.
 */
export function redraw(
  previous: readonly string[],
  next: readonly string[],
): string {
  if (previous.length !== next.length) {
    return erase(previous.length) + next.map((line) => `${line}\n`).join("");
  }
  let codes = "";
  for (const [i, line] of next.entries()) {
    if (line === previous[i]) continue;
    const up = next.length - i;
    codes += `\x1b[${up}A\r\x1b[2K${line}\r\x1b[${up}B`;
  }
  return codes;
}

type Region = {
  readonly shown: boolean;
  draw: (lines: readonly string[]) => void;
  above: (text: string) => void;
  replace: (text: string) => void;
};

function createRegion(write: (text: string) => void): Region {
  let lines: readonly string[] = [];
  let shown = false;
  const frame = (codes: string) => {
    if (codes !== "") write(`${SYNC_START}${codes}${SYNC_END}`);
  };
  return {
    get shown() {
      return shown;
    },
    draw(next) {
      frame((shown ? "" : HIDE_CURSOR) + redraw(lines, next));
      shown = true;
      lines = next;
    },
    above(text) {
      frame(erase(lines.length) + text + lines.map((l) => `${l}\n`).join(""));
    },
    replace(text) {
      frame(erase(lines.length) + text + (shown ? SHOW_CURSOR : ""));
      lines = [];
      shown = false;
    },
  };
}

/** Where a live component writes, and how. */
export type LiveOptions = {
  write: (text: string) => void;
  /** Whether to redraw in place; `wantsRedraw` decides it. */
  redraw: boolean;
  paint: Paint;
  glyphs: Glyphs;
  nowMs: () => number;
  /** The terminal's width now, read at every frame so a resize fits. */
  columns?: () => number | undefined;
};

/** A task list a run updates as its tasks start and end. */
export type TaskList = {
  readonly tasks: readonly Task[];
  start: (name: string, detail?: string) => void;
  done: (name: string, detail?: string) => void;
  fail: (name: string, detail?: string) => void;
  skip: (name: string, detail?: string) => void;
  /**
   * Runs `work` as the task: done with the detail it returns, failed
   * with the message it throws; resolves whether it passed.
   */
  run: (name: string, work: () => Promise<string | void>) => Promise<boolean>;
  /** Leaves the record and the closing line, and returns the tasks. */
  finish: () => readonly Task[];
  /** Leaves the record of a stopped run, what finished and what didn't. */
  stop: () => readonly Task[];
};

const lookOf = (options: LiveOptions): Look => ({
  paint: options.paint,
  glyphs: options.glyphs,
  columns: Math.min(MEASURE, options.columns?.() || MEASURE),
});

/**
 * Creates a task list for tasks that run in parallel. On a terminal it
 * appears after 300 ms and redraws at most 10 times a second; otherwise
 * it writes one line per task as it finishes. Either way it ends in a
 * static record and a closing line.
 */
export function createTaskList(
  names: readonly string[],
  options: LiveOptions & { noun?: string },
): TaskList {
  const { write, nowMs } = options;
  const startMs = nowMs();
  let tasks: Task[] = names.map((name) => ({ name, status: "pending" }));
  const written = new Set<string>();
  const region = createRegion(write);
  const state = { frame: 0, settled: false };
  const timer = options.redraw
    ? setInterval(() => {
        if (!region.shown && nowMs() - startMs < TIMING.showAfterMs) return;
        state.frame++;
        region.draw(
          renderTasks(tasks, lookOf(options), {
            nowMs: nowMs(),
            frame: state.frame,
          }),
        );
      }, TIMING.frameMs)
    : undefined;
  timer?.unref();

  const set = (task: Task) => {
    const i = tasks.findIndex((t) => t.name === task.name);
    if (i === -1) throw new Error(`no task ${JSON.stringify(task.name)}`);
    if (state.settled) return;
    tasks = tasks.with(i, task);
    if (options.redraw || task.status === "running") return;
    written.add(task.name);
    write(`${renderTaskLine(task, lookOf(options))}\n`);
  };
  const tookMs = (name: string) => {
    const task = tasks.find((t) => t.name === name);
    return task?.status === "running" ? nowMs() - task.startedMs : 0;
  };
  const withDetail = (detail: string | undefined) =>
    detail === undefined ? {} : { detail };
  const settle = (stopped: boolean) => {
    if (state.settled) return tasks;
    state.settled = true;
    clearInterval(timer);
    if (stopped) tasks = stopTasks(tasks);
    const look = lookOf(options);
    const summary = renderTaskSummary(tasks, nowMs() - startMs, look, {
      stopped,
      ...(options.noun !== undefined && { noun: options.noun }),
    });
    if (options.redraw) {
      // The closing line wraps at a word, since it stays in the
      // scrollback whole, where a cut would lose what failed.
      const lines = [
        ...renderTasks(tasks, look),
        fitWidth(summary, look.columns),
      ];
      region.replace(lines.map((l) => `${l}\n`).join(""));
    } else {
      const rest = tasks.filter((t) => !written.has(t.name));
      for (const task of rest) write(`${renderTaskLine(task, look)}\n`);
      write(`${summary}\n`);
    }
    return tasks;
  };
  const end = (status: "done" | "failed") => (name: string, detail?: string) =>
    set({ name, status, tookMs: tookMs(name), ...withDetail(detail) });
  const list: TaskList = {
    get tasks() {
      return tasks;
    },
    start: (name, detail) =>
      set({
        name,
        status: "running",
        startedMs: nowMs(),
        ...withDetail(detail),
      }),
    done: end("done"),
    fail: end("failed"),
    skip: (name, detail) =>
      set({ name, status: "skipped", ...withDetail(detail) }),
    async run(name, work) {
      list.start(name);
      try {
        const detail = await work();
        list.done(name, typeof detail === "string" ? detail : undefined);
        return true;
      } catch (error) {
        list.fail(name, error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    finish: () => settle(false),
    stop: () => settle(true),
  };
  return list;
}

/** Renders a status line: `⠋ Building · 12 of 40 files · 3 s`. */
export function renderStatus(
  text: string,
  elapsedMs: number,
  frame: number,
  look: Look,
): string {
  const { paint, glyphs } = look;
  const spinner = glyphs.spinner[frame % glyphs.spinner.length] ?? "";
  const seconds =
    elapsedMs >= TIMING.countAfterMs
      ? paint.dim(`${SEPARATOR}${formatElapsed(elapsedMs)}`)
      : "";
  return cutLine(`${spinner} ${text}${seconds}`, look.columns);
}

/** A line pinned under streaming output, while the output prints above it. */
export type StatusLine = {
  /** Changes what the line says. */
  update: (text: string) => void;
  /** Prints a line of output above the status line. */
  log: (line: string) => void;
  /** Removes the status line, for output that follows in its place. */
  clear: () => void;
  /** Replaces the status line with a static one that stays. */
  settle: (line: string) => void;
};

/**
 * Creates a status line pinned under the output `log` prints. On a
 * terminal it appears after 300 ms and redraws at most 10 times a
 * second; otherwise only the log and the settled line are written.
 */
export function createStatusLine(
  text: string,
  options: LiveOptions,
): StatusLine {
  const { write, nowMs } = options;
  const startMs = nowMs();
  const region = createRegion(write);
  // Output that arrives between frames waits for the next one, so a
  // fast log redraws the status line 10 times a second, not per line.
  const queued: string[] = [];
  const state = { text, frame: 0, settled: false };
  const flush = () => queued.splice(0).join("");
  const timer = options.redraw
    ? setInterval(() => {
        const elapsedMs = nowMs() - startMs;
        if (!region.shown && elapsedMs < TIMING.showAfterMs) return;
        state.frame++;
        if (queued.length > 0) region.above(flush());
        region.draw([
          renderStatus(state.text, elapsedMs, state.frame, lookOf(options)),
        ]);
      }, TIMING.frameMs)
    : undefined;
  timer?.unref();
  const end = (line: string) => {
    if (state.settled) return;
    state.settled = true;
    clearInterval(timer);
    if (region.shown) region.replace(flush() + line);
    else write(flush() + line);
  };
  return {
    update(next) {
      state.text = next;
    },
    log(line) {
      if (state.settled || !region.shown) write(`${line}\n`);
      else queued.push(`${line}\n`);
    },
    clear: () => end(""),
    settle: (line) => end(`${line}\n`),
  };
}

/** What a server shows once it listens. */
export type Ready = {
  /** Where it listens, as `http://localhost:1776`. */
  address: string;
  /** How long it took to start. */
  tookMs?: number;
  /** The keys it reads; give none when stdin isn't a terminal. */
  keys?: readonly Key[];
};

// The address is bold and stands alone, so it reads first and copies
// whole; the keys are faint, since a person reads them once.
/** Renders a server's ready line, and its keys under it. */
export function readyLines(look: Look, ready: Ready): string[] {
  const { paint, glyphs } = look;
  const took =
    ready.tookMs === undefined
      ? ""
      : paint.dim(`${SEPARATOR}${formatDuration(ready.tookMs)}`);
  const keys = ready.keys ?? [];
  return [
    `${paint.good(glyphs.done)} Ready at ${paint.bold(ready.address)}${took}`,
    ...(keys.length === 0 ? [] : [`  ${keyHints(paint, keys)}`]),
  ];
}

// No spinner and no clock: a watch loop waits for minutes, and motion
// that long only distracts.
/**
 * Renders a watch loop's line
 * between runs: `○ Waiting for changes in src/`.
 */
export function waitingLine(
  look: Look,
  watching?: string,
  keys: readonly Key[] = [],
): string {
  const { paint, glyphs } = look;
  const where = watching === undefined ? "" : ` in ${watching}`;
  const hints = keys.length === 0 ? "" : `${SEPARATOR}${keyHints(paint, keys)}`;
  return `${paint.dim(glyphs.pending)} Waiting for changes${where}${hints}`;
}

/** The exit code of a run stopped by Ctrl-C: 128 plus SIGINT's 2. */
export const EXIT_INTERRUPTED = 130;
const EXIT_TERMINATED = 143;
const ERASE_ECHO = "\r\x1b[2K";

type Signal = "SIGINT" | "SIGTERM";

/** The process, or what a test passes for it. */
export type SignalTarget = {
  on: (event: Signal | "exit", listener: () => void) => unknown;
  off: (event: Signal | "exit", listener: () => void) => unknown;
  exit: (code: number) => void;
};

/** What `handleInterrupt` restores and calls. */
export type InterruptOptions = {
  process: SignalTarget;
  /** Writes to the terminal the live output is on. */
  write: (text: string) => void;
  /** Whether `write` goes to a terminal, so the restoring codes are safe. */
  terminal: boolean;
  /** stdin, whose raw mode is undone on every exit. */
  input?: { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };
  /**
   * Prints the partial result, once the work has stopped; the process
   * exits when it resolves.
   */
  onStop: (signal: Signal) => void | Promise<void>;
  /** Prints a last line when a second Ctrl-C quits before `onStop` ends. */
  onQuit?: () => void;
};

/** A run that Ctrl-C stops. */
export type Interrupt = {
  /** Aborted at the first Ctrl-C, so the work stops. */
  readonly signal: AbortSignal;
  /** Acts as Ctrl-C, for a program in raw mode, which reads it as a key. */
  interrupt: () => void;
  /** Removes the handlers, once the run is done. */
  dispose: () => void;
};

/**
 * Handles Ctrl-C and SIGTERM: the first stops the work and prints what
 * finished, then exits 130 (143 for SIGTERM); a second exits at once.
 * The cursor and raw mode are restored on every exit, a crash included.
 */
export function handleInterrupt(options: InterruptOptions): Interrupt {
  const { process: target } = options;
  const controller = new AbortController();
  const state = { restored: false, quitting: false };
  const restore = () => {
    if (state.restored) return;
    state.restored = true;
    if (options.input?.isTTY === true) options.input.setRawMode?.(false);
    if (options.terminal) options.write(SHOW_CURSOR);
  };
  const stop = (signal: Signal) => {
    const code = signal === "SIGINT" ? EXIT_INTERRUPTED : EXIT_TERMINATED;
    // The terminal echoes Ctrl-C as ^C where the cursor rests, the line
    // under a live region, and the record printed next would follow it.
    if (options.terminal) options.write(ERASE_ECHO);
    if (state.quitting) {
      options.onQuit?.();
      restore();
      target.exit(code);
      return;
    }
    state.quitting = true;
    controller.abort();
    const exit = () => {
      restore();
      target.exit(code);
    };
    // A failing onStop still exits with the signal's code, since the run
    // was stopped either way.
    void Promise.resolve()
      .then(() => options.onStop(signal))
      .then(exit, exit);
  };
  const onInt = () => stop("SIGINT");
  const onTerm = () => stop("SIGTERM");
  target.on("SIGINT", onInt);
  target.on("SIGTERM", onTerm);
  target.on("exit", restore);
  return {
    signal: controller.signal,
    interrupt: onInt,
    dispose() {
      target.off("SIGINT", onInt);
      target.off("SIGTERM", onTerm);
      target.off("exit", restore);
    },
  };
}
