// Terminal output shared by metonym's command-line tools: color, tables,
// trees, the closing line and the progress line. Each tool carries an
// identical copy, since a package here has no runtime dependencies; a
// change is made once and copied to all of them.

/**
 * Color for the human format on a terminal only: the agent format and
 * JSON are read by programs. Each color marks a verdict or recedes,
 * never decorates.
 */
export type Paint = {
  good: (text: string) => string;
  warn: (text: string) => string;
  bad: (text: string) => string;
  dim: (text: string) => string;
  bold: (text: string) => string;
  faint: (text: string) => string;
};

const asIs = (text: string) => text;

export const PLAIN: Paint = {
  good: asIs,
  warn: asIs,
  bad: asIs,
  dim: asIs,
  bold: asIs,
  faint: asIs,
};

// The 16 ANSI colors, never a fixed hex: each terminal theme defines
// its own green or gray, picked to read on its own background, light,
// dark or pink. The codes are written out, not asked of Bun.color, so
// a package that also runs on Node prints the same.
export function createPaint(): Paint {
  const wrap = (code: number) => (text: string) =>
    text === "" ? text : `\x1b[${code}m${text}\x1b[39m`;
  return {
    good: wrap(32),
    warn: wrap(33),
    bad: wrap(31),
    // Bright black, the gray every theme dims secondary text with.
    dim: wrap(90),
    // Bold is a weight, not a color: names and section heads.
    bold: (text) => (text === "" ? text : `\x1b[1m${text}\x1b[22m`),
    // Faint is the text color at lower intensity, so a table's header
    // recedes in every theme, even one whose gray is odd.
    faint: (text) => (text === "" ? text : `\x1b[2m${text}\x1b[22m`),
  };
}

// The person's explicit ask wins, because they know where the output
// goes: the flag, then NO_COLOR and FORCE_COLOR (no-color.org,
// force-color.org). Otherwise color only for a terminal that reads
// escape codes and no coding agent reads, since they're noise to
// a program.
export function wantsColor(
  forced: boolean | undefined,
  terminal: boolean,
  env: Readonly<Record<string, string | undefined>>,
  agent: boolean,
): boolean {
  if (forced !== undefined) return forced;
  if ((env.NO_COLOR ?? "") !== "") return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0";
  return terminal && !agent && !isDumb(env);
}

// TERM=dumb says the terminal knows no escape sequence: no color, and no
// carriage-return redraw, so a progress line would print every frame.
export const isDumb = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => env.TERM === "dumb";

// The variables a coding agent sets, one list so every tool agrees on
// what an agent is: `AGENT` and `CLAUDECODE`, which Bun reads;
// `AI_AGENT`, the cross-vendor name; and Codex's two. One that a shell
// sets without an agent, as Replit's REPL_ID, stays out.
export const AGENT_ENV = [
  "AGENT",
  "AI_AGENT",
  "CLAUDECODE",
  "CODEX_CI",
  "CODEX_THREAD_ID",
] as const;

// The first agent variable that's set, for the line saying why the
// output is the agent's. Empty or `0` is a person saying "not an agent"
// without unsetting it.
export const agentVariableOf = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined =>
  AGENT_ENV.find((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "0";
  });

// Whether a coding agent runs the tool, so color and redraws are off:
// what wantsColor and wantsRedraw take as `agent`.
export const isAgent = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => agentVariableOf(env) !== undefined;

/**
 * The marks a component draws, one per state, and the shapes it draws
 * with. The marks after `spinner` came later, so each is optional: a set
 * without one draws UNICODE_GLYPHS' mark.
 */
export type Glyphs = {
  done: string;
  failed: string;
  skipped: string;
  pending: string;
  spinner: readonly string[];
  /** The choice the cursor is on. */
  pointer?: string;
  /** A choice a multi-select has picked. */
  picked?: string;
  /** A choice a multi-select hasn't picked. */
  unpicked?: string;
  /** More above a window of a list. */
  up?: string;
  /** More below a window of a list. */
  down?: string;
  /** The keys that move, in a key hint. */
  upDown?: string;
  /** The keys that choose sideways, in a key hint. */
  leftRight?: string;
  /** A bar's done part. */
  barDone?: string;
  /** A bar's part to go. */
  barTodo?: string;
};

