# solid-watch

Native watch UIs written in [Solid](https://www.solidjs.com/) 2 JSX. A small JS
bundle runs in an embedded engine (QuickJS-ng on the watch); Solid's universal
renderer (`@solidjs/universal`) turns it into node mutations; the host lays the nodes out with
[Yoga](https://yogalayout.dev/) and draws them natively. The same bundle runs in
a browser harness (DOM host + `yoga-layout`) for development.

The architecture follows React Native's Fabric: three trees (Solid tree →
shadow tree with props and Yoga → mounted views), batched commits, integer
tags across the boundary, one schema that generates every side's prop code,
React Native's style names and defaults, and raw text only inside `<text>`.
Time is the bundle's business, as in a web app: it has `setTimeout` /
`setInterval` (on the host's timers) and `Date` (the host's clock).

```
schema/nodes.json        the node types and props: THE contract
codegen/codegen.mjs      schema (+ app fragments) -> js/jsx.d.ts, Swift prop structs, browser/props.js
js/renderer.js           Solid universal renderer over the host interface; createApp()
js/rollup.js             bundle build (universal JSX -> ES2022 IIFE)
browser/                 shadow tree + text layout (shared algorithm), DOM host, harness
fonts/                   the one font both hosts use (Inter, OFL)
test/                    node tests, qjs runner, fixture generators
fixtures/                golden mutation logs, expected frames, layout-parity cases
Sources/SolidWatch/      Swift package (Generated/NodeProps.swift is generated)
Examples/                example bundles (stopwatch, checklist, gauge) and the demo watch app: Examples/README.md
quickjs-ng/              the engine: a git submodule, quickjs-ng v0.17.0, source of the framework below
Frameworks/CQuickJS.xcframework   quickjs-ng prebuilt, optimised: a build output (scripts/build-quickjs-xcframework.sh)
```

Licence: MIT (see `LICENSE`), for solid-watch's own code. What is someone
else's, with its licence and where its text is: `THIRD-PARTY.md`. In short:
Inter is under the SIL OFL 1.1 (`fonts/LICENSE-Inter.txt`); quickjs-ng,
Yoga and Solid are MIT (quickjs-ng's `LICENSE` in its submodule, Yoga's in
its package, Solid's in `fixtures/LICENSE-Solid.txt` beside the fixture
bundles that contain its runtime).

### Dependencies

- **quickjs-ng** v0.17.0: the `quickjs-ng/` submodule, pinned to that
  tag's commit. Linked as `Frameworks/CQuickJS.xcframework`, which is
  built from it and not committed (next section). After cloning:

  ```sh
  git submodule update --init quickjs-ng   # from the repository root: git submodule update --init
  sh scripts/build-quickjs-xcframework.sh  # Xcode command line tools; again after updating quickjs-ng
  ```

  Without the framework the package does not load: SwiftPM (and Xcode)
  stop with "solid-watch: Frameworks/CQuickJS.xcframework is missing" and
  these steps.
- **Yoga** 3.2.1: facebook/yoga's own Swift package (`exact: "3.2.1"`),
  fetched by SwiftPM; its C API is the `yoga` module.
- **Solid 2** (the 2.0.0 release), exact versions: `solid-js` 2.0.0 (a
  peer dependency: the app installs it, and the bundle uses the app's copy),
  `@solidjs/universal` 2.0.0 (the renderer runtime, a dependency) and
  `@solidjs/babel-plugin` 2.0.0 (Solid 2's JSX compiler, for the bundle
  build). Their `engines` field asks for node ≥ 22.12; the bundle build and
  every test here run on node 20 (the browser build is bundled, and it uses
  no API node 20 or quickjs-ng lacks).

### Why QuickJS is prebuilt

The interpreter must be optimised in every build of an app. At `-O0`
QuickJS's interpreter frames are several times larger, so an ordinary UI's
first render overflows the engine's stack limit in a Debug build. SwiftPM
builds a source target with the app's configuration and has no per-target
optimisation setting. `unsafeFlags(["-O2"])` would work, but SwiftPM refuses
a package that uses it as a versioned dependency. So the package links
quickjs-ng as a `binaryTarget`: an XCFramework of static libraries for
watchOS, iOS and macOS (devices and simulators), built `-O2 -DNDEBUG` by
`scripts/build-quickjs-xcframework.sh` from the `quickjs-ng/` submodule.
The framework is a build output (`Frameworks/` is ignored): the build is
reproducible (the same sources and Xcode give the same bytes), so it is
built where it is used rather than committed; rerun it after updating the
submodule. The glue (`CSolidHost`) is a source target and Yoga a package
dependency, both built with the app.

## Writing a bundle

```jsx
import { createSignal } from "solid-js";
import { createApp } from "solid-watch";

const [speed, setSpeed] = createSignal(0);

function App(props) {            // props = ctx: { width, height } in points
  return (
    <view flexGrow={1} alignItems="center" justifyContent="center" gap={4}>
      <text fontSize={40} fontWeight="700" tabular minScale={0.5}>{speed().toFixed(1)}</text>
      <button onPress={() => setSpeed(0)} height={32} alignSelf="stretch" background="#333333" borderRadius={10}
              alignItems="center" justifyContent="center">
        <text>Reset</text>
      </button>
    </view>
  );
}

createApp(App, { onState: (s) => setSpeed(s.speed) });
```

For editor types set `"jsxImportSource": "solid-watch"` (the package has its
own `JSX` namespace; Solid's DOM elements would clash with `<button>` and
SVG `<text>`); `test/types/` type-checks it with `tsc`.

Build with `solidWatchBundle()` from `solid-watch/rollup` (`@solidjs/babel-plugin`
`generate: "universal"`, `moduleName: "solid-watch"`, and its production
default `lowerShow`: a plain `<Show>` compiles to the ternary it renders;
solid-js's browser production build). The bundle uses no browser globals but `queueMicrotask`
(which quickjs-ng and browsers have); `setTimeout` and friends are the
package's own (Timers).

Solid 2 semantics apply (its migration guide): effects are split
(`createEffect(compute, apply)`, the apply half returns its cleanup), stores
come from `solid-js`, writes are batched and read back after a flush. A
setter called in a handler, `onState` or a timer is applied before that call
commits (next section).

## Batching and commits

Each call into the app (`mount`, `onState`, `dispatch`, `timer`) runs inside
Solid 2's `flush(fn)`: the writes it makes, the render effects and then the
user effects they run, and whatever those write in turn, are all applied
before the call returns; then the renderer commits once. So a host sees one
commit per call, with every mutation of that call before it
(`test/renderer.test.mjs`). (Solid 1 versions of this package gave the same
with `batch()`.)

Work Solid finishes later, in a microtask, mutates the host after the call
returned: an async computation (`createMemo(async …)` under `<Loading>`), an
action, `from(…)`. The renderer commits those changes itself, from a
microtask queued behind Solid's own flush, so a host that runs the engine's
pending jobs after each call (as it must, Host interface) gets them as a
second commit of their own, before its next call (`test/bundles/async`). A
write that makes an async value pending holds the whole update it belongs to
(a Solid 2 transition) until the value lands: the call's own commit then
changes nothing attached, and the late commit brings all of it.

A call made from inside another (a handler calling `__app.onState`) does not
commit; the outermost call commits once (`test/bundles/edges`).

Errors: a handler that throws fails its call (no commit) and the app goes
on; whatever it had already applied to the host is in the next commit. An
error thrown while rendering that no `<Errored>` boundary catches fails its
call too, and Solid 2 then halts its reactivity for good
(`console.error("[REACTIVITY_HALTED]")`): later calls change nothing. When
that happens after the call (an async value lands and its render throws),
Solid hands the error to `globalThis.reportError`, which the renderer
installs: it rethrows it from a job, so the host's job queue fails with it
as for any other job, and nothing after it is committed. Because the
renderer owns `reportError`, an app that calls it itself fails the call it
is in, and an error Solid reported fails the outermost call even when app
code caught the throw (Solid has halted either way); when the call also
throws, the reported error is the one the host gets. The Swift session stops
at the first error and shows it (`test/bundles/errors`, `test/bundles/edges`).

## Spreads and refs

`<view {...props} />` works as with any Solid renderer, with one compiler
quirk: a literal prop written *before* a spread is set once, and if the
spread later drops that key it is reset to the schema default rather than
back to the literal. Write fixed props after the spread.

A `ref` receives the renderer's node object; only its `tag` (the host's
integer tag) is meant to be read. A ref callback runs as a render effect's
callback does (Solid 2.0.0: untracked, in the pass that builds the node), so
put any setup and cleanup in the component (`onCleanup`), not in the callback.

## Text updates

A dynamic expression that is the only child of a `<text>` is updated in
place: one `setProp(tag, "text", …)` per change. One that has siblings
(`<text>sent {n()}</text>`) is a new raw text node on every change with
Solid 2's universal renderer (`createText`, `remove` of the old one,
`insert`; the old node is released after a GC), and each such hole also
creates and removes an empty placeholder text at mount. Layout is the same
either way. Where a mixed text changes often, give the dynamic part its own
span: `<text>sent <text>{n()}</text></text>`.

## Bundle contract

The bundle, evaluated as a script, sets:

```js
globalThis.__app = {
  mount(rootTag, ctx),          // ctx = { width, height } (points); renders, then one commit
  onState(state),               // runs the app's onState(state) inside flush(), then one commit
  dispatch(tag, name, payload), // runs the JS handler for event `name` on `tag` inside flush(),
                                // then one commit; returns false (no commit) if there is none
  timer(id),                    // timer `id` is due: runs its callback inside flush(), then one
                                // commit; returns false (no commit) if it was cleared
}
```

`state` is whatever the app delivers (bytes as a `Uint8Array`, an object…);
the package never looks at it.

## Timers

The bundle has the web's `setTimeout(fn, ms, ...args)`, `clearTimeout(id)`,
`setInterval(fn, ms, ...args)` and `clearInterval(id)` (exported by
`solid-watch` and installed as globals when the bundle loads, so code written
for a browser runs unchanged). They run on the host's timers: the renderer
calls `setTimer(id, ms)` / `clearTimer(id)` and the host calls
`__app.timer(id)` when one is due; the callback runs inside `flush()` and is
followed by one commit, like a state or an event. An interval re-arms itself
before its callback runs. A delay under 0 is 0.

`Date` is the host's own clock, untouched. A bundle that shows times of
another system (a device it talks to) keeps the offset itself, as a web
client of a server does: `offset = state.timestamp − new Date().getTime()`
on each state, `now = new Date().getTime() + offset`, and a countdown is a
`setTimeout` loop that re-renders each second (`test/bundles/timers`).

## send

`send(bytes)` (exported by `solid-watch`; a `Uint8Array` or an array of byte
values) hands bytes to the app's native side: host op `send([b, ...])`. What
happens to them (written to a device over BLE, …) is the app's business:
`SolidWatchSession.onSend`, `DomHost`'s `onSend` option.

## Host interface

The host sets `globalThis.__host` before evaluating the bundle. All calls are
synchronous. Tags are positive integers chosen by the host; `0` means none.
The root's tag is passed to `mount` (the reference hosts use `1` and number
created nodes from `2`).

