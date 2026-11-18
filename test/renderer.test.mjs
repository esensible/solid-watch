// Renderer behaviour, from the test bundles run in node with the recording host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ROOT, runNode } from "./lib.mjs";

const load = (name) => {
  const dir = ROOT + `fixtures/mutations/${name}/`;
  const src = readFileSync(dir + "bundle.js", "utf8");
  const script = JSON.parse(readFileSync(ROOT + `test/bundles/${name}/script.json`, "utf8"));
  return runNode(src, script).map((l) => JSON.parse(l));
};

// Split a log into segments starting at each driver marker (#mount, #state,
// #dispatch, #timer, #wait).
const MARKERS = new Set(["#mount", "#state", "#dispatch", "#timer", "#wait"]);
function segments(log) {
  const out = [];
  for (const m of log) {
    if (MARKERS.has(m[0])) out.push({ marker: m, ops: [] });
    else if (out.length) out[out.length - 1].ops.push(m);
  }
  return out;
}
const ops = (seg) => seg.ops.filter((m) => !m[0].startsWith("#"));
const names = (seg) => ops(seg).map((m) => m[0]);

test("every mount, state, handled dispatch and timer ends in exactly one commit; a wait has none", () => {
  for (const name of ["basic", "show", "list", "events", "timers"]) {
    for (const seg of segments(load(name))) {
      if (seg.marker[0] === "#wait") {
        assert.deepEqual(seg.ops, [], `${name}: nothing happens at the end of a wait`);
        continue;
      }
      const handled = seg.ops.find((m) => m[0] === "#handled");
      const commits = names(seg).filter((n) => n === "commit").length;
      if (handled && handled[1] === false) assert.equal(commits, 0, `${name} ${JSON.stringify(seg.marker)}`);
      else {
        assert.equal(commits, 1, `${name} ${JSON.stringify(seg.marker)}`);
        assert.equal(names(seg).at(-1), "commit", `${name}: commit is last`);
      }
    }
  }
});

test("mount builds the tree detached, then attaches it to the root once", () => {
  const [mount] = segments(load("basic"));
  const toRoot = ops(mount).filter((m) => m[0] === "insert" && m[1] === 1);
  assert.equal(toRoot.length, 1);
  assert.deepEqual(ops(mount).at(-2), toRoot[0]);
});

test("text: raw strings and spans; a changed value is one setProp on the text node", () => {
  const segs = segments(load("basic"));
  const mount = ops(segs[0]);
  // "Count ", the span with the number, " items"
  assert.deepEqual(mount.filter((m) => m[0] === "createText").map((m) => m[2]).sort(), [" items", "0", "Count "]);
  // the span (the second <text>) is inserted into the outer <text>, between the raw strings
  const [outer, span] = mount.filter((m) => m[0] === "createNode" && m[2] === "text").map((m) => m[1]);
  const into = mount.filter((m) => m[0] === "insert" && m[1] === outer).map((m) => m[2]);
  const textTag = (s) => mount.find((m) => m[0] === "createText" && m[2] === s)[1];
  assert.deepEqual(into, [textTag("Count "), span, textTag(" items")]);
  const numberTag = mount.find((m) => m[0] === "createText" && m[2] === "0")[1];
  assert.ok(ops(segs[1]).some((m) => m[0] === "setProp" && m[1] === numberTag && m[2] === "text" && m[3] === "1"));
  // the same state again: nothing but the commit
  assert.deepEqual(ops(segs[2]), [["commit"]]);
  // a prop back to its default is sent as null
  const back = ops(segs[3]).find((m) => m[2] === "background");
  assert.deepEqual(back.slice(2), ["background", null]);
});

test("updates are fine-grained: no node created, inserted or removed for a value change", () => {
  const segs = segments(load("basic"));
  for (const seg of segs.slice(1)) {
    for (const n of names(seg)) assert.ok(n === "setProp" || n === "commit", n);
  }
});

