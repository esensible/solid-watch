// Gauge: the Digital Crown sets a level from 0 to 100, drawn as a ring with
// the number in its middle, coloured by band (green, then yellow from 60,
// red from 85) with an icon for the band; a strip below shows the three
// bands and which one the level is in. Reset puts it back to 0.
//
// What it shows of the API:
// - <crown> is controlled: it reports each new value with onChange and the
//   bundle sets `value` (so Reset moves the crown too); `increment` snaps it
//   to whole numbers with a detent click each;
// - a <progress shape="ring"> with children: they are drawn over the ring
//   and laid out inside it like any box's;
// - derived values (createMemo) for the band, its colour and its icon;
// - a <haptic> whose trigger is the band: it plays when the band changes.
import { createSignal, createMemo, For } from "solid-js";
import { createApp } from "solid-watch";

const BANDS = [
  { name: "Low", from: 0, to: 60, color: "green", icon: "checkmark.circle.fill" },
  { name: "High", from: 60, to: 85, color: "yellow", icon: "exclamationmark.triangle.fill" },
  { name: "Max", from: 85, to: 100, color: "red", icon: "xmark.octagon.fill" },
];

const [level, setLevel] = createSignal(0);
const band = createMemo(() => BANDS.find((b) => level() < b.to) ?? BANDS[BANDS.length - 1]);

function App() {
  return (
    <view flexGrow={1} alignItems="center" justifyContent="space-between" paddingHorizontal={8} paddingBottom={4}>
      <crown value={level()} min={0} max={100} increment={1} onChange={setLevel} />

      <progress shape="ring" width={112} height={112} thickness={11} value={level() / 100}
                color={band().color} trackColor="gray5" alignItems="center" justifyContent="center" gap={1}>
        <icon name={band().icon} size={16} color={band().color} />
        <text fontSize={38} fontWeight="700" tabular>{String(Math.round(level()))}</text>
        <text fontSize={11} color="gray" letterSpacing={1.5}>{band().name.toUpperCase()}</text>
      </progress>

      {/* The bands, as wide as their share of the range; the current one lit. */}
      <view flexDirection="row" gap={3} alignSelf="stretch" height={6}>
        <For each={BANDS}>
          {(b) => (
            <view flexGrow={b.to - b.from} flexBasis={0} borderRadius={3} background={b.color}
                  opacity={b === band() ? 1 : 0.3} />
          )}
        </For>
      </view>

      <button alignSelf="stretch" height={34} borderRadius={999} background="gray5" alignItems="center" justifyContent="center" disabled={level() === 0}
              onPress={() => setLevel(0)}>
        <text fontSize={15} fontWeight="600">Reset</text>
      </button>

      <haptic pattern="notification" trigger={band().name} />
    </view>
  );
}

createApp(App);