| call | meaning |
|---|---|
| `createNode(type) → tag` | a node of a schema type (`view`, `text`, …), detached |
| `createText(s) → tag` | a raw text node; only meaningful inside `<text>` |
| `setProp(tag, key, value)` | set a prop; `null` resets it to the schema default. Raw text nodes take only `"text"`. Values are JSON-shaped (null, bool, number, string, array, plain object). Event props (`onPress`) arrive as `true` (a JS handler is set) or `null` |
| `insert(parent, child, before)` | insert `child` before `before` (`0` = append). Inserting an attached node moves it |
| `remove(parent, child)` | detach `child`. The renderer may re-insert a removed node later, so keep it |
| `commit()` | end of a batch: apply, lay out, draw. Normally the last call of a call into the app; also made from a pending job, for work Solid finished after the call (Batching and commits) |
| `setTimer(id, ms)` | arm timer `id` (replacing it if armed) to fire in `ms` ms: then call `__app.timer(id)` (see Timers) |
| `clearTimer(id)` | disarm timer `id` (unknown ids are ignored) |
| `send(bytes)` | the bundle's `send`: an array of byte values for the app (see send) |
| `release(tag)` | JS can no longer reach `tag`: free it (props, Yoga node, view). Only now may a host free a node. Its parent, if any, is being released too; its children are released by their own calls, in any order |