test("<Show>: switching branches removes one subtree and inserts the other", () => {
  const segs = segments(load("show"));
  const mount = ops(segs[0]);
  const offText = mount.find((m) => m[0] === "createText" && m[2] === "off");
  assert.ok(offText, "fallback rendered at mount");
  const on = ops(segs[1]);
  assert.ok(on.some((m) => m[0] === "remove"), "fallback removed");
  assert.ok(on.some((m) => m[0] === "createNode" && m[2] === "text"));
  // the extra box replaces the ternary's empty placeholder text (remove it,
  // insert the box where it was: it was last); the label beside "on " in the
  // shown branch is a raw text among siblings, which Solid 2's universal
  // renderer replaces with a new text node (README: Text updates)
  const seg2 = ops(segs[2]);
  const [, , placeholder] = seg2.find((m) => m[0] === "remove" && m[1] === 2);
  assert.ok(mount.some((m) => m[0] === "createText" && m[1] === placeholder && m[2] === ""));
  const box = seg2.find((m) => m[0] === "createNode" && m[2] === "view")[1];
  assert.ok(seg2.some((m) => m[0] === "insert" && m[1] === 2 && m[2] === box && m[3] === 0));
  const b = seg2.find((m) => m[0] === "createText" && m[2] === "b")[1];
  assert.ok(seg2.some((m) => m[0] === "insert" && m[2] === b));
  assert.equal(seg2.filter((m) => m[0] === "remove").length, 2, "the placeholder and the old label");
  const off = ops(segs[3]);
  assert.ok(off.some((m) => m[0] === "remove"));
  assert.ok(off.some((m) => m[0] === "createText" && m[2] === "off"));
  // the ternary that goes back to null removes the box
  const noExtra = ops(segs[4]);
  assert.ok(noExtra.some((m) => m[0] === "remove"));
});

test("<Show>: placeholder text nodes are empty, so raw-text checks allow them", () => {
  const log = load("show");
  for (const m of log) if (m[0] === "createText" && !["off", "on ", "a", "b", "c", "tail"].includes(m[2])) assert.equal(m[2], "");
  assert.ok(!log.some((m) => m[0] === "#error"));
});

test("<For>: reorder is a move (insert of an attached node), additions insert before an anchor, removals remove", () => {
  const segs = segments(load("list"));
  const reorder = ops(segs[2]); // [1,2,3] -> [3,1,2]
  assert.deepEqual(reorder.map((m) => m[0]), ["insert", "commit"]);
  const [, parent, child, before] = reorder[0];
  assert.ok(before !== 0, "moved before an anchor");
  const created = ops(segs[1]).filter((m) => m[0] === "createNode").map((m) => m[1]);
  assert.ok(created.includes(child) && created.includes(before));
  const add = ops(segs[3]); // insert 4 between 3 and 1
  assert.equal(add.filter((m) => m[0] === "createNode").length, 1);
  assert.equal(add.filter((m) => m[0] === "insert" && m[1] === parent).length, 1);
  const rm = ops(segs[4]); // [3,4,1,2] -> [4,2]
  assert.deepEqual(rm.map((m) => m[0]), ["remove", "remove", "commit"]);
  const empty = ops(segs[5]);
  assert.deepEqual(empty.map((m) => m[0]), ["remove", "remove", "commit"]);
});

test("events: the host sees onPress as true/null; dispatch runs the handler with its payload", () => {
  const log = load("events");
  const set = log.filter((m) => m[0] === "setProp" && m[2] === "onPress");
  assert.deepEqual(set.map((m) => m[3]), [true, null, true]);
  assert.ok(!log.some((m) => m[0] === "setProp" && typeof m[3] === "object" && m[3] !== null && m[2] === "onPress"));
  const segs = segments(log);
  const d1 = segs.find((s) => s.marker[0] === "#dispatch");
  assert.ok(ops(d1).some((m) => m[2] === "text" && m[3] === "1"));
  const d2 = segs.filter((s) => s.marker[0] === "#dispatch")[1];
  assert.ok(ops(d2).some((m) => m[2] === "text" && m[3] === "11"), "payload reached the handler (big -> +10)");
  const handled = log.filter((m) => m[0] === "#handled").map((m) => m[1]);
  assert.deepEqual(handled, [true, true, false, false]); // unknown tag; handler removed
});

