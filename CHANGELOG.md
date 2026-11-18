# Changelog

The public repository's history, newest first, in the style of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each entry is one
commit there: `tools/publish.sh` makes the commit's message from the top
entry, `solid-watch: <summary>` and the entry's text. An entry is headed
`## <date or Unreleased> - <summary>`; an export whose top entry is the one
the public repository already has is refused (see the README's
"Repository").

## Unreleased - examples show Solid 2's stores, async graph and transitions

- Examples/bundles/checklist: the rows are one `createStore`, shown through
  a `createOptimisticStore`; a tick is an `action` that saves (a timer
  stand-in, every third save fails), so the row flips at once and reverts
  with a message when its save fails; a `createOptimistic` "Saving…" flag;
  the counts are a `createProjection`.
- Examples/bundles/gauge: the band table is an async computation
  (`createDeferred` over a timer promise; the watch has no fetch) under
  `<Loading>` and `<Errored>` with a Retry; `isPending` dims the ring while
  a new table loads, and the crown keeps driving the level meanwhile.
- Examples/bundles/stopwatch: the reset is an `action` used as a
  transition, so the old laps stay until it settles, with a
  `createOptimistic` pending label; lap rows clear their own timer with
  `onCleanup`.
- test.mjs asserts each of these in the recording host (new `expectIn` and
  `expectCleared` steps); Examples/README.md maps every Solid 2 feature to
  its example and its check, using Solid 2's names (no `createAsync`,
  `Suspense`, `ErrorBoundary` or `startTransition` in 2.0).

## 2026-11-18 - three example bundles, a committed Demo project, neutral wording

- Examples/bundles: stopwatch, checklist and gauge, written for a reader
  learning the API; built with npm alone (solid-js 2.0.0, the Solid babel
  plugin, rollup) into a gitignored dist/; `npm test` runs each through the
  recording host, checks every prop against the schema and, with QJS set,
  that the engine's log equals node's. Examples/README.md explains bundles,
  the build, the browser harness and the Demo.
- Examples/Demo: a hand-written, committed Xcode project replaces the
  XcodeGen spec; it lists and runs any built example bundles, else the
  fixtures as before.
- Examples/IMPORTER.md: the scope of an iPhone app that imports a bundle
  from Files and runs it on the watch (container, transfer, host API gaps,
  protocol, hurdles, size), for later.
- Wording in the README, the gallery fixture, the layout cases and the
  schema docs made neutral; test/boundary.mjs refuses domain words.

## 2026-11-18 - initial public release

Native watch UIs in Solid 2 JSX: the universal renderer over a small host
interface, a Swift host (QuickJS-ng, Yoga, SwiftUI) and a browser harness
that run the same bundle; one schema generates each side's prop code.