`release` comes from a `FinalizationRegistry` on the renderer's node
objects: the engine calls it after a garbage collection, as a pending job,
outside any batch and without a commit (a released node is never attached).
On quickjs-ng the host must run pending jobs (`JS_ExecutePendingJob` until
none) after each call into JS, and let the GC run (its own thresholds, or
`JS_RunGC` now and then, e.g. on a state when idle). Verified under qjs
v0.17.0 with `std.gc()` and under node (`test/release.test.mjs`): exactly
the detached nodes are released.

Host → JS: `__app.dispatch(tag, name, payload)`; the event name is the prop
name without `on`, first letter lower-cased (`onPress` → `"press"`,
`onPressIn` → `"pressIn"`).
`__app.timer(id)` when a timer is due.

Rules every host follows:

- **Run the pending jobs after each call into JS** (`JS_ExecutePendingJob`
  until none on quickjs-ng; a browser does it by itself), before anything
  else: Solid 2 schedules work as microtasks, and the renderer's late commits
  and `release` calls arrive from them.

- **Raw text outside `<text>` is ignored** (not laid out or drawn). Solid
  inserts empty text nodes as placeholders where a conditional renders
  nothing; the renderer throws on a *non-empty* raw string outside `<text>`.
- **Nested `<text>` is a span**: no Yoga node; it styles its run of the outer
  text. Text style props (`kind` measure/paint with `inherit`) inherit from the
  enclosing `<text>`; layout props on a span are ignored.
