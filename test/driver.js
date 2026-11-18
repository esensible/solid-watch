// Recording host + script driver, shared by the node tests and the qjs runner.
// A plain script (no modules): evaluating it defines globalThis.__swDriver.
//
//   __swDriver(evalBundle, script) -> iterator; its return value is the log
//
// evalBundle(): evaluates the bundle (which sets globalThis.__app).
// script: { ctx: {width, height}, steps: [step, ...] }, step one of
//   { "state": <any JSON> }          __app.onState(value)
//   { "stateHex": "0201ff" }         __app.onState(Uint8Array of those bytes)
//   { "dispatch": { "tag": n, "name": "press", "payload": {...} } }
//   { "wait": ms }                   let ms pass (timers fall due)
//
// A real host runs the engine's pending jobs (promise reactions,
// queueMicrotask) after every call into JS, before it does anything else
// (README: Host interface). The driver can't run them itself, so it is a
// generator that yields after each call (the bundle's evaluation, mount, each
// state, dispatch and timer): the runner drains the job queue completely,
// then resumes it. A job that throws stops the run with "#error", as it
// fails the call on the Swift host. Run it with
//
//   const it = __swDriver(evalBundle, script);
//   let r;
//   while (!(r = it.next()).done) drainJobs();
//   r.value  // the log lines
//
// The driver is the host here, so it owns the clock, a fixed one: Date and
// Date.now() read it. It reads T0 = 1 000 000 at mount; state and dispatch
// step i happen at T0 + 1000 * (i + 1) (or the step's "localMs"), never
// earlier than the clock already is; a wait moves it on by its ms. Before a
// step's time the timers due by then fire, in due order (then set order),
// each at its due time: ["#timer", id, dueMs] and __app.timer(id). A delay
// under 1 ms counts as 1 ms, so time moves on between firings.
//
// Each line is one JSON array (README: Golden mutation logs). release(tag)
// calls are not logged (their timing is the engine's GC); they collect in
// globalThis.__swReleased.
(function (g) {
  var T0 = 1000000;
  // __host.version: schema/nodes.json's contract version (test/schema.test.mjs holds it there)
  var HOST_VERSION = 3;
  function hexBytes(h) {
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
    return b;
  }
  const RealDate = g.Date;
  let now = T0;
  // Date on the driver's clock: no arguments = now; anything else as usual.
  function FixedDate(...a) {
    if (!(this instanceof FixedDate)) return new RealDate(now).toString();
    return a.length ? new RealDate(...a) : new RealDate(now);
  }
  FixedDate.prototype = RealDate.prototype;
  FixedDate.now = () => now;
  FixedDate.UTC = RealDate.UTC;
  FixedDate.parse = RealDate.parse;
  g.Date = FixedDate;

  // queueMicrotask through the driver, so a job that throws is seen: the
  // engine's own when it has one (quickjs-ng, browsers), else a promise
  // reaction (a node vm context has no queueMicrotask).
  const realQueue = typeof g.queueMicrotask === "function" ? g.queueMicrotask.bind(g) : (f) => { Promise.resolve().then(f); };
  let jobError = null;
  g.queueMicrotask = function queueMicrotask(f) {
    if (typeof f !== "function") throw new TypeError("queueMicrotask: a function is required");
    realQueue(() => {
      try {
        f();
      } catch (e) {
        if (jobError === null) jobError = e;
      }
    });
  };
  const message = (e) => String(e && e.message !== undefined ? e.message : e);

  g.__swDriver = function* run(evalBundle, script) {
    const lines = [];
    const rec = (...a) => lines.push(JSON.stringify(a));
    let next = 2; // tag 1 is the root
    const timers = new Map(); // id -> due
    now = T0;
    jobError = null;
    g.__host = {
      version: HOST_VERSION,
      createNode(type) { const t = next++; rec("createNode", t, type); return t; },
      createText(s) { const t = next++; rec("createText", t, s); return t; },
      setProp(tag, k, v) { rec("setProp", tag, k, v === undefined ? null : v); },
      insert(parent, child, before) { rec("insert", parent, child, before); },
      remove(parent, child) { rec("remove", parent, child); },
      commit() { rec("commit"); },
      setTimer(id, ms) { rec("setTimer", id, ms); timers.set(id, now + Math.max(ms, 1)); },
      clearTimer(id) { rec("clearTimer", id); timers.delete(id); },
      send(bytes) { rec("send", bytes); },
      release(tag) { g.__swReleased.push(tag); },
    };
    g.__swReleased = [];
    let app = null;
    // After a call into JS: the runner drains the jobs; one that threw ends
    // the run as an error of that call.
    function* jobs() {
      yield;
      if (jobError !== null) {
        const e = jobError;
        jobError = null;
        throw e;
      }
    }
    // Fire the timers due by `t`, in order, then set the clock to `t`.
    const advance = function* (t) {
      for (;;) {
        let id = null, due = Infinity;
        for (const [i, d] of timers) if (d < due || (d === due && i < id)) { id = i; due = d; }
        if (id === null || due > t) break;
        timers.delete(id);
        if (due > now) now = due;
        rec("#timer", id, now);
        app.timer(id);
        yield* jobs();
      }
      if (t > now) now = t;
    };
    const at = (s, i) => (s.localMs !== undefined ? s.localMs : T0 + 1000 * (i + 1));
    try {
      evalBundle();
      yield* jobs();
      app = g.__app;
      rec("#mount", 1, script.ctx);
      app.mount(1, script.ctx);
      yield* jobs();
      for (let i = 0; i < script.steps.length; i++) {
        const s = script.steps[i];
        if ("wait" in s) {
          yield* advance(now + s.wait);
          rec("#wait", s.wait, now);
          continue;
        }
        yield* advance(at(s, i));
        if ("state" in s) {
          rec("#state", i, now);
          app.onState(s.state);
          yield* jobs();
        } else if ("stateHex" in s) {
          rec("#state", i, now);
          app.onState(hexBytes(s.stateHex));
          yield* jobs();
        } else if ("dispatch" in s) {
          const d = s.dispatch;
          const payload = d.payload === undefined ? null : d.payload;
          rec("#dispatch", d.tag, d.name, payload);
          const handled = app.dispatch(d.tag, d.name, payload);
          yield* jobs();
          rec("#handled", handled);
        } else {
          throw new Error("bad step " + JSON.stringify(s));
        }
      }
    } catch (e) {
      rec("#error", message(e));
    }
    return lines;
  };
})(globalThis);
