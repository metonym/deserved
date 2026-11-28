// Output that moves while a tool works: a task list, a status line
// pinned under a log, the ready and waiting lines, and Ctrl-C handled
// as a result. Each component renders its data to lines in a pure
// function and a small driver writes them, so the lines are tested
// without a terminal. Like terminal.ts, a package carries an identical
// copy, beside its copy of terminal.ts, and it runs on Node as on Bun.
import {
  aligned,
  cursorHidden,
  fitWidth,
  type Glyphs,
  hideCursor,
  isDumb,
  type KeyHint,
  keyHints,
  markOf,
  MEASURE,
  type Paint,
  plural,
  SEPARATOR,
  showCursor,
  textWidth,
  truncateWords,
} from "./terminal.ts";

export {
  ASCII_GLYPHS,
  type Glyphs,
  type KeyHint,
  keyHints,
  UNICODE_GLYPHS,
  wantsAscii,
} from "./terminal.ts";

type Env = Readonly<Record<string, string | undefined>>;

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

/** A key a person can press, and what it does: terminal.ts's KeyHint. */
export type Key = KeyHint;

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

const finished = (task: Task) =>
  task.status === "done" ||
  task.status === "failed" ||
  task.status === "skipped";

const BAR_WIDTH = 20;

// Done and to-do differ in shape as well as color, so the bar reads
// without color too; the count says it in words.
/**
 * Renders how far a task list is as a bar and
 * a count: `━━━━━━━━──────────── 4 of 10 benchmarks · 1 failed`.
 */
export function renderTaskBar(
  tasks: readonly Task[],
  look: Look,
  noun = "task",
): string {
  const { paint, glyphs } = look;
  const total = tasks.length;
  const ended = tasks.filter(finished).length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const filled =
    total === 0 ? BAR_WIDTH : Math.round((ended / total) * BAR_WIDTH);
  const bar =
    paint.good(markOf(glyphs, "barDone").repeat(filled)) +
    paint.dim(markOf(glyphs, "barTodo").repeat(BAR_WIDTH - filled));
  const count = `${ended} of ${plural(total, noun)}`;
  const failures =
    failed === 0 ? "" : paint.dim(`${SEPARATOR}${failed} failed`);
  return cutLine(`${bar}  ${count}${failures}`, look.columns);
}

/** What a live frame of a task list holds besides its tasks. */
export type FrameOptions = {
  /**
   * The terminal's height: a list taller than it shows a window around
   * the tasks still running, and how many more are above and below.
   */
  rows?: number;
  /** Draws renderTaskBar under the tasks. */
  bar?: boolean;
  /** What the bar counts. @default "task" */
  noun?: string;
};

// The window starts at the first task still to end, since a queue runs
// in order, and the ones above have their record to come; a frame never
// fills the terminal's last row, where the cursor rests.
function windowOf(
  tasks: readonly Task[],
  room: number,
): { start: number; end: number } {
  const count = tasks.length;
  if (count <= room) return { start: 0, end: count };
  const at = tasks.findIndex((t) => !finished(t));
  const first = at === -1 ? count : at;
  const one = Math.max(1, room - 1);
  if (first < one) return { start: 0, end: one };
  if (first >= count - one) return { start: count - one, end: count };
  return { start: first, end: first + Math.max(1, room - 2) };
}

/**
 * Renders a task list's live frame: renderTasks, windowed to fit `rows`,
 * with the bar under it when asked.
 */
export function renderTaskFrame(
  tasks: readonly Task[],
  look: Look,
  moment: Moment,
  options: FrameOptions = {},
): string[] {
  const { paint, glyphs } = look;
  const lines = renderTasks(tasks, look, moment);
  const bar =
    options.bar === true ? [renderTaskBar(tasks, look, options.noun)] : [];
  if (options.rows === undefined) return [...lines, ...bar];
  const room = Math.max(1, options.rows - 1 - bar.length);
  const { start, end } = windowOf(tasks, room);
  const more = (mark: string, n: number) =>
    n > 0 ? [paint.dim(`${mark} ${n} more`)] : [];
  return [
    ...more(markOf(glyphs, "up"), start),
    ...lines.slice(start, end),
    ...more(markOf(glyphs, "down"), tasks.length - end),
    ...bar,
  ];
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
      frame((shown ? "" : hideCursor()) + redraw(lines, next));
      shown = true;
      lines = next;
    },
    above(text) {
      frame(erase(lines.length) + text + lines.map((l) => `${l}\n`).join(""));
    },
    replace(text) {
      frame(erase(lines.length) + text + (shown ? showCursor() : ""));
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
  /**
   * The terminal's height now, read at every frame: a task list taller
   * than it shows a window. Without it, nothing is windowed.
   */
  rows?: () => number | undefined;
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
  /**
   * Erases the list and leaves no record, for a run whose report, on
   * stdout, is the record; returns the tasks. Piped, the lines already
   * written stay, and no more are.
   */
  clear: () => readonly Task[];
};