- **A node type whose `children` is `none` takes none** (`toggle`, `icon`,
  `image`, `haptic`, `crown`): `insert` into one throws, on both hosts
  (Yoga can't hold children under a measured leaf). Before version 2 a
  child of a `haptic` was silently ignored.
- **`haptic` and `crown` have no Yoga node.** Raw text has none either. Everything else
  with the `layout` group has one; Yoga children are the node's children with
  a Yoga node, in order.
- A prop's `kind` says what a change invalidates: `layout` (Yoga style),
  `measure` (re-measure the enclosing text leaf, or the icon itself), `paint`,
  `behavior`, `event`.

## Schema

`schema/nodes.json`: `font`, `colors` (name → `#RRGGBB[AA]`), `groups` (named
prop sets), `nodes` (type → `groups`, own `props`, `children`: `nodes` |
`text` | `none`). A prop: `kind`, `type` (`number`, `string`, `boolean`,
`enum` + `values`, `dimension` (number = points, `"N%"`, `"auto"` if
`auto: true`), `color`, `event`, `object` (+ `fields`), `array` (of objects
with `fields`; field types `number` | `string`), `any`, `bytes`),
`default`, optional `inherit`, `doc`, `swiftNames`.

Core nodes: `view`, `text`, `scroll`, `button`, `toggle`, `progress`,
`icon`, `image`, `haptic`, `crown` (next section). Nothing app-specific
lives in the core schema. The schema's `version` is the contract version
(below).

## Controls and styling

What a watch UI can say, in the schema's terms. The bar for adding a node
or prop: a glanceable watch screen needs it, SwiftUI on watchOS
draws it well, and both hosts can make it mean exactly the same thing
(frames are Yoga's, so nothing a host draws may change layout; a rule with
arithmetic in it is written once in `browser/controls.js`, ported line for
line to `Sources/SolidWatch/Controls.swift`, and both are held to
`fixtures/controls.json`). Props go on existing nodes unless a control
draws something a box can't.

| | props |
|---|---|
| layout (every node with a frame) | Yoga's: `width`/`height`/`min*`/`max*` (points, `"N%"`, `"auto"`), `aspectRatio`, `flex`, `flexGrow`, `flexShrink`, `flexBasis`, `flexDirection`, `flexWrap`, `justifyContent`, `alignItems`, `alignSelf`, `alignContent`, `gap`/`rowGap`/`columnGap`, `margin*`/`padding*` (all, horizontal, vertical, each side), `borderWidth`, `position` + `top`/`right`/`bottom`/`left`, `display`, `overflow`, `boxSizing` |
| box (every visible node) | `background`, `borderColor`, `borderRadius` (continuous corners; 999 = capsule), `borderTopLeftRadius` … `borderBottomLeftRadius`, `opacity`, `rotate` (degrees), `scale` |
| text (inherited by spans) | `color`, `fontSize`, `fontWeight` (`normal`, `bold`, `100`…`900`), `tabular`, `lineHeight`, `letterSpacing`, `textAlign`; leaf only: `numberOfLines`, `minScale` |
| `scroll` | `showsVerticalScrollIndicator` (React Native's name; default false here, true there) |
| `button` | `onPress`, `onLongPress`, `onPressIn`, `onPressOut`, `disabled`, `pressedOpacity`, `pressedScale`, `pressedBackground` |
| `toggle` | `value`, `onChange` (gets !value), `disabled`, `activeTrackColor`, `inactiveTrackColor`, `thumbColor` |
| `progress` | `value` (0…1), `shape` (`bar`, `ring`, `arc`), `color`, `trackColor`, `thickness`; children are drawn over it |
| `icon` | `name` (SF Symbol), `size`, `color`, `weight`, `renderingMode` (`monochrome`, `hierarchical`, `multicolor`) |
| `image` | `source` (PNG/JPEG data URL), `resizeMode` (`cover`, `contain`, `stretch`, `center`), `tintColor` |
| `haptic` | `pattern`, `trigger` |
| `crown` | `value`, `min`, `max`, `increment`, `wrap`, `sensitivity`, `onChange` (gets the new value) |

**Colours** are `#RRGGBB`, `#RRGGBBAA` (alpha: `#0A84FF40` is a tinted
fill) or a token: `white`, `black`, `transparent`, and watchOS's dark
system palette `red` `orange` `yellow` `green` `mint` `teal` `cyan` `blue`
`indigo` `purple` `pink` `brown` `gray`, `gray2`…`gray6` (`gray5`/`gray6`
are the platform's button and card fills; `gray` is the lightest grey,
`gray6` the darkest). They are fixed hex values on both hosts, not dynamic
system colours (no vibrancy, no increased-contrast variants). An app
fragment adds its own tokens (theming: `accent`, `caption`, …). Anything
else (a CSS name, `#fff`, `rgba()`) is invalid: it draws nothing on either
host (the prop's default where it has one, white for a text or control
colour).

**Controls are controlled.** A toggle draws `value`; a tap only reports
`change`. The crown is put at `value` when it is attached and whenever
`value` changes; between those, turning keeps moving it from there and
reports each new value. So an app may set `value` in its handler or later
(a value that comes back from a device in a state): either way the app's
state is the truth, as with React Native's inputs. Nothing animates implicitly: what a
commit says is what is drawn.

**Opacity and transforms compose.** A node draws at `opacity`; a button's
*content* (not its background or border) is further × `pressedOpacity`
while pressed and × 0.35 when disabled (the browser preview dims each child
on its own, so overlapping children show through each other there; the
watch dims the content as one layer). The drawn transform is `scale` (× `pressedScale` while pressed),
then `rotate`, both about the node's centre (there is no transform origin:
to pivot a needle at one end, rotate a box twice its length with the
needle in one half).

**Naming.** React Native's where it has one (style props, `onPress`,
`onLongPress`, `onPressIn`, `onPressOut`, `resizeMode`, `tintColor`, `showsVerticalScrollIndicator`).
`icon` follows react-native-vector-icons (`name`, `size`, `color`) plus
`weight` and `renderingMode`; `image.source` is a data-URL string, not
React Native's `{ uri }`; the crown's `increment` is HTML's `step` and
SwiftUI's `by:`. A long press is React Native's default 0.5 s.