/** The marks for a terminal whose locale is UTF-8. */
export const UNICODE_GLYPHS: Required<Glyphs> = {
  done: "✓",
  failed: "✗",
  skipped: "-",
  pending: "○",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  pointer: "›",
  picked: "●",
  unpicked: "○",
  up: "↑",
  down: "↓",
  upDown: "↑↓",
  leftRight: "←→",
  barDone: "━",
  barTodo: "─",
};

// One frame for running, since an ASCII spinner's `-` would read as
// skipped for a frame; the seconds still move past one.
/** The same marks in ASCII, each its own shape, so none needs color. */
export const ASCII_GLYPHS: Required<Glyphs> = {
  done: "+",
  failed: "x",
  skipped: "-",
  pending: ".",
  spinner: [">"],
  pointer: ">",
  picked: "[x]",
  unpicked: "[ ]",
  up: "^",
  down: "v",
  upDown: "up/down",
  leftRight: "left/right",
  barDone: "=",
  barTodo: "-",
};

type Mark = Exclude<
  keyof Glyphs,
  "done" | "failed" | "skipped" | "pending" | "spinner"
>;

// A set made before a mark existed draws the Unicode one, so it
// needn't change.
export const markOf = (glyphs: Glyphs, mark: Mark): string =>
  glyphs[mark] ?? UNICODE_GLYPHS[mark];

// An unset locale is taken as UTF-8, every current system's default,
// since CI and a GUI's shell often set none; one that names C or
// another charset gets ASCII, as TERM=dumb does.
/**
 * Whether to draw ASCII_GLYPHS: under TERM=dumb, or a locale that
 * isn't UTF-8.
 */
export function wantsAscii(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (isDumb(env)) return true;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return locale !== undefined && locale !== "" && !/utf-?8/i.test(locale);
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
// What this process last did to the cursor, so an exit shows it only
// when something hid it.
const cursor = { hidden: false };

// The code that hides the cursor, noted, so an exit knows to show it.
export function hideCursor(): string {
  cursor.hidden = true;
  return HIDE_CURSOR;
}

// The code that shows the cursor again, noted, so an exit doesn't write
// it twice.
export function showCursor(): string {
  cursor.hidden = false;
  return SHOW_CURSOR;
}

// Whether a component hid the cursor and hasn't shown it since.
export const cursorHidden = (): boolean => cursor.hidden;

// "n/a", because an em dash for a missing value reads as punctuation.
export const MISSING = "n/a";

// A zero difference has no sign, so "±" only ever means noise. The
// minus is ASCII, so a pasted number parses.
export const signed = (value: number, show: (n: number) => string): string =>
  value === 0 ? show(0) : `${value > 0 ? "+" : "-"}${show(Math.abs(value))}`;

// The one separator, so every header and status line splits its parts
// the same way.
export const SEPARATOR = " · ";

// A sub-row's branch, so a group's last row closes it: ├ then └.
export const branch = (index: number, count: number): string =>
  index === count - 1 ? "└ " : "├ ";

// A note under a row, indented past the label's branch, as a reason or
// a problem that would push the row past 80 columns.
export const NOTE_INDENT = "    ";

// The last line of a run that finished: what it did and what it took,
// so a person sees it ended and why it took that long.
// `glyphs` gives the mark, as ASCII_GLYPHS where the locale isn't UTF-8.
export function closingLine(
  paint: Paint,
  what: string,
  detail?: string,
  glyphs: Pick<Glyphs, "done"> = UNICODE_GLYPHS,
): string {
  return `${paint.good(glyphs.done)} ${what}${detail === undefined ? "" : paint.dim(`${SEPARATOR}${detail}`)}`;
}

// A run that found problems ends in a cross, so the last line says
// whether to act, as the check mark does when there's nothing to do.
export function failLine(
  paint: Paint,
  what: string,
  detail?: string,
  glyphs: Pick<Glyphs, "failed"> = UNICODE_GLYPHS,
): string {
  return `${paint.bad(glyphs.failed)} ${what}${detail === undefined ? "" : paint.dim(`${SEPARATOR}${detail}`)}`;
}

/** A key a person can press, and what it does, for a hint line. */
export type KeyHint = { key: string; does: string };

/** Renders keys as one faint hint line: `↑↓ move · enter run · esc cancel`. */
export const keyHints = (paint: Paint, keys: readonly KeyHint[]): string =>
  paint.faint(keys.map((k) => `${k.key} ${k.does}`).join(SEPARATOR));

// A swap of two neighbors counts as one edit (optimal string alignment),
// so "--otu" is one edit from "--out".
function distance(a: string, b: string): number {
  const width = b.length + 1;
  const cells = new Uint32Array((a.length + 1) * width);
  const d = (i: number, j: number) => cells[i * width + j] ?? 0;
  for (let i = 0; i <= a.length; i++) cells[i * width] = i;
  for (let j = 0; j <= b.length; j++) cells[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        d(i - 1, j) + 1,
        d(i, j - 1) + 1,
        d(i - 1, j - 1) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d(i - 2, j - 2) + 1);
      }
      cells[i * width + j] = best;
    }
  }
  return d(a.length, b.length);
}

