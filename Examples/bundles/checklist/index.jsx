// Checklist: a scroll of rows, each with a toggle; a progress bar of done /
// total; a "Clear done" button that removes the ticked rows. The list lives
// in the bundle; a host may replace it with a state { items: ["…", …] }.
//
// What it shows of the API:
// - a toggle row: the whole row is a <button>; its <toggle> has no onChange,
//   so it only draws `value` and the tap goes to the row (controls are
//   controlled: the bundle's signal is the truth);
// - one signal per row for its `done`, so ticking a row changes that row's
//   toggle and the counts, and nothing is re-created;
// - <progress> as a bar, and <Show> for the empty state.
import { createSignal, createMemo, For, Show } from "solid-js";
import { createApp } from "solid-watch";

let nextId = 1;
function item(label) {
  const [done, setDone] = createSignal(false);
  return { id: nextId++, label, done, setDone };
}

const [items, setItems] = createSignal(
  ["Water the plants", "Take out recycling", "Pay the power bill", "Call the dentist", "Buy milk", "Stretch for 10 min", "Back up photos"].map(item),
);
const doneCount = createMemo(() => items().filter((i) => i.done()).length);

const clearDone = () => setItems(items().filter((i) => !i.done()));

function Row(props) {
  const it = props.item;
  return (
    <button flexDirection="row" alignItems="center" gap={8} minHeight={44} paddingHorizontal={10} paddingVertical={6}
            borderRadius={12} background="gray6" pressedBackground="gray5" pressedOpacity={1}
            onPress={() => it.setDone(!it.done())}>
      <text flexGrow={1} flexShrink={1} fontSize={15} numberOfLines={2} color={it.done() ? "gray" : "white"}>{it.label}</text>
      <toggle value={it.done()} activeTrackColor="green" />
    </button>
  );
}

function App() {
  return (
    <view flexGrow={1} paddingHorizontal={4} gap={6}>
      <view gap={4} paddingHorizontal={4}>
        <view flexDirection="row" justifyContent="space-between" alignItems="baseline">
          <text fontSize={15} fontWeight="700" color="orange">Today</text>
          <text fontSize={13} color="gray" tabular>{`${doneCount()} / ${items().length}`}</text>
        </view>
        <progress height={6} value={items().length ? doneCount() / items().length : 0} color="green" trackColor="gray5" />
      </view>

      <scroll flexGrow={1} flexShrink={1}>
        <view gap={4} paddingBottom={4}>
          <Show when={items().length > 0}
                fallback={
                  <view alignItems="center" gap={6} paddingTop={20}>
                    <icon name="checkmark.seal.fill" size={36} color="green" />
                    <text fontSize={15} color="gray">All clear</text>
                  </view>
                }>
            <For each={items()}>{(it) => <Row item={it} />}</For>
            <button height={38} marginTop={4} borderRadius={999} alignItems="center" justifyContent="center"
                    background="#FF9F0A33" disabled={doneCount() === 0} onPress={clearDone}>
              <text fontSize={15} fontWeight="600" color="orange">Clear done</text>
            </button>
          </Show>
        </view>
      </scroll>
    </view>
  );
}

createApp(App, {
  onState(s) {
    if (s && Array.isArray(s.items)) setItems(s.items.map(String).map(item));
  },
});
