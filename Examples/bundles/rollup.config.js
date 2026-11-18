// Builds every example (a directory here with an index.jsx) into
// dist/<name>/bundle.js with solid-watch's own bundle build: universal JSX ->
// one minified ES2022 IIFE that sets globalThis.__app.
import { existsSync, readdirSync } from "node:fs";
import { solidWatchBundle } from "solid-watch/rollup";

export const examples = readdirSync(".").filter((name) => existsSync(`${name}/index.jsx`));

export default examples.map((name) => solidWatchBundle({ input: `${name}/index.jsx`, file: `dist/${name}/bundle.js` }));
