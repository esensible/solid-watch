# Third-party software in solid-watch

solid-watch's own code is MIT (`LICENSE`). This lists everything in the
repository, or built into what it ships, that is someone else's: each with
its licence and where the licence text is. All of it may be redistributed
under MIT's terms beside it; nothing here is copyleft.

| what | version | licence | where it is | licence text |
|---|---|---|---|---|
| Inter (font) | 3.19, `Inter Variable/Single axis/Inter-roman.ttf` of the release, unmodified | SIL OFL 1.1 | `fonts/Inter-roman.ttf` | `fonts/LICENSE-Inter.txt` (the release's `LICENSE.txt`, unchanged) |
| quickjs-ng | v0.17.0 (6d46d07) | MIT | `quickjs-ng/`, a git submodule (a pointer only: a clone needs `git submodule update --init`); built into `Frameworks/CQuickJS.xcframework` (a build output, not committed) and the tests' `qjs` | `quickjs-ng/LICENSE`; the build script copies it into the framework |
| Yoga | 3.2.1 | MIT | not in the repository: facebook/yoga's Swift package, fetched by SwiftPM (`Package.swift`, `exact: "3.2.1"`) and built into an app | the package's `LICENSE` |
| yoga-layout (npm) | 3.2.1 | MIT | not in the repository: a dev dependency, the browser host's layout (`package.json`) | the facebook/yoga repository's `LICENSE` (the npm package ships none; its `license` field is MIT) |
| Solid: solid-js, @solidjs/universal, @solidjs/signals | 2.0.0 | MIT | `js/renderer.js` uses `@solidjs/universal` (a dependency) and `solid-js` (a peer dependency) by import; nothing of Solid is copied into the sources. The compiled fixture bundles `fixtures/mutations/*/bundle.js` contain their runtime (and so does every bundle the package builds) | `fixtures/LICENSE-Solid.txt` (the solidjs/solid repository's `LICENSE` and `@solidjs/signals`' `LICENSE`, unchanged) |
| @solidjs/babel-plugin | 2.0.0 | MIT | not in the repository: a dev dependency, the bundle build's JSX compiler (`js/rollup.js`) | the package's `LICENSE` |

## Notes

- **Inter and the OFL.** The licence text travels with the font
  (`fonts/LICENSE-Inter.txt`, and the demo app bundles both from `fonts/`).
  Inter 3.19 declares no Reserved Font Name (its licence names only the
  "Inter" trademark), and the file is the release's own, byte for byte, so
  it keeps its name. The OFL forbids selling the font on its own, not
  bundling it with software.
- **The fixture bundles** are build output of `test/bundles/` (rollup,
  `@solidjs/babel-plugin`, `@babel/preset-env`, terser): Solid's runtime and
  solid-watch's renderer, no Babel helpers. The build drops licence
  comments; `fixtures/LICENSE-Solid.txt` carries Solid's notices beside
  them.
- **Build tools** (`devDependencies`: Babel, rollup and its plugins, terser,
  TypeScript, vite) run at build time and are not redistributed. Their
  licences, as `package-lock.json` records them: MIT, ISC, BSD-2-Clause,
  BSD-3-Clause, Apache-2.0 (TypeScript, baseline-browser-mapping) and
  CC-BY-4.0 (caniuse-lite's data); none is copyleft.
- **Names, not code**: the props and defaults follow React Native's and
  the architecture its Fabric renderer's; no React Native code is in the
  repository.