/** What a task list takes besides where it writes. */
export type TaskListOptions = LiveOptions & {
  /** What it counts, in the closing line and the bar. @default "task" */
  noun?: string;
  /** Draws done of total as a bar under the live list. */
  bar?: boolean;
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
  options: TaskListOptions,
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
        const rows = options.rows?.();
        region.draw(
          renderTaskFrame(
            tasks,
            lookOf(options),
            { nowMs: nowMs(), frame: state.frame },
            {
              ...(rows !== undefined && rows > 0 && { rows }),
              ...(options.bar === true && { bar: true }),
              ...(options.noun !== undefined && { noun: options.noun }),
            },
          ),
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
  const settle = (stopped: boolean, record = true) => {
    if (state.settled) return tasks;
    state.settled = true;
    clearInterval(timer);
    if (stopped) tasks = stopTasks(tasks);
    if (!record) {
      if (options.redraw) region.replace("");
      return tasks;
    }
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
    clear: () => settle(false, false),
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
  // The seconds are what moves, so a narrow terminal shortens the text
  // first, and loses them only when the text would have no room left.
  const lead = `${spinner} `;
  const room = look.columns - textWidth(lead) - textWidth(seconds);
  if (textWidth(text) <= room) return `${lead}${text}${seconds}`;
  if (room >= MIN_TEXT) return `${lead}${cutLine(text, room)}${seconds}`;
  return cutLine(`${lead}${text}`, look.columns);
}

const MIN_TEXT = 8;

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
  keys?: readonly KeyHint[];
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
  keys: readonly KeyHint[] = [],
): string {
  const { paint, glyphs } = look;
  const where = watching === undefined ? "" : ` in ${watching}`;
  const hints = keys.length === 0 ? "" : `${SEPARATOR}${keyHints(paint, keys)}`;
  return `${paint.dim(glyphs.pending)} Waiting for changes${where}${hints}`;
}

/** The exit code of a run stopped by Ctrl-C: 128 plus SIGINT's 2. */
export const EXIT_INTERRUPTED = 130;
/** The exit code of a run stopped by SIGTERM: 128 plus its 15. */
export const EXIT_TERMINATED = 143;
const ERASE_ECHO = "\r\x1b[2K";

/** A signal that stops a run: Ctrl-C's, or a supervisor's SIGTERM. */
export type StopSignal = "SIGINT" | "SIGTERM";

/** The exit code for a run `signal` stopped: 128 plus its number. */
export const exitCodeOf = (signal: StopSignal): number =>
  signal === "SIGINT" ? EXIT_INTERRUPTED : EXIT_TERMINATED;

/** The process, or what a test passes for it. */
export type SignalTarget = {
  on: (event: StopSignal | "exit", listener: () => void) => unknown;
  off: (event: StopSignal | "exit", listener: () => void) => unknown;
  exit: (code: number) => void;
};

/**
 * What to do with the `^C` a terminal echoes where the cursor rests:
 * erase it, end its line so what prints next starts on its own, or leave
 * it, as in a pipe, where there is none.
 */
export type Echo = "erase" | "newline" | "keep";

/** What `handleInterrupt` restores and calls. */
export type InterruptOptions = {
  process: SignalTarget;
  /** Writes to the terminal the live output is on. */
  write: (text: string) => void;
  /**
   * Whether `write` goes to a terminal, so the restoring codes are safe;
   * pass `wantsRedraw`'s answer.
   */
  terminal: boolean;
  /**
   * What to do with Ctrl-C's `^C`: `erase` on a terminal that redraws;
   * `newline` on one that doesn't, as for a coding agent or TERM=dumb,
   * and on one a child process shares, whose line an erase would clear;
   * `keep` in a pipe.
   * @default "erase" when `terminal`, else "keep"
   */
  echo?: Echo;
  /**
   * Whether it exits once `onStop` ends. Without, `stopped` resolves
   * instead, and the caller prints the partial result and returns
   * `exitCodeOf` the signal; a second Ctrl-C still exits at once, unless
   * `secondExit` is false.
   * @default true
   */
  exit?: boolean;
  /**
   * Whether a second Ctrl-C or SIGTERM exits at once. Without, it calls
   * `onQuit`, restores the terminal, sets `forced` and resolves `stopped`
   * if `onStop` hasn't ended, and the caller exits, at once, with
   * `exitCodeOf(forced)`; a signal after it does nothing.
   * @default true
   */
  secondExit?: boolean;
  /** stdin, whose raw mode is undone on every exit, if it's on. */
  input?: {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?: (raw: boolean) => unknown;
  };
  /**
   * Prints the partial result, once the work has stopped; the process
   * exits when it resolves.
   */
  onStop?: (signal: StopSignal) => void | Promise<void>;
  /** Prints a last line when a second Ctrl-C quits before `onStop` ends. */
  onQuit?: () => void;
};

/** A run that Ctrl-C stops. */
export type Interrupt = {
  /** Aborted at the first Ctrl-C, so the work stops. */
  readonly signal: AbortSignal;
  /** The signal that stopped the run, from the moment it arrived. */
  readonly stoppedBy: StopSignal | undefined;
  /**
   * Resolves with the signal once `onStop` has ended, or, when
   * `secondExit` is false, at a second signal, whichever comes first.
   */
  readonly stopped: Promise<StopSignal>;
  /** The second signal, which asks to quit at once, from its arrival. */
  readonly forced: StopSignal | undefined;
  /** Acts as Ctrl-C, for a program in raw mode, which reads it as a key. */
  interrupt: () => void;
  /**
   * Call when the work ends, before printing its result: waits a turn of
   * the event loop, so a signal already sent is handled, then resolves
   * the signal that stopped the run, or removes the handlers and
   * resolves undefined. The Ctrl-C that stops a child process, a build
   * or a browser, reaches this one too, and the child's failure can
   * come back first.
   */
  settle: () => Promise<StopSignal | undefined>;
  /** Removes the handlers, once the run is done. */
  dispose: () => void;
};

/**
 * Handles Ctrl-C and SIGTERM: the first stops the work and prints what
 * finished, then exits 130 (143 for SIGTERM); a second exits at once.
 * On every exit, a crash included, it shows the cursor if a component
 * hid it, and undoes raw mode if it's on.
 */
export function handleInterrupt(options: InterruptOptions): Interrupt {
  const { process: target } = options;
  const controller = new AbortController();
  const exits = options.exit ?? true;
  const secondExits = options.secondExit ?? true;
  const echo = options.echo ?? (options.terminal ? "erase" : "keep");
  const state: {
    restored: boolean;
    stoppedBy: StopSignal | undefined;
    forced: StopSignal | undefined;
  } = { restored: false, stoppedBy: undefined, forced: undefined };
  let markStopped: (signal: StopSignal) => void = () => {};
  const stopped = new Promise<StopSignal>((resolve) => {
    markStopped = resolve;
  });
  const restore = () => {
    if (state.restored) return;
    state.restored = true;
    const input = options.input;
    if (input?.isTTY === true && input.isRaw !== false) {
      input.setRawMode?.(false);
    }
    if (options.terminal && cursorHidden()) options.write(showCursor());
  };
  const quit = (code: number) => {
    restore();
    target.exit(code);
  };
  const stop = (signal: StopSignal, echoed: boolean) => {
    // The terminal echoes Ctrl-C as ^C where the cursor rests, the line
    // under a live region, and the record printed next would follow it.
    if (echoed) {
      if (echo === "erase") options.write(ERASE_ECHO);
      else if (echo === "newline") options.write("\n");
    }
    // Past the second, the caller is already exiting.
    if (!secondExits && state.forced !== undefined) return;
    if (state.stoppedBy !== undefined) {
      state.forced = signal;
      options.onQuit?.();
      if (secondExits) {
        quit(exitCodeOf(signal));
      } else {
        restore();
        markStopped(state.stoppedBy);
      }
      return;
    }
    state.stoppedBy = signal;
    controller.abort();
    const end = () => {
      restore();
      markStopped(signal);
      // Without secondExit, a forced quit is the caller's to make.
      if (exits && (secondExits || state.forced === undefined)) {
        target.exit(exitCodeOf(signal));
      }
    };
    // A failing onStop still exits with the signal's code, since the run
    // was stopped either way.
    void Promise.resolve()
      .then(() => options.onStop?.(signal))
      .then(end, end);
  };
  const onInt = () => stop("SIGINT", true);
  const onTerm = () => stop("SIGTERM", false);
  const dispose = () => {
    target.off("SIGINT", onInt);
    target.off("SIGTERM", onTerm);
    target.off("exit", restore);
  };
  target.on("SIGINT", onInt);
  target.on("SIGTERM", onTerm);
  target.on("exit", restore);
  return {
    signal: controller.signal,
    get stoppedBy() {
      return state.stoppedBy;
    },
    get forced() {
      return state.forced;
    },
    stopped,
    // A key read in raw mode has no echo to erase.
    interrupt: () => stop("SIGINT", false),
    settle: () =>
      new Promise((resolve) => {
        setImmediate(() => {
          if (state.stoppedBy === undefined) dispose();
          resolve(state.stoppedBy);
        });
      }),
    dispose,
  };
}
