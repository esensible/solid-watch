// Solid 2 universal renderer (@solidjs/universal) that drives a native host
// through `globalThis.__host` (README: Host interface). The host owns the real
// nodes (props, Yoga layout, views) and knows them only by integer tag. This
// side keeps the tree bookkeeping Solid needs (parent / first child / next
// sibling) in small JS objects, and the JS event handlers by tag.
//
// When mutations reach the host (README: Batching and commits): Solid 2
// batches every write and applies it when its queue is flushed. Each call
// into the app (mount, onState, dispatch, timer) runs inside flush(fn), so
// everything that call causes (render effects, then user effects, and
// whatever they write in turn) is applied before it returns, and then the
// renderer commits once. Work Solid finishes later, in a microtask (async
// computations, actions), mutates the host outside any call; the renderer
// then commits it itself, in a microtask of its own after Solid's.
import { flush } from "solid-js";
import { createRenderer } from "@solidjs/universal";

const host = () => globalThis.__host;

// JS event handlers live on their Node (node.handlers: { eventName: fn });
// dispatch finds the node by tag through a weak reference, so a handler
// that closes over its own node (a ref) does not keep it alive: the node and
// its handlers are collected together. tag -> WeakRef(node).
const byTag = new Map();
const weak = typeof WeakRef === "function" ? (n) => new WeakRef(n) : (n) => ({ deref: () => n });

// Host nodes live as long as their JS Node object: once the engine collects
// it (nothing in JS can reach it, so Solid can never re-insert it), the host
// is told to free the tag. Callbacks run as engine jobs after a GC, outside
// any batch; they are not part of the golden logs (timing is the engine's).
const released = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry((tag) => {
      byTag.delete(tag);
      const h = host();
      if (h && h.release) h.release(tag);
    })
  : null;
const track = (node) => {
  if (released) released.register(node, node.tag);
  return node;
};

// ---- commits ----------------------------------------------------------------
// `calls`: how deep we are in calls into the app (a handler may call into
// another entry point, e.g. a test calling __app.onState from a handler).
// `dirty`: the host's tree changed since the last commit.
let calls = 0;
let dirty = false;
let lateQueued = false;
// An error that escaped every boundary while Solid flushed: Solid halts its
// reactivity and hands the error to globalThis.reportError (when there is
// one) rather than throw it, e.g. when an async value lands in a promise
// reaction and its render throws. Here it fails the call it happened in or,
// outside any call, a job of its own (the host's job queue then fails, as
// for any job that throws), so the host learns of it either way.
let reported = null;
// Set by the first report: a late commit due after it would show the
// half-applied update the error interrupted, so there is none.
let failed = false;
globalThis.reportError = function reportError(e) {
  failed = true;
  if (calls > 0) {
    if (reported === null) reported = { e };
  } else {
    queueMicrotask(() => {
      throw e;
    });
  }
};
function commit() {
  dirty = false;
  host().commit();
}
// A tree change outside any call (Solid flushing in a microtask) is committed
// by a microtask queued behind the one making it: by then that flush is done.
function changed() {
  dirty = true;
  if (calls === 0 && !lateQueued) {
    lateQueued = true;
    queueMicrotask(() => {
      lateQueued = false;
      if (dirty && calls === 0 && !failed) commit();
    });
  }
}
/**
 * Runs `fn` as one call into the app: inside flush(fn) (so its writes and
 * everything they cause are applied before it returns), then one commit. A
 * call made from inside another (a handler calling __app.onState) does not
 * commit: the outermost call does, once. If `fn` throws (or Solid reported an
 * error while flushing), nothing is committed and the error goes to the
 * host; what the call had already applied is in the next commit.
 */
function call(fn) {
  calls++;
  let out;
  try {
    out = flush(fn);
  } catch (e) {
    // Solid's report is the cause when there is one (the error thrown may
    // be the same, or one that followed from it)
    if (calls === 1 && reported !== null) {
      const r = reported.e;
      reported = null;
      throw r;
    }
    throw e;
  } finally {
    calls--;
  }
  if (calls > 0) return out;
  if (reported !== null) {
    const { e } = reported;
    reported = null;
    throw e;
  }
  commit();
  return out;
}