**Buttons have no variants.** A filled, tinted, bordered or plain button is
a `button` with box props (`background="blue" borderRadius={999}`,
`background="#0A84FF40"` with a `blue` label, `background="gray5"`,
`borderWidth`/`borderColor`), so a bundle defines its own `Button`
component once; `pressed*` give it a pressed look. A segmented control is
buttons in a row with per-corner radii; a stepper is − and + buttons and/or
a `crown`; a toggle row is a `button` holding a `<text>` and a `toggle`
without `onChange` (the whole row is the tap target).

### Contract version

`schema/nodes.json` `version` (3) counts additions: it is bumped whenever a
node type, a prop, an enum value or a colour token is added. A name never
changes meaning: a new meaning gets a new name. 1 is the set before
`toggle`, `progress`, `icon`, `image`, `crown`, `letterSpacing`,
per-corner radii, `rotate`/`scale`, `pressed*`, `onLongPress`,
`showsVerticalScrollIndicator` and the colour tokens; 2 the set before
`button`'s `onPressIn` and `onPressOut`. Hosts set
`__host.version` (the Swift host from `CoreSchema.version`, the browser
host from its schema, the test driver `HOST_VERSION`); a bundle reads it
with `hostVersion()` from `solid-watch` (1 on a host that doesn't set it).
Bundles that don't call it are unchanged (it is tree-shaken).

On an older host, a node type or prop it doesn't know fails the bundle at
that `createNode`/`setProp` (the Swift session shows its error screen), but
a value it doesn't know (an enum value, a colour token such as `blue` on a
version 1 host) is only invalid: the prop takes its default and the host
logs a warning. So a bundle that must also run on older hosts checks
`hostVersion()` and draws without the newer nodes, props and values there.
App fragments are versioned by their app (their nodes and props are the
app's contract with its own hosts).

### Not in the set (and why)

- **Other font designs** (SF Rounded, monospaced): both hosts measure and
  draw one bundled font (Inter, below) so frames agree; `tabular` covers
  fixed-width digits. A second design needs a second bundled font.
- **Italic, underline, strikethrough, text shadow**: no italic in the
  bundled font; the others aren't used on glanceable watch screens.
- **Shadows**: invisible on the watch's black OLED background.
- **Gradients**: no clean, host-identical form yet (stops, angles and
  colour-space interpolation differ between CSS and SwiftUI).
- **Animations / transitions**: frames and paint change per commit; an
  implicit animation would make the drawn state differ from the committed
  one. A bundle can animate with timers.
- **Per-side border widths, dashed borders**: a hairline separator is a
  1-point `view`.
- **Pickers, sliders, steppers, segmented controls, text input as nodes**:
  composed from buttons, `crown` and `progress` (above); text input is
  the system's dictation sheet, not a layout element.
- **Not yet**: paging / horizontal scrolling, indeterminate spinners,
  accessibility labels, a transform origin, an explicit progress bar
  direction and arc sweep, the crown's turn-ended event, the always-on
  (luminance reduced) state, a bundle-declared required version, an SF
  Symbol fallback name.

### App fragments (the extension point)

An app adds its own schema fragment, same shape plus:

- `extends: { <core type>: { props, groups } }` — props on existing types;
- `nodes` — new node types, native views the app registers on each host;
- `colors`, `groups`.

Names may not collide with the core or other fragments. Generate the app's
files with

```
node codegen/codegen.mjs --fragment app.json --ts app-jsx.d.ts --swift AppNodeProps.swift --js app-props.js
```

The Swift file imports `SolidWatch` and adds `<Name>…Props` structs and a
`<Name>Schema` table (`nodes`, `extends`, `colors`); the
`.d.ts` augments `solid-watch/jsx`. The browser harness loads fragments from
`SOLID_WATCH_FRAGMENTS`.

### Generated Swift (`Sources/SolidWatch/Generated/NodeProps.swift`)

`PropValue` (JSON-shaped), `Dimension`, a typed struct per prop group
(`LayoutProps`, `BoxProps`, `TextStyleProps`, `TextLayoutProps`, and one
per node's own props: `ScrollProps`, `ButtonProps`, `ToggleProps`,
`ProgressProps`, `IconProps`, `ImageProps`, `HapticProps`, `CrownProps`)
with defaults
and `mutating set(_ name:, _ value:) -> PropSetResult` (`.unknown` if not
its prop, `.invalid` resets to default), an enum per enum prop,
`CoreSchema.nodes` (`NodeSpec`/`PropSpec`: kind, type, group, inherits),
`CoreSchema.colors`, and the font, fit and Yoga constants. Run
`test/swift-typecheck.sh` with any Swift 6 toolchain.

## Layout

Yoga **3.2.1** (the `yoga-layout` npm version), default config (no web
defaults, no errata) with **`pointScaleFactor` 2**. No baseline functions and
no `YGNodeSetNodeType(Text)` on either host, so `alignItems: "baseline"` uses
Yoga's default baseline (a leaf's bottom edge). Root: width and height = ctx,
`calculateLayout(undefined, undefined, LTR)`. Frames are relative to the
parent's Yoga node.

