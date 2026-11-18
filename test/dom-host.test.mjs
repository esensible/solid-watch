// The browser host's error reports (browser/dom-host.js _guard): a bundle
// evaluated in a realm of its own (as the harness's iframe) gets the host's
// Errors from another realm. Solid 2 passes them on unchanged (Solid 1
// wrapped a non-`instanceof Error` value as "Unknown error"), so the page
// reports the host's own error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ROOT } from "./lib.mjs";
import { DomHost } from "../browser/dom-host.js";

/** The basic test bundle in a vm realm, on a host (this realm) that refuses minScale. */
function realm() {
  let tag = 1;
  const host = {
    createNode: () => ++tag, createText: () => ++tag, insert() {}, remove() {}, commit() {},
    setTimer() {}, clearTimer() {}, send() {}, release() {}, log() {},
    setProp(t, k) { if (k === "minScale") throw new Error("<text> has no prop minScale"); },
  };
  const ctx = vm.createContext({ __host: host, queueMicrotask });
  vm.runInContext(readFileSync(ROOT + "fixtures/mutations/basic/bundle.js", "utf8"), ctx, { filename: "bundle.js" });
  return ctx;
}

test("a host error thrown across realms reaches the host unchanged", () => {
  const ctx = realm();
  let e;
  try { ctx.__app.mount(1, { width: 198, height: 242 }); } catch (x) { e = x; }
  assert.ok(e instanceof Error, "this realm's Error");
  assert.equal(e.message, "<text> has no prop minScale");
});

test("DomHost reports the host's own error for a call the bundle threw from", () => {
  const ctx = realm();
  const events = [];
  DomHost.prototype._guard.call({ onEvent: (kind, d) => events.push([kind, d.error.message]) }, () => ctx.__app.mount(1, { width: 198, height: 242 }));
  assert.deepEqual(events, [["error", "<text> has no prop minScale"]]);
});

// A button's pointer handling (browser/dom-host.js _wireButton) on a stand-in
// element: what it dispatches for each pointer sequence (README: Behaviour).
function wired(props) {
  const listeners = {};
  const el = { dataset: {}, addEventListener: (k, fn) => ((listeners[k] ||= []).push(fn)) };
  const sent = [];
  const host = { _paintBox() {}, dispatch: (tag, name) => sent.push(name) };
  DomHost.prototype._wireButton.call(host, el, { tag: 3, props });
  const fire = (k) => (listeners[k] || []).forEach((fn) => fn({ stopPropagation() {} }));
  return { el, sent, fire };
}

test("button: pressIn on pointer-down, pressOut on lift (before the press), cancel or leave; once each", () => {
  const all = { onPress: true, onPressIn: true, onPressOut: true };
  let b = wired(all);
  b.fire("pointerdown"); b.fire("pointerup"); b.fire("click");
  assert.deepEqual(b.sent, ["pressIn", "pressOut", "press"]);
  for (const end of ["pointercancel", "pointerleave"]) {
    b = wired(all);
    b.fire("pointerdown"); b.fire(end); b.fire("pointerup");
    assert.deepEqual(b.sent, ["pressIn", "pressOut"], end);
  }
  b = wired({ ...all, disabled: true });
  b.fire("pointerdown"); b.fire("pointerup"); b.fire("click");
  assert.deepEqual(b.sent, [], "disabled: nothing");
  b = wired({ onPressOut: true });
  b.fire("pointerdown"); b.fire("pointerup");
  assert.deepEqual(b.sent, ["pressOut"], "only the handlers that are set");
  b = wired({ onPress: true });
  b.fire("pointerdown"); b.fire("pointerup"); b.fire("click");
  assert.deepEqual(b.sent, ["press"], "a plain button as before");
});

test("button: a press that ends without a lift (disabled, gone) sends its pressOut after the commit, once", async () => {
  const b = wired({ onPressIn: true, onPressOut: true });
  b.fire("pointerdown");
  b.el._endPress();
  b.el._endPress();
  assert.deepEqual(b.sent, ["pressIn"], "not inside the paint");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(b.sent, ["pressIn", "pressOut"]);
  b.fire("pointerup");
  assert.deepEqual(b.sent, ["pressIn", "pressOut"], "the lift after it is no second pressOut");
});
