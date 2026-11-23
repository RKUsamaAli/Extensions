import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const out = "dist";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function copyStatic() {
  cpSync("static", out, { recursive: true });
  for (const f of ["popup/index.html", "popup/popup.css", "options/index.html", "options/options.css", "shared/ui.css"]) {
    cpSync(`src/${f}`, `${out}/${f}`);
  }
}

const options = {
  entryPoints: {
    "popup/popup": "src/popup/popup.ts",
    "options/options": "src/options/options.ts",
  },
  outdir: out,
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: watch ? "inline" : false,
  minify: false, // readable code helps store review
  logLevel: "info",
  plugins: [{ name: "static", setup(b) { b.onEnd(copyStatic); } }],
};

// Content scripts can't be ES modules, and some browsers (WebKit-based ones
// such as Orion) don't accept module service workers, so both are IIFE builds.
const contentOptions = {
  entryPoints: { "content/fab": "src/content/fab.ts", "background/index": "src/background/index.ts" },
  loader: { ".svg": "text" },
  outdir: out,
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: watch ? "inline" : false,
  minify: false,
  logLevel: "info",
};

if (watch) {
  for (const o of [options, contentOptions]) await (await context(o)).watch();
} else {
  await Promise.all([build(options), build(contentOptions)]);
}
