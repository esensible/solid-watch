// Errors reach the host as the call's error: a handler that throws (the
// app goes on), and a value that makes rendering throw (Solid 2 then halts
// its reactivity: nothing updates after it).
import { createSignal } from "solid-js";
import { createApp } from "solid-watch";

const [n, setN] = createSignal(0);
const label = () => {
  if (n() === 2) throw new Error("cannot show 2");
  return String(n());
};

function App() {
  return (
    <view gap={2}>
      <button onPress={() => setN(n() + 1)} height={32}>
        <text>{label()}</text>
      </button>
      <button onPress={() => { throw new Error("handler threw"); }} height={32} />
    </view>
  );
}

createApp(App, { onState: (s) => setN(s.n) });