Prop → Yoga: `display`, `position` (`relative`/`absolute`), `top/right/bottom/left` →
position edges, `width/height/min*/max*`, `aspectRatio`, `flex`,
`flexGrow`, `flexShrink`, `flexBasis`, `flexDirection`, `flexWrap`,
`justifyContent`, `alignItems`, `alignSelf`, `alignContent`; `margin` →
`Edge.All`, `marginHorizontal`/`Vertical` → `Edge.Horizontal`/`Vertical`,
`marginTop…Left` → that edge (same for `padding`); `borderWidth` → border
`Edge.All`; `gap`/`rowGap`/`columnGap` → `Gutter.All`/`Row`/`Column`;
`overflow`; `boxSizing`. An unset prop is applied as its schema default
(`null` = Yoga undefined). `scroll` always gets `overflow: scroll`.

**Scroll content height** = max over its Yoga children of (top + height +
bottom margin), plus its bottom padding and bottom border, at least its own
height.

**Leaves with a natural size** (Yoga measure functions, both hosts): a text
leaf (below), an `icon` (`size` x `size`), a `toggle` (40 x 24). An
`image` has none (give it a size); `progress` is a container (its children
size it, or give it a size). `haptic` and `crown` have no Yoga node.
`rotate`, `scale` and a pressed button's `pressedScale` are drawing only:
frames are unrotated and unscaled.

## Text measurement

Implemented once in `browser/text-layout.js`; a host supplies only a
`lines(runs, scale, maxWidth) → { lines, widest }` measurer (every font size,
explicit line height and letter spacing × `scale`; letter spacing is added
after every character, as CSS `letter-spacing` and Core Text's kern do; wrap at `maxWidth`, `Infinity` = no
wrapping; `"\n"` always breaks).

A **text leaf** (the outermost `<text>`) is a Yoga leaf with a measure
function. Its runs: each raw string with the style of its nearest `<text>`.

```
measure(runs, leaf, maxWidth):          maxWidth = Infinity when Yoga's width mode is Undefined
  if no runs or all empty: return 0 x 0
  F = leaf.fontSize
  scale = leaf.minScale < 1 ? fitScale(...) : 1
  if leaf.minScale < 1 or leaf.numberOfLines == 1:   single line
    widest = lines(runs, scale, Infinity).widest; lines = 1
  else
    { lines, widest } = lines(runs, scale, maxWidth)
    if numberOfLines > 0: lines = min(lines, numberOfLines)
  width  = min(widest, maxWidth)
  height = lines x lineHeight        lineHeight = max over runs of (run.lineHeight ?? run.fontSize x ratio) x scale
```

Line-height ratio: 3408 / 2816 = 1.2102272727272727 (the font's hhea/typo/win
metrics agree: ascent 2728, descent 680, gap 0, 2816 units/em).

### Shrink-to-fit (`minScale`)

`minScale < 1` makes the text single-line and shrinks it to fit its width:

```
fitScale(runs, F, minScale, maxWidth):
  if maxWidth is Infinity or minScale >= 1: return 1
  if width(F) <= maxWidth + 0.001: return 1
  for k = 1, 2, ... while F - 0.5k > F x minScale:
    if width(F - 0.5k) <= maxWidth + 0.001: return (F - 0.5k) / F
  return minScale
width(size) = lines(runs, size / F, Infinity).widest
```

i.e. the largest size on the 0.5 pt grid below F that fits, else
F × minScale. A host may search faster but must return the same size. Text
that still doesn't fit is cut with a tail ellipsis.