class Node {
  constructor(tag, type, text) {
    this.tag = tag;
    this.type = type; // "#text" for raw text
    this.text = text; // raw text only
    this.parent = null;
    this.first = null;
    this.last = null;
    this.prev = null;
    this.next = null;
    this.handlers = null; // { eventName: fn } once one is set
  }
}

/** Wrap a node the host created (the root it passes to mount). */
export function wrapHostNode(tag, type = "#root") {
  return new Node(tag, type);
}

function unlink(parent, node) {
  if (node.prev) node.prev.next = node.next;
  else parent.first = node.next;
  if (node.next) node.next.prev = node.prev;
  else parent.last = node.prev;
  node.parent = node.prev = node.next = null;
}

// Raw strings are only valid inside <text>. Solid itself inserts empty text
// nodes as placeholders (sentinels, e.g. where a <Show> renders nothing); the
// host ignores raw text outside <text>, so only a non-empty one is an error.
function checkText(parent, node) {
  if (parent && node.type === "#text" && parent.type !== "text" && node.text !== "") {
    throw new Error(`raw text ${JSON.stringify(node.text)} must be inside <text>, not <${parent.type.replace("#", "")}>`);
  }
}

/** "onPress" -> "press" */
const eventName = (prop) => prop.charAt(2).toLowerCase() + prop.slice(3);

function setProperty(node, name, value) {
  if (value === undefined) value = null;
  if (/^on[A-Z]/.test(name)) {
    // Event prop: the handler stays here; the host only learns that one is set.
    let h = node.handlers;
    const ev = eventName(name);
    if (typeof value === "function") {
      if (!h) {
        h = node.handlers = {};
        byTag.set(node.tag, weak(node));
      }
      const had = !!h[ev];
      h[ev] = value;
      if (!had) {
        host().setProp(node.tag, name, true);
        changed();
      }
    } else if (h && h[ev]) {
      delete h[ev];
      host().setProp(node.tag, name, null);
      changed();
    }
    return;
  }
  host().setProp(node.tag, name, value);
  changed();
}

export const {
  render,
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  applyRef,
  ref,
} = createRenderer({
  // The compiler hands an element's literal props over with it (staticProps):
  // they are set right after the node is created, as any other prop.
  createElement(type, staticProps) {
    const node = track(new Node(host().createNode(type), type));
    if (staticProps) for (const name in staticProps) setProperty(node, name, staticProps[name]);
    return node;
  },
  createTextNode(value) {
    const s = String(value);
    return track(new Node(host().createText(s), "#text", s));
  },
  replaceText(node, value) {
    node.text = String(value);
    checkText(node.parent, node);
    host().setProp(node.tag, "text", node.text);
    changed();
  },
  isTextNode(node) {
    return node.type === "#text";
  },
  setProperty,
  insertNode(parent, node, anchor) {
    // Inserting an attached node moves it (the host does the same).
    if (node.parent) unlink(node.parent, node);
    checkText(parent, node);
    node.parent = parent;
    if (anchor) {
      node.prev = anchor.prev;
      node.next = anchor;
      if (anchor.prev) anchor.prev.next = node;
      else parent.first = node;
      anchor.prev = node;
    } else {
      node.prev = parent.last;
      if (parent.last) parent.last.next = node;
      else parent.first = node;
      parent.last = node;
    }
    host().insert(parent.tag, node.tag, anchor ? anchor.tag : 0);
    changed();
  },
  removeNode(parent, node) {
    unlink(parent, node);
    host().remove(parent.tag, node.tag);
    changed();
  },
  getParentNode(node) {
    return node.parent;
  },
  getFirstChild(node) {
    return node.first;
  },
  getNextSibling(node) {
    return node.next;
  },
});