// Dashes aside and case folded, since `-V` is a typo of `-v` and the
// dashes are shared by every flag.
function shareLetter(a: string, b: string): boolean {
  const letters = new Set(a.replace(/^-+/, "").toLowerCase());
  for (const c of b.replace(/^-+/, "").toLowerCase()) {
    if (letters.has(c)) return true;
  }
  return false;
}

// The real flag or command nearest a typo, for "did you mean --json?":
// within a third of the input's length in edits, so a short typo still
// finds its flag and a word that's merely long doesn't match. The two
// names, dashes aside, share a letter, since one letter is one edit from
// every other: `-x` isn't a typo of `-h`, though `-V` may be of `-v`.
export function nearest(
  input: string,
  candidates: Iterable<string>,
): string | undefined {
  const most = Math.max(1, Math.floor(input.length / 3));
  let best: string | undefined;
  let bestDistance = most + 1;
  for (const candidate of candidates) {
    const d = distance(input, candidate);
    if (d < bestDistance && shareLetter(input, candidate)) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

// Cut at a word boundary, so a label never ends mid-word; JSON keeps
// it whole.
export function truncateWords(text: string, max: number): string {
  if ([...text].length <= max) return text;
  const cut = [...text].slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

// Since the file name matters more than its folders, and its first and
// last words more than its middle, folders go from the left first, then
// the stem's middle words, and the build hash and extension always stay,
// as in …/carbon-…DataTableSkeleton-Lp9Rk3Ds.js.
const HASH_TAIL = /[-.][^-./]+\.\w+$/;
const WORD_END = /(?<=[-_.])/;
const width = (text: string) => [...text].length;

export function truncatePath(path: string, max: number): string {
  if (width(path) <= max) return path;
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  for (let keep = parts.length - 1; keep >= 0; keep--) {
    const candidate = `…/${[...parts.slice(parts.length - keep), name].join("/")}`;
    if (width(candidate) <= max) return candidate;
  }
  const prefix = parts.length > 0 ? "…/" : "";
  const tail = HASH_TAIL.exec(name)?.[0] ?? "";
  const stem = name.slice(0, name.length - tail.length);
  const room = max - width(prefix) - width(tail) - 1;
  if (room < 4)
    return `${prefix}…${[...name].slice(-(max - width(prefix) - 1)).join("")}`;
  const words = stem.split(WORD_END);
  const first = words[0] ?? "";
  let end = "";
  for (let i = words.length - 1; i > 0; i--) {
    const word = words[i] ?? "";
    if (width(first) + 1 + width(word + end) > room) break;
    end = word + end;
  }
  return end === ""
    ? `${prefix}${[...stem].slice(0, room).join("")}…${tail}`
    : `${prefix}${first}…${end}${tail}`;
}

// A mark in the left margin for a row that needs work, in its rating's
// color, so a scan finds what to fix while the numbers stay plain.
export function withGutter(
  lines: readonly string[],
  marks: ReadonlyMap<number, (text: string) => string>,
): string[] {
  return lines.map((line, i) => {
    const mark = marks.get(i);
    return mark === undefined ? line : `${mark("▌")}${line.slice(1)}`;
  });
}

// eslint-disable-next-line no-control-regex -- escape codes are what it strips
const ESCAPE = /\x1b\[[0-9;]*m/g;
// eslint-disable-next-line no-control-regex -- escape codes are what it skips
const LEADING_ESCAPE = /^\x1b\[[0-9;]*m/;

// Widths come from Bun when it runs, since it counts wide characters;
// a package that also runs on Node counts one column per code point,
// because the text these tools print has no wide ones.
export const textWidth = (text: string): number =>
  typeof Bun === "undefined"
    ? [...text.replace(ESCAPE, "")].length
    : Bun.stringWidth(text);

// 80 columns, because that's the width a terminal opens at.
export const MEASURE = 80;

// Because a help table's second column starts after a run of two or more
// spaces, a wrapped description continues there, not at the margin.
function hangOf(line: string): number {
  const plain = line.replace(ESCAPE, "");
  const lead = /^ */.exec(plain)?.[0].length ?? 0;
  const gap = /^ *\S.*? {2,}(?=\S)/.exec(plain);
  return gap ? textWidth(gap[0]) : lead;
}

// Columns count only what shows, since a color code in the first half
// would otherwise put the split early.
function splitAt(line: string, columns: number): [string, string] {
  let seen = 0;
  let i = 0;
  while (i < line.length && seen < columns) {
    const escape = LEADING_ESCAPE.exec(line.slice(i));
    if (escape) {
      i += escape[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i) ?? 32);
    seen += textWidth(ch);
    i += ch.length;
  }
  return [line.slice(0, i), line.slice(i)];
}

// Help and other prose for a person: fit to the terminal, at most 80
// columns, and left whole when piped, since a program reads whole lines.
// Each line wraps alone; fitHelp rewraps a description written over
// several lines as one.
export const fitTerminal = (
  text: string,
  terminal: boolean,
  columns: number | undefined,
): string =>
  terminal ? fitWidth(text, Math.min(MEASURE, columns || MEASURE)) : text;

// The separator stays with the word after it, so no line ends on a
// dangling "·".
function wordsOf(text: string): string[] {
  const words: string[] = [];
  for (const word of text.split(/ +/)) {
    const last = words.at(-1);
    if (last !== undefined && last.replace(ESCAPE, "") === "·") {
      words[words.length - 1] = `${last} ${word}`;
    } else if (word !== "") words.push(word);
  }
  return words;
}

// Words in lines of at most `room` columns; a word wider than that is
// cut into pieces that fit, when `breakWords`, or else left whole on a
// line of its own.
function wrapWords(
  words: readonly string[],
  room: number,
  breakWords: boolean,
): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const pieces: string[] = [];
    let rest = word;
    while (breakWords && textWidth(rest) > room) {
      const [piece, after] = splitAt(rest, room);
      pieces.push(piece);
      rest = after;
    }
    pieces.push(rest);
    for (const piece of pieces) {
      const next = current === "" ? piece : `${current} ${piece}`;
      if (current !== "" && textWidth(next) > room) {
        lines.push(current);
        current = piece;
      } else {
        current = next;
      }
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

// Text whose lines are wider than `width`, wrapped at words: help on a
// narrow terminal, where a long line would wrap mid-word. A continuation
// line starts under its line's second column, or under its indent, so a
// table of options and their descriptions stays a table.
export function fitWidth(text: string, width: number): string {
  return text
    .split("\n")
    .flatMap((line) => {
      if (textWidth(line) <= width) return [line];
      let hang = hangOf(line);
      if (hang > width / 2)
        hang = /^ */.exec(line.replace(ESCAPE, ""))?.[0].length ?? 0;
      const [head, rest] = splitAt(line, hang);
      const room = Math.max(1, width - hang);
      return wrapWords(wordsOf(rest), room, false).map(
        (part, k) => (k === 0 ? head : " ".repeat(hang)) + part,
      );
    })
    .join("\n");
}

// What fitHelp does with a word wider than its line: "break" cuts it,
// so no line is wider than the terminal; "keep" leaves it whole on a
// line of its own, for a URL or a path a person copies.
export type HelpOptions = { words?: "break" | "keep" };

const LEAD = /^ */;
// A list item's lines continue under its text, not its marker, so the
// wrap hangs there.
const LIST_ITEM = /^ *(?:[-*•]|\d+[.)]) +(?=\S)/;
const leadOf = (line: string) =>
  LEAD.exec(line.replace(ESCAPE, ""))?.[0].length ?? 0;
// Where a line's text continues, since a wrap hangs there: under its
// second column, an item's text, or its indent.
const columnOf = (line: string) => {
  const item = LIST_ITEM.exec(line.replace(ESCAPE, ""));
  return item ? textWidth(item[0]) : hangOf(line);
};

// A line continues the paragraph above when it starts where the
// paragraph's first line has its text, under the description or at the
// margin, and isn't a row or an item of its own.
function paragraphsOf(text: string): string[][] {
  const paragraphs: string[][] = [];
  for (const line of text.split("\n")) {
    const current = paragraphs.at(-1);
    const first = current?.[0];
    const continues =
      current !== undefined &&
      first !== undefined &&
      line.trim() !== "" &&
      (current.at(-1) ?? "").trim() !== "" &&
      !LIST_ITEM.test(line.replace(ESCAPE, "")) &&
      hangOf(line) === leadOf(line) &&
      leadOf(line) === columnOf(first);
    if (continues) current.push(line);
    else paragraphs.push([line]);
  }
  return paragraphs;
}

// A paragraph that fits stays as written; one with a line too wide is
// joined and wrapped as one, its description under its second column,
// or under the option, indented, when the column would leave too little
// room: past half the width, or narrower than its longest word.
function fitParagraph(
  lines: readonly string[],
  width: number,
  breakWords: boolean,
): string[] {
  if (lines.every((line) => textWidth(line) <= width)) return [...lines];
  const [first = "", ...rest] = lines;
  const joined = [first.trimEnd(), ...rest.map((line) => line.trim())].join(
    " ",
  );
  const lead = leadOf(first);
  const column = columnOf(first);
  const [head, body] = splitAt(joined, column);
  const words = wordsOf(body);
  const longest = Math.max(0, ...words.map(textWidth));
  const hung = (prefix: string, indent: number) =>
    wrapWords(words, Math.max(1, width - indent), breakWords).map(
      (part, k) => (k === 0 ? prefix : " ".repeat(indent)) + part,
    );
  if (column === lead || (column <= width / 2 && column + longest <= width)) {
    return hung(head, column);
  }
  const [margin, option] = splitAt(head.trimEnd(), lead);
  const optionLines = wrapWords(
    wordsOf(option),
    Math.max(1, width - lead),
    breakWords,
  ).map((part, k) => (k === 0 ? margin : " ".repeat(lead)) + part);
  const indent = lead + 4;
  return [...optionLines, ...hung(" ".repeat(indent), indent)];
}

// Help as a terminal shows it: at most 80 columns, or the terminal's
// width when narrower, and as written when piped, since a program reads
// whole lines. Unlike fitTerminal, a description written over several
// lines rewraps as one, so it isn't left ragged; on a terminal too
// narrow for its column it goes under its option; and a word too long
// for a line is cut, or kept whole with `words: "keep"`.
export const fitHelp = (
  text: string,
  terminal: boolean,
  columns: number | undefined,
  options: HelpOptions = {},
): string =>
  terminal
    ? wrapHelp(text, Math.min(MEASURE, columns || MEASURE), options)
    : text;

// fitHelp at a given width, on a terminal or not, so a test or a caller
// that knows the width needn't fake a terminal.
export const wrapHelp = (
  text: string,
  width: number,
  options: HelpOptions = {},
): string =>
  paragraphsOf(text)
    .flatMap((lines) =>
      fitParagraph(lines, width, (options.words ?? "break") === "break"),
    )
    .join("\n");

// A cell that draws a rule as wide as its column, so totals read apart
// from the rows above them.
export const RULE = "\u0000rule";

// Numbers right-align, so the columns in `right` pad on the left. A
// left-aligned last cell is left ragged, since padding it would only add
// trailing spaces.
export function aligned(
  table: readonly (readonly string[])[],
  rightColumns: readonly number[] = [],
  paintRule: (text: string) => string = asIs,
  indent = "  ",
): string[] {
  const blank = (cell: string) => cell === "" || cell === RULE;
  // A column empty in every row, such as noise from one run, is left
  // out, or it would print as a double gap.
  const used = new Set(
    table.flatMap((row) => row.flatMap((cell, i) => (blank(cell) ? [] : [i]))),
  );
  const keep = (row: readonly string[]) => row.filter((_, i) => used.has(i));
  const rows = table.map(keep);
  const right = [...used]
    .sort((a, b) => a - b)
    .flatMap((column, i) => (rightColumns.includes(column) ? [i] : []));
  // Escape codes take no columns, so a colored cell pads as wide as
  // it shows.
  const cellWidth = (cell: string) => (cell === RULE ? 0 : textWidth(cell));
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) {
      if (i === row.length - 1 && !right.includes(i)) continue;
      widths[i] = Math.max(widths[i] ?? 0, cellWidth(cell));
    }
  }
  const pad = (cell: string, i: number) =>
    " ".repeat(Math.max(0, (widths[i] ?? 0) - cellWidth(cell)));
  const columnsWidth = (from: number, to: number) =>
    widths.slice(from, to).reduce((sum, w) => sum + w + 2, 0);
  return rows.map((row) => {
    const first = row.indexOf(RULE);
    if (first !== -1) {
      const last = row.lastIndexOf(RULE);
      const line = "─".repeat(columnsWidth(first, last + 1) - 2);
      return `${indent}${" ".repeat(columnsWidth(0, first))}${paintRule(line)}`;
    }
    // An empty row is a blank line, with no indent left trailing.
    return `${indent}${row
      .map((cell, i) =>
        right.includes(i)
          ? pad(cell, i) + cell
          : i === row.length - 1
            ? cell
            : cell + pad(cell, i),
      )
      .join("  ")}`.trimEnd();
  });
}

// aligned, with a row that overflows the measure shortened in its last
// cell by `shrink`, by just its overflow. Other rows, the header and a
// colored cell, which a cut would break, stay as they are.
export function fitted(
  table: readonly (readonly string[])[],
  rightColumns: readonly number[],
  shrink: (text: string, max: number) => string,
  paintRule: (text: string) => string = asIs,
): string[] {
  const lines = aligned(table, rightColumns, paintRule);
  if (lines.every((line) => textWidth(line) <= MEASURE)) return lines;
  const shrunk = table.map((row, r) => {
    const over = textWidth(lines[r] ?? "") - MEASURE;
    const last = row.length - 1;
    const cell = row[last] ?? "";
    if (r === 0 || over <= 0 || cell === RULE || cell.includes("\x1b")) {
      return row;
    }
    const copy = [...row];
    copy[last] = shrink(cell, textWidth(cell) - over);
    return copy;
  });
  return aligned(shrunk, rightColumns, paintRule);
}

// Lines with notes under some of them, keyed by the line's index, so a
// note follows its row without widening the table.
export function withNotes(
  lines: readonly string[],
  notes: ReadonlyMap<number, readonly string[]>,
): string[] {
  return lines.flatMap((line, i) => [line, ...(notes.get(i) ?? [])]);
}

// A table's header row is read once, then consulted, so it takes the
// smallest effective difference: faint, with no rule under it.
export const headerRow = (paint: Paint, cells: readonly string[]): string[] =>
  cells.map((cell) => paint.faint(cell));

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * One stderr line, rewritten in place while a long run works, so it never
 * looks stuck. Made only when stderr is a terminal, and not for a coding
 * agent or JSON; cleared before the result prints.
 */
export type Progress = {
  step(text: string, doneRatio: number): void;
  clear(): void;
};

export const SILENT: Progress = { step: () => {}, clear: () => {} };

const BAR_WIDTH = 20;
const CLEAR_LINE = "\r\x1b[2K";

export function createProgress(
  write: (text: string) => void,
  paint: Paint,
  nowMs: () => number,
  glyphs: Glyphs = UNICODE_GLYPHS,
): Progress {
  const startMs = nowMs();
  let text = "";
  let doneRatio = 0;
  const render = () => {
    const done = Math.round(Math.min(1, Math.max(0, doneRatio)) * BAR_WIDTH);
    // Done and to-do differ in shape as well as color, so the bar reads
    // without color too.
    const bar =
      paint.good(markOf(glyphs, "barDone").repeat(done)) +
      paint.dim(markOf(glyphs, "barTodo").repeat(BAR_WIDTH - done));
    const seconds = Math.floor((nowMs() - startMs) / 1000);
    write(`${CLEAR_LINE}${bar}  ${text}${paint.dim(` · ${seconds} s`)}`);
  };
  // A tick each second, so the clock moves while a step is in flight.
  const timer = setInterval(render, 1000);
  timer.unref();
  return {
    step(next, ratio) {
      text = next;
      doneRatio = ratio;
      render();
    },
    clear() {
      clearInterval(timer);
      write(CLEAR_LINE);
    },
  };
}
