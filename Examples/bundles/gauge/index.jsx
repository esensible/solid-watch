// Gauge: the Digital Crown sets a level from 0 to 100, drawn as a ring with
// the number in its middle, coloured by band with an icon for the band; a
// strip below shows the bands and which one the level is in. The band table
// is loaded: "Wide" (yellow from 60, red from 85) or "Tight" (40, 70), picked
// with the second button. Reset puts the level back to 0.
//
// The watch has no fetch: a bundle has timers, Date and what its host hands
// it (onState). So the table's source here is a promise the bundle makes
// itself, a timer that settles after 500 ms, and every third load fails. A
// real app would resolve it from a state its host delivers; the source does
// not matter, the primitives do.
//
// Solid 2 features it shows (Solid 2 has no createAsync, Suspense or
// ErrorBoundary: async lives in computations, and the boundaries are
// <Loading> and <Errored>):
// - an async computation: createDeferred(() => loadBands(profile())) returns
//   a promise; until the first table lands its readers wait. After that it
//   lags but never leads: a reload keeps the last table and holds nothing
//   else. (A plain async createMemo would hold the profile write, and with it
//   every write its readers share: the crown's level would freeze until the
//   table landed.)
// - <Loading>: its fallback is drawn until the first table lands;
// - isPending: while a new table is in flight the ring is dimmed;
// - <Errored>: a failed load shows the error and a Retry button (the stale
//   table never masks the error); reset() asks again, the last table comes
//   back dimmed, then the new one.
// Watch nodes: <crown> is controlled (onChange reports, `value` sets, so
// Reset moves it too; `increment` snaps to whole numbers with a detent);
// <progress shape="ring"> with children drawn inside the ring; a <haptic>
// that plays when its trigger (the band) changes.
import { createSignal, createMemo, createDeferred, isPending, Loading, Errored, For } from "solid-js";
import { createApp } from "solid-watch";

const PROFILES = { Wide: [60, 85], Tight: [40, 70] };
const table = ([high, max]) => [
  { name: "Low", from: 0, to: high, color: "green", icon: "checkmark.circle.fill" },
  { name: "High", from: high, to: max, color: "yellow", icon: "exclamationmark.triangle.fill" },
  { name: "Max", from: max, to: 100, color: "red", icon: "xmark.octagon.fill" },
];

let loads = 0;
const loadBands = (profile) => new Promise((ok, fail) => {
  const n = ++loads;
  setTimeout(() => (n % 3 === 0 ? fail(new Error("Table unavailable")) : ok(table(PROFILES[profile]))), 500);
});

const [level, setLevel] = createSignal(0);
const [profile, setProfile] = createSignal("Wide");

// Everything that needs the table, created under the boundaries that catch
// its first wait (<Loading>) and its failures (<Errored>).
function Dial() {
  const bands = createDeferred(() => loadBands(profile()));
  const band = createMemo(() => bands().find((b) => level() < b.to) ?? bands()[bands().length - 1]);
  return (
    <>
      <progress shape="ring" width={112} height={112} thickness={11} value={level() / 100}
                opacity={isPending(() => bands()) ? 0.4 : 1}
                color={band().color} trackColor="gray5" alignItems="center" justifyContent="center" gap={1}>
        <icon name={band().icon} size={16} color={band().color} />
        <text fontSize={38} fontWeight="700" tabular>{String(Math.round(level()))}</text>
        <text fontSize={11} color="gray" letterSpacing={1.5}>{band().name.toUpperCase()}</text>
      </progress>

      {/* The bands, as wide as their share of the range; the current one lit. */}
      <view flexDirection="row" gap={3} alignSelf="stretch" height={6}>
        <For each={bands()}>
          {(b) => <view flexGrow={b.to - b.from} flexBasis={0} borderRadius={3} background={b.color}
                        opacity={b === band() ? 1 : 0.3} />}
        </For>
      </view>

      <haptic pattern="notification" trigger={band().name} />
    </>
  );
}

const Pill = (props) => (
  <button flexGrow={1} flexBasis={0} height={34} borderRadius={999} background="gray5" alignItems="center"
          justifyContent="center" disabled={props.disabled} onPress={props.onPress}>
    <text fontSize={15} fontWeight="600">{props.label}</text>
  </button>
);

const Placeholder = (props) => (
  <view height={124} alignSelf="stretch" alignItems="center" justifyContent="center" gap={6}>{props.children}</view>
);

function App() {
  return (
    <view flexGrow={1} alignItems="center" justifyContent="space-between" paddingHorizontal={8} paddingBottom={4}>
      <crown value={level()} min={0} max={100} increment={1} onChange={setLevel} />

      <Errored fallback={(err, reset) => (
        <Placeholder>
          <icon name="exclamationmark.triangle.fill" size={22} color="orange" />
          <text fontSize={13} color="gray">{err().message}</text>
          <button height={30} paddingHorizontal={16} borderRadius={999} background="#FF9F0A33" justifyContent="center"
                  onPress={reset}>
            <text fontSize={14} fontWeight="600" color="orange">Retry</text>
          </button>
        </Placeholder>
      )}>
        <Loading fallback={<Placeholder><text fontSize={13} color="gray">Loading bands…</text></Placeholder>}>
          <Dial />
        </Loading>
      </Errored>

      <view flexDirection="row" gap={6} alignSelf="stretch">
        <Pill label="Reset" disabled={level() === 0} onPress={() => setLevel(0)} />
        <Pill label={profile()} onPress={() => setProfile((p) => (p === "Wide" ? "Tight" : "Wide"))} />
      </view>
    </view>
  );
}

createApp(App);
