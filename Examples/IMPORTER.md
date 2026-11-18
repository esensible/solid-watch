# Importer: design note

Not built yet. This is the scope of an example app that lets anyone run a
bundle on their own watch without building anything: an iPhone app imports
a bundle from Files, sends it to its watch app, and the watch app runs it.
What exists today covers most of the watch side; the rest is two small apps
and some glue.

## What already exists

- `SolidWatchSession.load(_ data: Data, filename:expectedSHA256:)` runs a
  bundle from bytes, so loading from a file is `Data(contentsOf:)`;
  `unload()` and a new `load` replace one bundle with another (a press begun
  in the old one never reaches the new one: the package README's Behaviour).
- `MountView(session:)` draws it full screen; a bundle that throws gets the
  session's error screen and stops there (`session.error`).
- `JSHost.Options` already bounds what an untrusted bundle can do: a 24 MB
  heap, a 256 KB stack and a one-second limit on any call into JS. A bundle
  can reach nothing but the host interface: no network, no files.
- `NodeRegistry.addSchema(fragmentJSON:)` adds an app schema fragment at
  run time. The session's registry is fixed when the session is made, so a
  bundle with a different fragment gets a new session.
- The package builds for iOS too, so the phone can run a bundle itself
  (`ScriptRunner`, or a `MountView` preview) before sending it.

## (a) What gets imported

- **A single `bundle.js`** (what `npm run build` writes): the recommended
  container. One file, nothing to unpack, and every bundle today is one.
  The picker takes it as `UTType.javaScript` (`com.netscape.javascript-source`);
  no custom type needed.
- **A `.zip`**, the only extension: `bundle.js` at its root, plus an
  optional `fragment.json` (an app schema fragment) and an optional
  `assets/` directory. Imported as `UTType.zip` (`public.zip-archive`). To
  make "Open in…" from Files and Mail offer the app, declare an exported
  type (e.g. `<app id>.bundle`, extension `.swbundle`, conforming to
  `public.zip-archive`) in `UTExportedTypeDeclarations` and
  `CFBundleDocumentTypes`. Two limits come with it:
  - a fragment can only add **colours and groups**: new node types and
    `extends` props need native Swift views the app registers, which an
    imported file cannot bring; the importer refuses a fragment with `nodes`
    or `extends` (with a message saying so);
  - **assets** have no use yet: `image.source` takes only data URLs, so a
    bundle inlines its images (a rollup plugin that imports PNGs as data
    URLs does it). Assets in a zip need a new way to name them (a host-served
    `asset:` source), which is a contract addition.
- The phone checks before sending: size (a bundle is about 45 KB; refuse
  over, say, 2 MB), UTF-8, and a headless run (`ScriptRunner`: evaluate and
  mount at a watch size; any error is shown on the phone, not the watch).
  It names the bundle by its file name and identifies it by its SHA-256.

## (b) The two targets and the transfer

- **iPhone app** (SwiftUI): `fileImporter` (and the document types above),
  a list of imported bundles kept in Application Support, a preview
  (`MountView` at a watch size), "Send to watch", and a log of what the
  watch reports back.
- **Watch app** (SwiftUI, a companion app: `WKCompanionAppBundleIdentifier`
  set to the phone app, not `WKWatchOnly`): the list of bundles it has, the
  running one full screen, the bundled font (below).
- **WatchConnectivity**:
  - the bundle goes by `WCSession.transferFile(_:metadata:)` with metadata
    `{ name, sha256, kind: "bundle" }`: queued, survives either app not
    running, delivered in the background, retried by the system. There is
    no documented size limit; a 45 KB file arrives in seconds when the
    devices are near. `outstandingFileTransfers` shows progress and allows
    cancelling a superseded one.
  - on the watch, `session(_:didReceive file:)` gets a temporary URL that is
    deleted when the method returns: move it into Application Support at
    once (`bundles/<sha256>/bundle.js`), check its SHA-256 against the
    metadata, and record it in a small manifest. Received while the app was
    not running, it is delivered at the next launch (or a background
    refresh task); nothing is lost.
  - which bundle is "current" goes by `updateApplicationContext` (latest
    value wins, delivered when the watch app next runs), so a phone that
    sends three bundles in a row leaves the watch on the last.
  - **a new bundle arriving while one runs**: the watch stores it and shows
    a "New: <name>, tap to run" banner rather than swapping under the
    user's finger; "run on arrival" can be a setting. Swapping is
    `unload()` + `load()` on the main actor. If the new one fails to load
    (`session.error`), the watch says so and offers the previous one back.
  - both simulators (a paired iPhone and Apple Watch) run WatchConnectivity,
    so all of this can be developed without devices; background delivery
    and timing need a real pair to verify.

## (c) Host API: what is missing, and a protocol for the example

- **Loading from a file URL**: nothing missing (bytes from the file); a
  convenience `load(contentsOf:)` would be sugar.
- **Fragment at run time**: works (`addSchema(fragmentJSON:)`) within the
  colours-and-groups limit above.
- **Fonts**: the schema has one font, Inter, which both hosts measure and
  draw with. The watch app ships `fonts/Inter-roman.ttf` (and its licence)
  and registers it at launch (`Fonts.register`, `Fonts.family =
  CoreSchema.fontFamily`), as the Demo does. A bundle cannot bring a font;
  a second font is a schema change, not an importer feature.
- **State in, events out**: a host calls `session.setState(JSData)`, which
  reaches the bundle's `createApp(App, { onState })`; the bundle's
  `send(bytes)` reaches `session.onSend([UInt8])`. What they carry is the
  app's own business. For the importer example a minimal, generic one:
  - **state in**: a JSON object, from the phone (`sendMessage` while
    reachable, else the application context), parsed with `JSData(json:)`
    and passed to `setState` as it is; the phone app has a small JSON
    editor to send one. A bundle that ignores state (all three examples
    can) works unchanged.
  - **events out**: the bundle calls `send(bytes)` with UTF-8 JSON (the
    bytes of `JSON.stringify(event)`, as a `Uint8Array` or an array of byte
    values); the watch forwards them to the phone, which shows them in its
    log. No schema: it is a debugging channel.
  - real apps define their own protocol on these two calls (binary, typed,
    versioned); nothing in the package assumes this one.
- **Persistence**: a bundle has no storage of its own; the checklist's
  ticks live in memory and are gone when the watch app is relaunched. The
  example can keep the last state it sent and resend it on launch, which
  covers app-driven state. A bundle-side key-value store would be a new
  host call (a contract addition) and is out of the importer's scope.
- **Lifecycle**: when the wrist drops the app is suspended and its timers
  stop; a bundle that computes time from `Date.now()` (the stopwatch) is
  right when it wakes. Always-on drawing is not handled (the package's "Not
  yet" list).

## (d) What it takes to install it yourself

- **The QuickJS framework**: `git submodule update --init` and
  `sh scripts/build-quickjs-xcframework.sh` (Xcode's command line tools,
  a few minutes). It is a build output, not committed (the package README's
  "Why QuickJS is prebuilt"); a release could attach a prebuilt one.
- **Signing with a personal team**: any Apple ID works in Xcode, but the
  bundle identifiers must be the builder's own (an identifier registered by
  another team cannot be used), so the project needs one place to change
  the prefix (an `.xcconfig`), and the phone and watch targets must agree
  on it. Developer Mode on the iPhone and the watch; the first install to
  a watch from Xcode is slow.
- **Free-team limits**: a personal team's apps expire after 7 days (rebuild
  to renew) and a device holds at most three of them at a time (the watch
  as well as the phone).
- No App Store or TestFlight distribution for a personal team: each user
  builds it.

## (e) Size and order of work

About five working days for one person who knows SwiftUI and
WatchConnectivity:

1. Watch app: run a bundle from Application Support, list of stored
   bundles, error screen, font registration (half a day; most of it is the
   Demo's code).
2. Phone app: file import (`.js`), storage, headless check and preview,
   list (one day).
3. WatchConnectivity: file transfer, receipt and manifest, current bundle
   by application context, the arrival banner and swap, the state/event
   relay (one and a half days, including testing on a real pair).
4. `.zip` import with a colours-and-groups fragment, and the document types
   for "Open in…" (half a day to a day).
5. The identifier prefix in one `.xcconfig`, the signing walkthrough, and
   the README (half a day).

Steps 1 and 2 can run in parallel; 3 needs both; 4 and 5 are independent of
3.
