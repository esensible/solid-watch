// Rollup config for a solid-watch bundle: JSX -> ES2022 IIFE that sets
// globalThis.__app and uses no browser globals.
//
//   import { solidWatchBundle } from "solid-watch/rollup";
//   export default solidWatchBundle({ input: "src/index.jsx", file: "dist/watch.js" });
//
// The build plugins are resolved from solid-watch's own node_modules (run
// `npm install` in solid-watch); solid-js is deduplicated to the app's copy,
// so the renderer and the app share one reactive runtime.
import babel from "@rollup/plugin-babel";
import resolve from "@rollup/plugin-node-resolve";
import solidJsx from "@solidjs/babel-plugin";
import presetEnv from "@babel/preset-env";
import terser from "@rollup/plugin-terser";
import { fileURLToPath } from "node:url";

const INDEX = fileURLToPath(new URL("./index.js", import.meta.url));

// The control-flow components the compiler imports from "solid-watch" when a
// bundle uses one without importing it: solid-js's own, re-exported by
// js/index.js (the plugin's default list also has Portal and Dynamic, which
// are @solidjs/web's, not a universal renderer's).
const BUILT_INS = ["For", "Show", "Switch", "Match", "Loading", "Reveal", "Repeat", "Errored"];

// Solid's JSX compiler hoists template declarations (`_tmpl$`) for DOM
// output; if one is ever lost the bundle fails at runtime with "_tmpl$ is not
// defined". Universal output shouldn't have any, so any left over is a build
// error.
const tmplGuard = {
  name: "solid-watch-tmpl-guard",
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.code && chunk.code.includes("_tmpl$")) this.error(`${chunk.fileName} still contains _tmpl$`);
    }
  },
};

export function solidWatchBundle({ input, file, minify = true, solidWatch = INDEX, plugins = [] }) {
  const out = [
    // "solid-watch" (babel's moduleName and the app's imports) -> this package
    {
      name: "solid-watch-resolve",
      resolveId(id) {
        if (id === "solid-watch") return solidWatch;
        if (id === "solid-watch/renderer") return fileURLToPath(new URL("./renderer.js", import.meta.url));
        return null;
      },
    },
    // the client (reactive) production build of solid-js, not the server
    // one; one copy of solid-js and its reactive core (@solidjs/signals)
    resolve({ dedupe: ["solid-js", "@solidjs/signals"], browser: true, exportConditions: ["browser"] }),
    // Two passes, as in the client-js configs: Solid's JSX first
    // (@solidjs/babel-plugin, Solid 2's compiler), then preset-env on the
    // result; in one pass a template declaration was lost.
    babel({
      babelHelpers: "bundled",
      extensions: [".js", ".jsx"],
      babelrc: false,
      configFile: false,
      plugins: [[solidJsx, { generate: "universal", moduleName: "solid-watch", builtIns: BUILT_INS }]],
    }),
    // Lowered for ES2022, the syntax QuickJS-ng (v0.17) runs natively:
    // babel names browsers, not ES versions, and Chrome 94 is the first with
    // all of ES2022's syntax (class static blocks). Lower than that
    // (`esmodules: true`, about ES2017) rewrites Solid's own class fields,
    // `?.`, `??` and `??=` into longer code and helpers: 6 KB of a 50 KB
    // app bundle.
    babel({
      babelHelpers: "bundled",
      extensions: [".js", ".jsx"],
      babelrc: false,
      configFile: false,
      presets: [[presetEnv, { targets: { chrome: "94" }, bugfixes: true }]],
    }),
    // (terser's `ecma` goes no higher than 2020; it only picks shorter
    // output forms and leaves ES2022 syntax as it is)
    ...(minify ? [terser({ ecma: 2020 })] : []),
    ...plugins,
    tmplGuard,
  ];
  return { input, output: { format: "iife", file }, plugins: out, onwarn };
}

// @solidjs/signals' published modules import each other in cycles (its own
// layout: core.js <-> async.js <-> scheduler.js, ...). Rollup reports each
// cycle; they are harmless here because no module reads another's binding
// while the bundle is evaluated (every bundle in test/ evaluates and runs).
// Those reports are dropped; every other warning, and a cycle anywhere else,
// is reported as usual.
const SIGNALS = /[\\/]node_modules[\\/]@solidjs[\\/]signals[\\/]/;
function onwarn(warning, warn) {
  if (warning.code === "CIRCULAR_DEPENDENCY" && warning.ids && warning.ids.every((id) => SIGNALS.test(id))) return;
  warn(warning);
}
