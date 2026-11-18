// Stopwatch: Start/Stop and Lap buttons, the elapsed time in tabular figures,
// a scrolling list of laps (newest first), and a long press on the time to
// reset it.
//
// What it shows of the API:
// - time is the bundle's own business: Date.now() is the host's clock and
//   setInterval runs on the host's timers, so the bundle keeps its own state
//   (when it started, what it had banked) and only re-renders on a tick;
// - createEffect(compute, apply) (Solid 2): the interval exists only while
//   running() is true; the apply half's return value is its cleanup;
// - a <button> is any box with an onPress (and onLongPress), styled with box
//   props; a <haptic> plays when its trigger changes.
import { createSignal, createMemo, createEffect, For } from "solid-js";
import { createApp } from "solid-watch";

const [running, setRunning] = createSignal(false);
const [startedAt, setStartedAt] = createSignal(0); // Date.now() when last started
const [banked, setBanked] = createSignal(0); // ms accumulated before that start
const [now, setNow] = createSignal(Date.now());
const [laps, setLaps] = createSignal([]); // [{ n, split, total }], newest first

// Elapsed ms: what was banked, plus the current run while running.
const elapsed = createMemo(() => banked() + (running() ? now() - startedAt() : 0));

// Re-render ten times a second, only while running.
createEffect(running, (on) => {
  if (!on) return;
  const id = setInterval(() => setNow(Date.now()), 100);
  return () => clearInterval(id);
});

const pad2 = (n) => String(n).padStart(2, "0");
// 0:05.3, 12:34.5, 1:02:03.4
function format(ms) {
  const tenths = Math.floor(ms / 100) % 10;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const head = h > 0 ? `${h}:${pad2(m)}` : String(m);
  return `${head}:${pad2(s % 60)}.${tenths}`;
}

function startStop() {
  const t = Date.now();
  setNow(t);
  if (running()) {
    setBanked(banked() + (t - startedAt()));
    setRunning(false);
  } else {
    setStartedAt(t);
    setRunning(true);
  }
}

function lap() {
  setNow(Date.now());
  const total = elapsed();
  const prev = laps().length ? laps()[0].total : 0;
  setLaps([{ n: laps().length + 1, split: total - prev, total }, ...laps()]);
}

function reset() {
  if (running()) return; // stop first: a reset while running would be a surprise
  setBanked(0);
  setLaps([]);
}

// One component for both round buttons: a tinted capsule with a label. (Its
// props are passed one by one, not spread: every prop that reaches a node
// must be one the schema has for it.)
const RoundButton = (props) => (
  <button flexGrow={1} flexBasis={0} height={40} borderRadius={999} alignItems="center" justifyContent="center"
          pressedScale={0.95} background={props.background} disabled={props.disabled} onPress={props.onPress}>
    <text fontSize={17} fontWeight="600" color={props.color}>{props.label}</text>
  </button>
);

function App() {
  return (
    <view flexGrow={1} paddingHorizontal={6} paddingBottom={4} gap={6}>
      {/* The readout is a button only for its long press. */}
      <button onLongPress={reset} alignItems="center" paddingVertical={2} pressedOpacity={0.8}>
        <text fontSize={44} fontWeight="600" tabular minScale={0.6} color={running() ? "white" : "gray"}>
          {format(elapsed())}
        </text>
        <text fontSize={12} color="gray">
          {running() ? "running" : elapsed() > 0 ? "hold to reset" : "ready"}
        </text>
      </button>

      <view flexDirection="row" gap={6}>
        <RoundButton label="Lap" onPress={lap} disabled={!running()} background="gray5" color="white" />
        <RoundButton label={running() ? "Stop" : "Start"} onPress={startStop}
                     background={running() ? "#FF453A40" : "#30D15840"} color={running() ? "red" : "green"} />
      </view>

      <scroll flexGrow={1} flexShrink={1}>
        <view gap={2}>
          {/* <For> (keyed, the default) hands each row its item as is; a new
              lap is one row inserted at the top, the others stay. */}
          <For each={laps()} fallback={<text fontSize={13} color="gray" textAlign="center" marginTop={6}>No laps yet</text>}>
            {(l) => (
              <view flexDirection="row" alignItems="center" height={28} paddingHorizontal={8} borderRadius={8} background="gray6">
                <text fontSize={14} color="gray" width={52}>{`Lap ${l.n}`}</text>
                <text fontSize={15} fontWeight="500" tabular flexGrow={1} textAlign="right">{format(l.split)}</text>
              </view>
            )}
          </For>
        </view>
      </scroll>

      <haptic pattern="click" trigger={laps().length} />
    </view>
  );
}

createApp(App);
