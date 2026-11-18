// Checklist: a scroll of rows, each with a toggle; a progress bar of done /
// total; a "Clear done" button that removes the ticked rows. Ticking a row
// "saves" it (a stand-in for a round trip to a phone or a device: a timer
// that settles after 600 ms, and every third save fails). The row flips at
// once; if its save fails it flips back and a short message says so. A host
// may replace the list with a state { items: ["…", …] }.
//
// Solid 2 features it shows:
// - createStore: the list is one store of plain rows ({ id, label, done }),
//   written through its draft setter; no signal per row;
// - createOptimisticStore over that store: the rows on screen. A write to it
//   shows at once and reverts by itself when the save it belongs to is over:
//   kept if the save wrote the store too, gone if it failed;
// - action(function* …): the save as one transaction; writes after `yield`
//   land with it, and a throw (the failed save) discards them;
// - createOptimistic(false): the "Saving…" flag, the same kind of guess;
// - createProjection: the done / total counts as a derived store;
// - <Show> for the empty state and <For> over the store's rows.
// Watch nodes: a toggle row is a <button> whose <toggle> has no onChange, so
// it only draws `value` (controls are controlled); <progress> as a bar.
import { createStore, createOptimisticStore, createProjection, createOptimistic, createSignal,
         action, For, Show } from "solid-js";
import { createApp } from "solid-watch";

let nextId = 1;
const row = (label) => ({ id: nextId++, label, done: false });

// The truth: what has been saved.
const [items, setItems] = createStore(
  ["Water the plants", "Take out recycling", "Pay the power bill", "Call the dentist", "Buy milk", "Stretch for 10 min", "Back up photos"].map(row),
);
// What the screen shows: the store, plus any guesses still in flight. The
// function re-derives it from `items` (rows matched by `id`, so each keeps
// its identity and <For> keeps its node).
const [shown, setShown] = createOptimisticStore(() => items.map((i) => ({ ...i })), []);
const [saving, setSaving] = createOptimistic(false);
const [message, setMessage] = createSignal("");

// Derived store: re-computed when a `done` it read changes.
const counts = createProjection((d) => {
  d.total = shown.length;
  d.done = shown.filter((i) => i.done).length;
}, { total: 0, done: 0 });

// The pretend round trip: the watch has no network of its own; a real app
// would hand the change to its host (send()) and settle on the answer.
let saves = 0;
const save = () => new Promise((ok, fail) => {
  const n = ++saves;
  setTimeout(() => (n % 3 === 0 ? fail(new Error("Not saved, try again")) : ok()), 600);
});

const toggle = action(function* (id) {
  setShown((s) => { const i = s.find((r) => r.id === id); i.done = !i.done; }); // the guess
  setSaving(true);
  yield save(); // throws here if the save fails: the guess reverts, nothing below runs
  setItems((s) => { const i = s.find((r) => r.id === id); i.done = !i.done; }); // the truth
});

let hide = 0;
function press(id) {
  toggle(id).catch((e) => {
    setMessage(e.message);
    clearTimeout(hide);
    hide = setTimeout(() => setMessage(""), 2000);
  });
}
const clearDone = () => setItems((s) => s.filter((i) => !i.done));

function Row(props) {
  return (
    <button flexDirection="row" alignItems="center" gap={8} minHeight={44} paddingHorizontal={10} paddingVertical={6}
            borderRadius={12} background="gray6" pressedBackground="gray5" pressedOpacity={1}
            onPress={() => press(props.item.id)}>
      <text flexGrow={1} flexShrink={1} fontSize={15} numberOfLines={2} color={props.item.done ? "gray" : "white"}>{props.item.label}</text>
      <toggle value={props.item.done} activeTrackColor="green" />
    </button>
  );
}

function App() {
  return (
    <view flexGrow={1} paddingHorizontal={4} gap={6}>
      <view gap={4} paddingHorizontal={4}>
        <view flexDirection="row" justifyContent="space-between" alignItems="baseline">
          <text fontSize={15} fontWeight="700" color="orange">{saving() ? "Saving…" : "Today"}</text>
          <text fontSize={13} color="gray" tabular>{`${counts.done} / ${counts.total}`}</text>
        </view>
        <progress height={6} value={counts.total ? counts.done / counts.total : 0} color="green" trackColor="gray5" />
        <Show when={message()}>
          <text fontSize={12} color="red">{message()}</text>
        </Show>
      </view>

      <scroll flexGrow={1} flexShrink={1}>
        <view gap={4} paddingBottom={4}>
          <Show when={shown.length > 0}
                fallback={
                  <view alignItems="center" gap={6} paddingTop={20}>
                    <icon name="checkmark.seal.fill" size={36} color="green" />
                    <text fontSize={15} color="gray">All clear</text>
                  </view>
                }>
            <For each={shown}>{(it) => <Row item={it} />}</For>
            <button height={38} marginTop={4} borderRadius={999} alignItems="center" justifyContent="center"
                    background="#FF9F0A33" disabled={items.every((i) => !i.done)} onPress={clearDone}>
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
    if (s && Array.isArray(s.items)) setItems(() => s.items.map(String).map(row));
  },
});
