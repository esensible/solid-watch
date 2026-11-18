# Examples

Three small watch apps written as solid-watch bundles, and a watch app that
runs them.

| example | what it does | nodes |
|---|---|---|
| `bundles/stopwatch` | Start/Stop and Lap, the elapsed time in tabular figures, a scrolling lap list (the newest lit for a moment), a long press on the time to reset, which first hands the session over (a 400 ms stand-in) | `view`, `text`, `button` (`onPress`, `onLongPress`, `disabled`), `scroll`, `haptic`; `setInterval` / `setTimeout` on the host's timers, `Date.now()` on its clock |
| `bundles/checklist` | a list of toggle rows, a done/total bar, "Clear done"; each tick is saved (a 600 ms stand-in, every third save fails); a state `{ items: [...] }` replaces the list | `view`, `text`, `button` (a toggle row), `toggle` (drawn only), `progress` (bar), `scroll`, `icon` |
| `bundles/gauge` | the Digital Crown sets a level 0–100: a ring with the number in it, coloured by band with an icon per band, a strip of the bands; the band table is loaded ("Wide" or "Tight", 500 ms, every third load fails); Reset | `crown`, `progress` (ring, with children), `icon`, `text`, `view`, `button`, `haptic` |

Each `index.jsx` is commented for a reader learning both Solid 2 and the
watch nodes; its header lists the Solid 2 features it uses. The package's
README is the reference for nodes and props (its "Controls and styling").

## Solid 2, feature by feature

Solid 2 renamed or replaced several 1.x APIs: there is no `createAsync`,
`Suspense`, `ErrorBoundary`, `startTransition` or `useTransition`. Async
lives in computations (a memo whose function returns a promise), the
boundaries are `<Loading>` and `<Errored>`, and a transition is an
`action`. The examples use the 2.0 names (solid-js 2.0.0, checked against
its own type declarations), and `npm test` asserts each behaviour in the
recording host at the moment it is visible.

| feature | example | what it does there | asserted by `test.mjs` |
|---|---|---|---|
| `createStore` (draft setter) | checklist | the saved rows, one store of `{ id, label, done }`; no signal per row | rows and counts follow every write; "Clear done" and a host state replace rows |
| `createOptimisticStore` | checklist | the rows on screen: a tick shows at once, over the store | right after a tap the row's toggle, the count and the bar have flipped, the save still in flight |
| `action(function* …)` | checklist | the save: the guess, `yield` the save, then the store write | a successful save keeps the row; the third (failing) save reverts it and shows "Not saved, try again" |
| `createOptimistic(false)` | checklist, stopwatch | a "Saving…" / "saving laps…" flag that clears itself when the action ends | shown during the action, gone after |
| `createProjection` | checklist | the done / total counts as a derived store | "1 / 7" etc., optimistic and settled |
| `<Show>` | checklist | the empty state, the error message | "All clear" at the end |
| async computation (`createDeferred`) | gauge | the band table, from a promise; lags but never leads | see the next three rows |
| `<Loading>` | gauge | a placeholder until the first table lands | "Loading bands…", then the gauge |
| `isPending` | gauge | dims the ring while a new table is in flight; the old table stays | ring opacity 0.4 with the old band, then 1 with the new one; the crown still moves the level meanwhile |
| `<Errored>` and its `reset` | gauge | a failed load shows the error and Retry | "Table unavailable" and Retry; after Retry the last table comes back dimmed, then the new one |
| `createEffect(compute, apply)` | stopwatch | the 100 ms interval exists only while running; apply returns its cleanup | the time advances while running, not when stopped |
| `onCleanup` | stopwatch | a lap row's highlight timer is cleared when the row goes | a reset before it fires clears it (`clearTimer` in the log) |
| `action` as a transition | stopwatch | the reset's writes are held until the hand-off it yields settles | during the hand-off the old time and both laps stay (no empty list); then all clear in one update |
| `<For>` with `fallback` | stopwatch, checklist, gauge | the lap list ("No laps yet"), the rows, the band strip | the fallback before the first lap and after the reset |

