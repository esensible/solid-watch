// Edge cases of calls and commits: a handler that calls into another entry
// point (one commit, the outermost call's); a handler that writes and then
// throws (its call fails; what it applied is in the next commit); an async
// value that lands after its call and whose render throws (the error fails a
// job of its own, so the host learns of it).
import { createMemo, createSignal, Loading } from "solid-js";
import { createApp } from "solid-watch";

const [n, setN] = createSignal(0);
const [k, setK] = createSignal(0);
const late = createMemo(async () => {
  const v = k();
  await null;
  return v;
});
const shown = () => {
  const v = late();
  if (v === 3) throw new Error("late render threw");
  return String(v);
};

function App() {
  return (
    <view gap={2}>
      <text>{String(n())}</text>
      <button height={20} onPress={() => {
        setN(n() + 1);
        globalThis.__app.onState({ k: 1 });
        setN(n() + 1);
      }} />
      <button height={20} onPress={() => {
        setN(n() + 1);
        throw new Error("after write");
      }} />
      <Loading fallback={<text>wait</text>}>
        <text>{shown()}</text>
      </Loading>
    </view>
  );
}

createApp(App, { onState: (s) => setK(s.k) });
