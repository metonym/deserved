/**
 * Deterministic, realistic fixture generators shared by scripts/bench.ts and
 * scripts/bench-micro.ts.
 *
 * A fixture that repeats one short unit compresses far better than real
 * code or prose (500x for repeated JS vs ~4x for the real thing), which
 * hides the per-request body cost the benches exist to measure.
 * assertRealistic() catches that regression at fixture-build time instead
 * of silently producing tiny compressed bodies again.
 */

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHA = "abcdefghijklmnopqrstuvwxyz";

function randomWord(rng: Rng, minLen: number, maxLen: number): string {
  const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHA[Math.floor(rng() * ALPHA.length)];
  return s;
}

function buildVocab(rng: Rng, count: number, minLen: number, maxLen: number): string[] {
  const words = new Set<string>();
  while (words.size < count) words.add(randomWord(rng, minLen, maxLen));
  return [...words];
}

function pick<T>(rng: Rng, arr: T[]): T {
  // biome-ignore lint/style/noNonNullAssertion: index is always in range
  return arr[Math.floor(rng() * arr.length)]!;
}

export function randomBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  const chunk = 65536;
  for (let i = 0; i < size; i += chunk) {
    crypto.getRandomValues(buf.subarray(i, Math.min(i + chunk, size)));
  }
  return buf;
}

/** Minified-looking JS: functions returning array/method-call expressions. */
export function fakeJs(size: number, seed = 1): string {
  const rng = mulberry32(seed);
  const ids = buildVocab(rng, 300, 2, 8);
  const strings = buildVocab(rng, 40, 3, 10);
  let out = "";
  let n = 0;
  while (out.length < size) {
    const fn = pick(rng, ids);
    const a = pick(rng, ids);
    const b = pick(rng, ids);
    const ret1 = pick(rng, ids);
    const ret2 = pick(rng, ids);
    const method = pick(rng, ids);
    const n1 = Math.floor(rng() * 100000);
    const n2 = Math.floor(rng() * 100000);
    const varName = pick(rng, ids);
    out += `function ${fn}(${a},${b}){return ${ret1}[${n1}]+${ret2}.${method}(${n2})}var ${varName}=${fn}(${n2});`;
    if (n % 7 === 0) out += `var ${pick(rng, ids)}="${pick(rng, strings)}";`;
    n++;
  }
  return out.slice(0, size);
}

const CSS_PROPS = [
  "color",
  "background",
  "margin",
  "padding",
  "display",
  "width",
  "height",
  "font-size",
  "border",
  "flex",
  "gap",
  "top",
  "left",
  "position",
  "opacity",
  "transform",
  "z-index",
  "line-height",
  "cursor",
];

const CSS_VALUES = [
  "12px",
  "1rem",
  "#a1b2c3",
  "flex",
  "block",
  "none",
  "0.5",
  "auto",
  "10%",
  "bold",
  "center",
  "absolute",
  "2px solid #000",
  "1px",
  "0.25rem",
];

export function fakeCss(size: number, seed = 2): string {
  const rng = mulberry32(seed);
  const ids = buildVocab(rng, 200, 3, 10);
  let out = "";
  while (out.length < size) {
    const selCount = 1 + Math.floor(rng() * 2);
    const selectors = Array.from(
      { length: selCount },
      () => `.${pick(rng, ids)}`,
    ).join(", ");
    const declCount = 3 + Math.floor(rng() * 4);
    const decls = Array.from(
      { length: declCount },
      () => `  ${pick(rng, CSS_PROPS)}: ${pick(rng, CSS_VALUES)};`,
    ).join("\n");
    out += `${selectors} {\n${decls}\n}\n`;
  }
  return out.slice(0, size);
}

/** HTML with a real </body> so watch-mode injection has an anchor. */
export function fakeHtml(size: number, title: string, seed = 3): string {
  const rng = mulberry32(seed);
  const words = buildVocab(rng, 500, 2, 9);
  const head = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n`;
  const tail = "</body>\n</html>\n";
  const bodyBudget = Math.max(0, size - head.length - tail.length);
  let body = "";
  while (body.length < bodyBudget) {
    const wordCount = 8 + Math.floor(rng() * 12);
    const p = Array.from({ length: wordCount }, () => pick(rng, words)).join(
      " ",
    );
    body += `<p>${p}</p>\n`;
  }
  body = body.slice(0, bodyBudget);
  return (head + body + tail).slice(0, size);
}

const encoder = new TextEncoder();
const MIN_RATIO = 2;
const MAX_RATIO = 8;

/**
 * Throws if `raw` doesn't zstd-compress within 2x-8x, so a fixture
 * generator regressing back to a highly-repetitive (or fully random, thus
 * incompressible) shape fails loudly instead of silently invalidating
 * compressed-scenario numbers.
 */
export function assertRealistic(name: string, raw: string | Uint8Array): number {
  const bytes = typeof raw === "string" ? encoder.encode(raw) : raw;
  const compressed = Bun.zstdCompressSync(bytes);
  const ratio = bytes.byteLength / compressed.byteLength;
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
    throw new Error(
      `${name}: zstd ratio ${ratio.toFixed(1)}x is outside ${MIN_RATIO}x-${MAX_RATIO}x ` +
        `(${bytes.byteLength} B -> ${compressed.byteLength} B); fixture generator regressed`,
    );
  }
  return compressed.byteLength;
}