// ---- timers (README: Timers) ------------------------------------------------
// setTimeout / setInterval for the bundle, on the host's timers: the host
// arms one native timer per id and calls __app.timer(id) when it is due,
// which runs the callback as a call into the app (flushed, then one commit).
// Installed as globals, so app code and libraries use the standard names.
// The clock (Date) is the host's own and is left alone.
const timers = new Map(); // id -> { fn, args, every }
let nextTimer = 1;
const delayOf = (ms) => {
  const d = Number(ms);
  return d > 0 ? d : 0;
};
function arm(fn, ms, args, repeat) {
  if (typeof fn !== "function") throw new TypeError("setTimeout/setInterval: a function is required");
  const id = nextTimer++;
  const d = delayOf(ms);
  timers.set(id, { fn, args, every: repeat ? d : null });
  host().setTimer(id, d);
  return id;
}
export function setTimeout(fn, ms, ...args) {
  return arm(fn, ms, args, false);
}
export function setInterval(fn, ms, ...args) {
  return arm(fn, ms, args, true);
}
export function clearTimeout(id) {
  if (timers.delete(id)) host().clearTimer(id);
}
export const clearInterval = clearTimeout;
globalThis.setTimeout = setTimeout;
globalThis.setInterval = setInterval;
globalThis.clearTimeout = clearTimeout;
globalThis.clearInterval = clearInterval;

/**
 * Hands `bytes` (a Uint8Array or an array of byte values) to the app's
 * native side, which decides what to do with them (e.g. write them to a
 * device). The host gets a plain array of numbers.
 */
export function send(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i] & 255);
  host().send(out);
}

/**
 * The contract version of the host running the bundle (README: Contract
 * version): `__host.version`, or 1 for a host from before it was set. A
 * bundle that uses node types or props added in a later version can check
 * it and draw without them on an older host (which refuses them).
 */
export function hostVersion() {
  const h = host();
  const v = h && h.version;
  return typeof v === "number" && v >= 1 ? v : 1;
}

/**
 * Define the bundle's entry point: sets and returns `globalThis.__app`.
 *
 *   createApp(Root, { onState(state) { ...set signals... } })
 *
 * Each entry point is one call into the app: it runs inside Solid's
 * flush(fn), so all it causes is applied before the call returns, then one
 * commit (README: Batching and commits).
 *
 * - mount(rootTag, ctx): renders <Root {...ctx} /> into the host's root, then
 *   one commit. ctx = { width, height } in points. Mounting again disposes
 *   the previous tree first (its nodes are removed from the root).
 * - onState(state): runs `onState(state)`, then one commit. `state` is
 *   whatever the app delivers (bytes, an object); the package doesn't look.
 * - dispatch(tag, name, payload): runs the JS handler for event `name` on
 *   `tag` (e.g. "press" for onPress), then one commit. Returns false (and
 *   doesn't commit) if there is no handler.
 * - timer(id): a timer the bundle set is due: runs its callback, then one
 *   commit (an interval is re-armed first). Returns false (and doesn't
 *   commit) for a timer that was cleared.
 */
export function createApp(Root, { onState } = {}) {
  let dispose = null;
  const app = {
    mount(rootTag, ctx = {}) {
      call(() => {
        if (dispose) {
          const d = dispose;
          dispose = null;
          d();
        }
        dispose = render(() => createComponent(Root, ctx), wrapHostNode(rootTag));
      });
    },
    onState(state) {
      call(() => {
        if (onState) onState(state);
      });
    },
    dispatch(tag, name, payload) {
      const ref = byTag.get(tag);
      const node = ref && ref.deref();
      const h = node && node.handlers;
      const fn = h && h[name];
      if (!fn) return false;
      call(() => {
        fn(payload);
      });
      return true;
    },
    timer(id) {
      const t = timers.get(id);
      if (!t) return false;
      if (t.every === null) timers.delete(id);
      else host().setTimer(id, t.every);
      call(() => {
        t.fn(...t.args);
      });
      return true;
    },
  };
  globalThis.__app = app;
  return app;
}