test("events: onPressIn / onPressOut reach the host as true/null and dispatch as pressIn / pressOut", () => {
  const log = load("hold");
  const set = (k) => log.filter((m) => m[0] === "setProp" && m[1] === 3 && m[2] === k).map((m) => m[3]);
  assert.deepEqual(set("onPressIn"), [true, null, true]);
  assert.deepEqual(set("onPressOut"), [true, null, true]);
  assert.deepEqual(log.filter((m) => m[0] === "setProp" && m[1] === 5 && /^onPress/.test(m[2])).map((m) => [m[2], m[3]]), [["onPressOut", true]]);
  const handled = log.filter((m) => m[0] === "#handled").map((m) => m[1]);
  // in, out, in; the out after the handlers went finds none; the out-only button's in is no event, its out is
  assert.deepEqual(handled, [true, true, true, false, false, true]);
  const texts = log.filter((m) => m[0] === "setProp" && m[2] === "text").map((m) => m[3]);
  assert.deepEqual(texts, ["Held", "in 1 out 0", "Hold", "in 1 out 1", "Held", "in 2 out 1", "in 2 out 101"]);
  assert.deepEqual(log.filter((m) => m[0] === "setProp" && m[1] === 3 && m[2] === "background").map((m) => m[3]), ["gray5", "green", "gray5", "green"]);
});

test("events: disabled and the haptic trigger go to the host as plain props", () => {
  const log = load("events");
  assert.deepEqual(log.filter((m) => m[2] === "disabled").map((m) => m[3]), [false, true, false]);
  assert.deepEqual(log.filter((m) => m[2] === "trigger").map((m) => m[3]), [0, 1, 11]);
});

test("raw text outside <text> fails at mount with a clear error", () => {
  const log = load("bad-text");
  const err = log.find((m) => m[0] === "#error");
  assert.ok(err);
  assert.match(err[1], /must be inside <text>/);
});

// ---- batching and commits (README: Batching and commits) ----------------------

test("a call's writes, the effects they run and the writes those make all land in its one commit", () => {
  // timers: a state sets `start`; the effect's apply half starts the countdown
  // loop, whose first tick writes the countdown text: all before the commit
  const segs = segments(load("timers"));
  const first = segs.find((s) => s.marker[0] === "#state");
  assert.deepEqual(names(first), ["setTimer", "setProp", "commit"]);
  assert.equal(ops(first)[1][3], "01:05");
});

test("async: work Solid finishes after the call gets a commit of its own, before the next call", () => {
  const segs = segments(load("async"));
  for (const seg of segs) assert.equal(names(seg).at(-1), "commit", `${JSON.stringify(seg.marker)}: everything committed`);
  // mount: the call commits the fallback; the value lands in a commit of its own
  const [mount] = segs;
  const commitAt = names(mount).indexOf("commit");
  const call = ops(mount).slice(0, commitAt), late = ops(mount).slice(commitAt + 1);
  assert.ok(call.some((m) => m[0] === "createText" && m[2] === "wait"));
  assert.deepEqual(late.map((m) => m[0]), ["createText", "insert", "remove", "insert", "commit"]);
  assert.equal(late[0][2], "2");
  // a state that makes the value pending holds the whole update (Solid 2's
  // transitions): the call's commit changes nothing attached; the label and
  // the value land together when the value resolves
  const [, s0, s1, s2] = segs;
  assert.deepEqual(names(s0), ["createText", "commit", "setProp", "remove", "insert", "commit"]);
  assert.deepEqual(ops(s0)[0].slice(2), ["2"], "the label's new text, created but not yet inserted");
  assert.deepEqual(ops(s0)[2].slice(2), ["text", "4"]);
  // the same state again: no work, one commit
  assert.deepEqual(names(s1), ["commit"]);
  assert.equal(names(s2).filter((n) => n === "commit").length, 2);
});

/**
 * A bundle in a vm realm on a recording host, driven by hand: call(fn) runs
 * fn(__app) and then drains the realm's jobs, as a host does after each call.
 */
function live(name) {
  const log = [];
  const rec = (...a) => log.push(a);
  let next = 2;
  const host = {
    createNode(type) { const t = next++; rec("createNode", t, type); return t; },
    createText(s) { const t = next++; rec("createText", t, s); return t; },
    setProp(tag, k, v) { rec("setProp", tag, k, v); },
    insert(p, c, b) { rec("insert", p, c, b); },
    remove(p, c) { rec("remove", p, c); },
    commit() { rec("commit"); },
    setTimer() {}, clearTimer() {}, send() {}, release() {}, log() {},
  };
  const console = { log() {}, info() {}, warn() {}, error: (m) => rec("#console.error", String(m)) };
  const ctx = vm.createContext({ __host: host, console }, { microtaskMode: "afterEvaluate" });
  vm.runInContext("globalThis.queueMicrotask = (f) => { Promise.resolve().then(f); };", ctx);
  vm.runInContext(readFileSync(ROOT + `fixtures/mutations/${name}/bundle.js`, "utf8"), ctx, { filename: "bundle.js" });
  const call = (fn) => {
    try {
      return fn(ctx.__app);
    } finally {
      vm.runInContext("", ctx);
    }
  };
  return { log, call };
}
const thrown = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("did not throw");
};

