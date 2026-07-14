import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "package");

const STRIP = new Set(["devDependencies", "scripts", "files"]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const pkg = await Bun.file(join(root, "package.json")).json();

const result = await Bun.build({
  entrypoints: [join(root, "src/cli.ts")],
  outdir: out,
  target: "bun",
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const extra of ["README.md", "LICENSE"]) {
  const path = join(root, extra);
  if (existsSync(path)) {
    cpSync(path, join(out, extra));
  }
}

for (const key of STRIP) {
  delete pkg[key];
}

pkg.bin = { deserved: "./cli.js" };

writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
