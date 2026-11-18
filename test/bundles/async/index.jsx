// Work Solid 2 finishes after the call into the app returned: an async memo
// (its value a promise that settles in a microtask) shown under <Loading>.
// The host gets those changes with a commit of their own, made from the
// job queue (README: Batching and commits).
import { createMemo, createSignal, Loading } from "solid-js";
import { createApp } from "solid-watch";

const [n, setN] = createSignal(1);
// resolves a job later: the host runs it right after the call
const doubled = createMemo(async () => {
  const v = n();
  await null;
  return v * 2;
});

function App() {
  return (
    <view gap={2}>
      <text>n {n()}</text>
      <Loading fallback={<text>wait</text>}>
        <text>{doubled()}</text>
      </Loading>
    </view>
  );
}

createApp(App, { onState: (s) => setN(s.n) });