test("errors: a handler that throws fails its call (no commit); the app goes on", () => {
  const { log, call } = live("errors");
  call((app) => app.mount(1, { width: 198, height: 242 }));
  const [, label] = log.find((m) => m[0] === "createText" && m[2] === "0");
  const buttons = log.filter((m) => m[0] === "createNode" && m[2] === "button").map((m) => m[1]);
  log.length = 0;
  assert.equal(thrown(() => call((app) => app.dispatch(buttons[1], "press", null))).message, "handler threw");
  assert.deepEqual(log, []);
  call((app) => app.dispatch(buttons[0], "press", null));
  assert.deepEqual(log, [["setProp", label, "text", "1"], ["commit"]]);
});

test("a call made from a handler (into __app.onState) does not commit: the outermost call commits once", () => {
  const segs = segments(load("edges"));
  const press = segs.find((s) => s.marker[0] === "#dispatch");
  // the dispatch's one commit, then the async value its state started, in a commit of its own
  const handledAt = press.ops.findIndex((m) => m[0] === "#handled");
  const before = press.ops.slice(0, handledAt).map((m) => m[0]);
  assert.equal(before[0], "commit", "the call's own commit first");
  assert.equal(before.filter((n) => n === "commit").length, 2, "and the late one; no extra commit from the inner call");
});

test("an async value whose render throws after its call fails a job: the host gets the error", () => {
  const segs = segments(load("edges"));
  const last = segs.at(-1);
  assert.deepEqual(last.marker.slice(0, 2), ["#state", 2]);
  assert.deepEqual(last.ops.map((m) => m[0]), ["commit", "#error"]);
  assert.equal(last.ops[1][1], "late render threw");
});

test("errors: a handler that writes and then throws fails its call; what it applied is in the next commit", () => {
  const { log, call } = live("edges");
  call((app) => app.mount(1, { width: 198, height: 242 }));
  const [, label] = log.find((m) => m[0] === "createText" && m[2] === "0");
  const buttons = log.filter((m) => m[0] === "createNode" && m[2] === "button").map((m) => m[1]);
  log.length = 0;
  assert.equal(thrown(() => call((app) => app.dispatch(buttons[1], "press", null))).message, "after write");
  assert.deepEqual(log, [["setProp", label, "text", "1"]], "applied, not committed");
  log.length = 0;
  call((app) => app.onState({ k: 0 }));
  assert.deepEqual(log, [["commit"]]);
});

test("errors: rendering that throws fails its call (no commit) and halts Solid's reactivity", () => {
  // the golden log: the second press makes the label throw
  const segs = segments(load("errors"));
  const err = segs.at(-1).ops.find((m) => m[0] === "#error");
  assert.equal(err[1], "cannot show 2");
  assert.ok(!names(segs.at(-1)).includes("commit"));
  // by hand, past the error: Solid 2 halts on an error no boundary caught
  // (console.error "[REACTIVITY_HALTED]"); later calls change nothing (the
  // Swift session shows the error and makes no more calls)
  const { log, call } = live("errors");
  call((app) => app.mount(1, { width: 198, height: 242 }));
  call((app) => app.onState({ n: 1 }));
  log.length = 0;
  assert.equal(thrown(() => call((app) => app.onState({ n: 2 }))).message, "cannot show 2");
  assert.ok(log.some((m) => m[0] === "#console.error" && m[1] === "[REACTIVITY_HALTED]"), JSON.stringify(log));
  assert.ok(!log.some((m) => m[0] === "commit"));
  log.length = 0;
  call((app) => app.onState({ n: 0 }));
  assert.deepEqual(log.filter((m) => m[0] !== "#console.error"), [["commit"]]);
});
