// Press in / press out (README: Behaviour): a button held while pressed
// (onPressIn / onPressOut, drawn held from the bundle's own state), its
// handlers removed while it is pressed (the pressOut that follows finds no
// handler), and a button with onPressOut only (its pressIn is no event).
import { createSignal } from "solid-js";
import { createApp } from "solid-watch";

const [held, setHeld] = createSignal(false);
const [ins, setIns] = createSignal(0);
const [outs, setOuts] = createSignal(0);
const [armed, setArmed] = createSignal(true);

function App() {
  return (
    <view gap={4} padding={4}>
      <button
        onPressIn={armed() ? () => { setHeld(true); setIns(ins() + 1); } : undefined}
        onPressOut={armed() ? () => { setHeld(false); setOuts(outs() + 1); } : undefined}
        height={40}
        background={held() ? "green" : "gray5"}
        borderRadius={10}
        justifyContent="center"
        alignItems="center"
      >
        <text>{held() ? "Held" : "Hold"}</text>
      </button>
      <button onPressOut={() => setOuts(outs() + 100)} height={32} justifyContent="center" alignItems="center">
        <text>Out only</text>
      </button>
      <text tabular>{`in ${ins()} out ${outs()}`}</text>
    </view>
  );
}

createApp(App, {
  onState(s) {
    setArmed(s.armed);
  },
});