**Drawn size.** Yoga may measure a leaf several times and cache, so after
layout each host re-runs `measure` with the leaf's **final content width**
(frame width − horizontal padding − horizontal border) and draws at that
`fontSize` and line count (the fixtures' `text` entries).

## Behaviour

- **button**: on a tap, if `onPress` is set, `dispatch(tag, "press", null)`.
  With `onLongPress`, holding it 0.5 s dispatches `longPress` (null) at
  once, and the release that ends that hold is not a press. `disabled`
  ignores both. Pressed: its content at `pressedOpacity` (0.6), the whole
  button at `pressedScale` and on `pressedBackground` when set; disabled:
  content × 0.35. A confirm step, if an app wants one, is the app's own UI
  (a button that appears, e.g. `test/bundles/timers`), or a long press.
- **button, held**: with `onPressIn` / `onPressOut` a bundle sees the touch
  itself (React Native's Pressable events): `pressIn` (null) when a touch
  goes down on a button that is not disabled, and exactly one `pressOut`
  (null) after each `pressIn`, when that touch ends however it ends: lifted,
  slid off the button, cancelled (a scroll view or the system took the
  touch), the button disabled, or the button gone from the screen (removed,
  hidden behind another screen, its bundle replaced: a press begun in one
  bundle never sends its `pressOut` to the next). Each is sent only when its
  handler is set at that moment; with both unset a button behaves exactly as
  before. They come alongside `press` and `longPress`, which keep their
  rules (a lift both ends the press, `pressOut`, and taps it, `press`; the
  browser host sends `pressOut` first, the watch in SwiftUI's order, so
  don't depend on it). On the watch they follow the SwiftUI `Button`'s own
  pressed state (its style's `isPressed`, the pressed look's): no gesture
  of their own, so taps, long presses and scrolling are unchanged; sliding
  back onto the button can press it again (another `pressIn`, then its
  `pressOut`). In the browser host: pointer-down, then pointer-up, -cancel
  or -leave (`test/bundles/hold`). A bundle that drives something for as
  long as a button is held starts on `pressIn` and stops on `pressOut`, and
  does not stop on a timer instead.
- **toggle**: a tap, if `onChange` is set and it is not disabled,
  dispatches `change` with `!value`; without `onChange` the tap goes to
  whatever is under it (an enclosing button). Drawn in its content box: a
  capsule track (`activeTrackColor` / `inactiveTrackColor`) and a `thumbColor` knob of
  diameter height − 4, 2 points in from the left (off) or the right (on)
  (`Controls.toggleKnob`). Disabled: the drawing × 0.35 (not its box paint).
- **progress**: `value` clamped to 0…1 (NaN = 0). bar: a capsule over the
  content box filled from the left (a square box too), or from the bottom
  when taller than wide; the fill is a rectangle `value` × the length,
  clipped to the capsule (a small value is a sliver with a round end).
  ring: the largest centred square's circle, stroked `thickness` inside it
  (`Controls.ringGeometry`; at most half the square), filled clockwise from
  12 o'clock; arc: 270° of it from the lower left, open at the bottom.
  Round ends; a value of 0 draws only the track.
- **icon**: `Image(systemName:)` at font size `size` and `weight`, centred
  in the content box, unclipped. Its natural size (size × size) is a
  layout box, not the symbol's own bounds: a wide symbol can draw past it
  (leave room with a margin or a larger width). No name, or one the watch
  lacks (symbols vary by watchOS version), draws nothing, but the box paint
  still draws. The browser host has no SF Symbols: it draws a dashed
  placeholder of the same size, so a preview shows where icons are, not
  what they look like.
- **image**: only `data:image/png;base64,…` and `data:image/jpeg;base64,…`
  (valid base64) draw; anything else draws nothing on both hosts. Its own
  size is its pixel size / 2 points; `Controls.imageRect` places it in the
  content box per `resizeMode` (React Native's), clipped to the box.
  `tintColor` draws its alpha as a mask in that colour.
- **crown**: the last attached `crown` in tree order takes the Digital
  Crown (on the watch the root view becomes focusable with
  `digitalCrownRotation`; scroll views no longer get it; the root's views
  are rebuilt when a crown is first attached or the last one goes, so a
  tree without one is drawn exactly as before crowns existed). Its
  position is put at `value` when it is attached and whenever `value`
  changes (controlled, above); putting it there sends nothing. Turning moves it (each of min and max
  bounds it on its own; with both and `wrap`, it wraps), and whenever
  `Controls.crownValue` of the position differs from the last value sent,
  the host dispatches `change` with it. (How far a turn moves an unbounded
  continuous crown is SwiftUI's; it has not been measured on a watch.) `crownValue`: with `wrap` (and
  min < max) into [min, max); else clamped to [min, max]; with `increment`,
  snapped to min (or 0) + k × increment, staying inside the range; rounded to
  1e-9. The browser host turns it with the mouse wheel over the screen
  (one notch = one increment, or a 50th of the range, or 1, × 0.5/1/2 for the
  sensitivity) and `DomHost.turnCrown(notches)`. Frames records name it
  (`crown: tag`) while one is attached.
- **haptic**: plays `pattern` (watchOS `WKHapticType` names) at each commit
  where `trigger` differs from its value at the previous commit; the initial
  value doesn't play; `null` never plays.

## Golden mutation logs (`fixtures/mutations/<name>/`)

| file | content |
|---|---|
| `bundle.js` | the bundle |
| `bundle.js.sha256` | `<sha256 hex>  bundle.js` (sha256sum format) |
| `script.json` | `{ ctx, steps }`; a step is `{ "state": any }`, `{ "stateHex": "0201ff" }` (delivered as a `Uint8Array`), `{ "dispatch": { tag, name, payload } }` or `{ "wait": ms }`. The driver's clock (which the bundle's `Date` reads): T0 = 1 000 000 at mount; state or dispatch step *i* at T0 + 1000 × (*i* + 1) unless it sets `localMs`, never earlier than the clock already is; a wait moves it on by `ms`. Before each step the timers due by its time fire in due order (then by id), each at its due time; a delay under 1 ms counts as 1 ms |
| `log.jsonl` | the mutation log, one JSON array per line, recorded under **qjs** (quickjs-ng v0.17.0); node must produce the identical log |
| `frames.jsonl` | after each `commit`, one line: `{ commit, frames: { tag: [x, y, w, h] }, text: { tag: { fontSize, lines } }, content: { scrollTag: height }, haptics: [{ tag, pattern }], crown?: tag }` with the stub measurer (`crown` only while a `crown` is attached) |

Log lines: `["createNode", tag, type]`, `["createText", tag, s]`,
`["setProp", tag, key, value]`, `["insert", parent, child, before]`,
`["remove", parent, child]`, `["commit"]`, `["setTimer", id, ms]`,
`["clearTimer", id]`, `["send", [bytes]]`, and driver markers
`["#mount", rootTag, ctx]`, `["#state", stepIndex, clockMs]`,
`["#dispatch", tag, name, payload]`, `["#handled", bool]`,
`["#timer", id, clockMs]`, `["#wait", ms, clockMs]`, `["#error", message]`.
`release` calls are **not** in the logs (their timing is the engine's GC);
compare logs without them. The Swift `ScriptRunner` is the same driver.

The drivers drain the engine's jobs after every call, as a host does, so
work Solid finishes in a microtask is in the log right after its call (a
second `commit`; for a dispatch, before `#handled`). `test/driver.js` is a
generator that yields after each call: node drains the vm context's own job
queue (`microtaskMode: "afterEvaluate"` and an empty evaluation), the qjs
runner resumes it from a timer (qjs runs every job before a timer; the
runner uses no top-level await, under which qjs polls timers between jobs).

A host test can (a) run `bundle.js` with a recording host through
`script.json` and compare with `log.jsonl`, and (b) apply `log.jsonl` to its
shadow tree and compare with `frames.jsonl`. The Swift tests also run an
app's own fixtures (same layout) from `SOLID_WATCH_APP_FIXTURES`
(`:`-separated directories).

## Layout-parity fixtures (`fixtures/layout/<case>.json`)

`{ name, viewport, pointScaleFactor: 2, measure: "stub", log, expected: { frames, text, content } }`.
Apply `log` (same format as above), commit once, compare. Frames are exact
(multiples of 0.5 pt).

**Stub measurer**: every character (code point) is (0.6 × fontSize +
letterSpacing) × scale wide; line height ratio 1.25; wrapping is greedy by character (a character
that would pass `maxWidth + 0.001` starts a new line; a line holds at least
one); `"\n"` breaks.

## Font

`fonts/Inter-roman.ttf`: Inter 3.19, roman, variable `wght` 100–900, with
`tnum` (tabular figures) and the glyphs the watch uses (U+2212 minus, °, …).
Chosen because it is OFL, built for small screens, has tabular figures, and
its single `wght` axis (no optical-size axis) keeps advance widths linear in
the font size, which the shrink-to-fit grid relies on. Both hosts load this
file (web font / registered with Core Text); `fontWeight` drives `wght`
(`normal` 400, `bold` 700). Font parity between hosts is checked by hand: the
same strings measured in the harness and Core Text, within 0.5 pt.

## Development

Everything runs in a container with node ≥ 20 (no host installs).

```
npm ci
node codegen/codegen.mjs            # after editing the schema
QJS=/path/to/qjs sh test/all.sh     # codegen check, build test bundles, fixtures (qjs vs node), tests, boundary, examples
npm run dev                         # harness on :5180, open /browser/
                                    # /browser/?bundle=events&selftest=taps&n=30: tap self-test
```

Taps in the DOM host: a press must never repaint the element under the
pointer (the browser then drops or retargets the click), so pressing only
changes the button's opacity and text is re-rendered only when its content
changes. The tap self-test hit-tests each JS-handled button's centre and
holds 40–160 ms across repaints; it reports
`dispatched/tried` in the log and `window.__selftest`.

`test/build-qjs.sh <quickjs-ng checkout at v0.17.0> <out>` builds `qjs`
(e.g. `sh test/build-qjs.sh "$PWD/quickjs-ng" /tmp/qjs` with the submodule)
without cmake. `test/boundary.mjs` fails on any path that leaves this
directory, so it can be split out on its own.

## Repository

Public at [github.com/esensible/solid-watch](https://github.com/esensible/solid-watch),
exported from the monorepo it is developed in (a `git subtree split` of
this directory, by `tools/publish.sh`): changes are made there, not in the
public repository, and each export fast-forwards it. A clone needs the
engine's sources for the tests and the framework:
`git submodule update --init`.

`tools/publish.sh` (in a dev container with git, node, a C compiler and
ssh) splits, checks the split on its own outside the monorepo (`npm ci`,
qjs built from the submodule, `CHECK_CLEAN=1 sh test/all.sh`; `swift build`
too where Xcode is found, else `swift test` by hand on the Mac) and shows
whether each public branch fast-forwards; `--push <branch>` then pushes,
fast-forward only.
