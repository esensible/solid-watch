// Import boundary: nothing in this package may reach outside it, so it can be
// split into its own repository. Fails on any `../` path (in imports, requires,
// URLs, script/link references, shell `cd`s) that resolves outside the
// package root. Skips node_modules, dist and .build.
//
// Independence: solid-watch is a general library and knows no app built on
// it. Its sources and docs (everything but the engine's submodule, installed
// packages and build outputs) may not name another project of the repository
// it is developed in, nor use one app's domain words (see WORDS); the few
// generic uses it keeps are in ALLOW.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", ".build", ".swiftpm", ".git"]);
const TEXT = /\.(m?js|jsx|ts|json|swift|sh|html|css|md|yml|yaml|c|h|txt|pbxproj|xcscheme|plist|entitlements)$/;
const PATH_RE = /(?:\.\.\/)+[^\s"'`)]*/g;

// Not checked for words: the engine (someone else's code), the framework built
// from it, worktrees (checkouts of this package, checked in their own right),
// and the compiled fixture bundles (Solid's runtime; their sources in
// test/bundles/ are checked).
const WORD_SKIP_DIRS = new Set(["quickjs-ng", "Frameworks", ".worktrees"]);
const WORD_SKIP_FILES = [/^fixtures\/mutations\/[^/]+\/bundle\.js$/, /^package-lock\.json$/, /^test\/boundary\.mjs$/];
const WORDS = /\b(sail\w*|boats?|races?|racing|regattas?|marks?|vmg|headings?|hilux|extremers|toot|keyless|c6|kindle|pdms?|dingo\w*|knots?)\b/gi;
// Generic English (or Swift) uses that stay: matched against the whole line.
const ALLOW = [
  /\/\/ MARK:/, // Xcode's section pragma
  /\/\/ Content of a text leaf changed: mark the leaf/, // browser/shadow.js
];

const bad = [];
const words = [];
function walk(dir, checkWords) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, checkWords && !WORD_SKIP_DIRS.has(name));
    else if (TEXT.test(name) || name === "Package.swift") check(p, checkWords);
  }
}
function check(file, checkWords) {
  const src = readFileSync(file, "utf8");
  const rel = relative(ROOT, file).split(sep).join("/");
  const wordsHere = checkWords && !WORD_SKIP_FILES.some((re) => re.test(rel));
  src.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(PATH_RE)) {
      const target = resolve(dirname(file), m[0]);
      if (target !== ROOT && !target.startsWith(ROOT + sep)) bad.push(`${rel}:${i + 1}: ${m[0]}`);
    }
    if (wordsHere && !ALLOW.some((re) => re.test(line))) {
      for (const m of line.matchAll(WORDS)) words.push(`${rel}:${i + 1}: ${m[0]}`);
    }
  });
}
walk(ROOT, true);
let failed = false;
if (bad.length) {
  console.error("references outside solid-watch/:\n  " + bad.join("\n  "));
  failed = true;
}
if (words.length) {
  console.error("another project's name or domain word (test/boundary.mjs WORDS; a generic use goes in ALLOW):\n  " + words.join("\n  "));
  failed = true;
}
if (failed) process.exit(1);
console.log("boundary ok: no references outside the package, no other project's names");