Two findings from running them: an async `createMemo` for the gauge's
table holds the write that started the reload, and with it the crown's
writes to the level its readers share (the number froze until the table
landed), so the gauge uses `createDeferred`, which holds nothing. And
`latest()` has nothing to show there: with `createDeferred` the profile
itself switches at once.

## What a bundle is

A bundle is one JavaScript file, `bundle.js`: the app's JSX, Solid and
solid-watch's renderer compiled by solid-watch's rollup build
(`solidWatchBundle()` from `solid-watch/rollup`) into a single ES2022 IIFE.
Evaluated as a script, it sets `globalThis.__app`; a host (the Swift package
on the watch, which runs it in QuickJS-ng, or the browser harness, which
runs it in the page) calls `__app.mount`, delivers states and events, and
draws the nodes the bundle creates (the package README's "Bundle contract"
and "Host interface"). The same file runs on both.

## Building the examples

In `Examples/bundles`, on a Mac or in any environment with node 20 or later
(no Rust, no Xcode):

```sh
npm ci          # solid-js, the Solid compiler, rollup, and this package (installed as a copy of it)
npm run build   # dist/<name>/bundle.js for each example
npm test        # builds, then runs each one through a short script of taps, crown turns and waits
```

`npm test` runs every example through the package's recording host
(`test/driver.js`, the one its golden fixtures are made with), checks that
it never throws, that each tap reaches a handler, that every prop it sets is
in the schema and that the screen shows what it should, and writes the script
it played to `dist/<name>/script.json`. With `QJS=/path/to/qjs` (built by the
package's `test/build-qjs.sh`) it also runs each example under quickjs-ng,
the watch's engine, whose log must equal node's. `dist/` is a build output
and not committed. After changing the package itself, `npm ci` again: the
examples use a copy of it taken at install.

A new example is a directory here with an `index.jsx` (the build picks it
up) and a scenario in `test.mjs`.

## Running one in the browser harness

From the package root (`npm ci` there first), after `npm test` in
`Examples/bundles` (the harness needs each example's `script.json` as well
as its bundle):

```sh
SOLID_WATCH_BUNDLES=Examples/bundles/dist/stopwatch:Examples/bundles/dist/checklist:Examples/bundles/dist/gauge npm run dev
```

and open `http://localhost:5180/browser/?bundle=stopwatch`. The harness lists
the package's fixtures and these; buttons take clicks, the mouse wheel over
the screen turns the crown, and the scrub bar steps through the example's
`script.json`. Icons are drawn as placeholders there (a browser has no SF
Symbols); the watch draws them.

## Running them on a watch or simulator: the Demo

`Demo/SolidWatchDemo.xcodeproj` is a watch-only app (watchOS 10 or later). It
needs the package's QuickJS framework (the package README's Dependencies:
`git submodule update --init` and `sh scripts/build-quickjs-xcframework.sh`
in the package root). Build the examples first (above): a build phase copies
each `bundles/dist/<name>/` that exists at build time into the app, which
then opens on a list of them (tap one to run it); with none built it opens
on the package's fixtures (an integrity check of every fixture bundle
against its golden log, then the `timers` fixture live; double-tap for the
report). Open the project in Xcode and run it on a watch simulator, or:

```sh
xcodebuild -project Examples/Demo/SolidWatchDemo.xcodeproj -scheme SolidWatchDemo \
  -destination 'platform=watchOS Simulator,name=<a watch simulator>' build
```

On a simulator, `xcrun simctl launch <device> au.esensible.solidwatch.demo
-example gauge` opens one example directly, and `-play` (or `-play <n>`, its
first n steps) plays its `script.json` on it (written by `npm test`). For a real watch, set your
team in the target's Signing settings (any Apple ID's personal team works;
see below).

### Getting a bundle onto a watch

There is no way yet to put a new bundle on a watch without building the
app: an importer (an iPhone app that takes a `bundle.js` from Files and
sends it to its watch app, which runs it) is planned (`IMPORTER.md`).
Until then the Demo runs the bundles it is built with: the examples above,
and any fixture-shaped directory placed in `Demo/LocalFixtures/` (its
README).

With a free (personal) team, a development-signed app runs for 7 days and a
device holds at most three such apps at a time.
