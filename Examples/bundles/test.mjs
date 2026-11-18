// Runs each built example (dist/<name>/bundle.js, from `npm run build`)
// through solid-watch's recording host (test/driver.js, the drivers the
// package's own fixtures are recorded with) with a short scenario of taps,
// crown turns, states and waits, and checks that it runs, never throws, and
// shows what it should. Writes the resolved script to dist/<name>/script.json,
// which the browser harness steps through (Examples/README.md).
//
// A scenario names buttons by their text, not by tag: before each tap the
// bundle is run up to that point and the button is found in the tree its
// mutation log builds. With QJS=/path/to/qjs set, each example also runs
// under quickjs-ng (the watch's engine), whose log must equal node's.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { mergeSchema } from "solid-watch/schema-merge";
import { examples } from "./rollup.config.js";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const DRIVER = readFileSync(PKG + "test/driver.js", "utf8");
const CTX = { width: 184, height: 224 }; // a 41 mm watch's content area, about

// Steps: { press: "label" } and { longPress: "label" } dispatch to the one
// button whose text contains label; { crown: n } turns the attached crown to
// n; { wait: ms } and { state: … } go to the driver as they are; { expect:
// "text" } / { expectNot: "text" } check the screen's text; { expectProp:
// [type, prop, value] } checks that prop on every attached node of a type.
const SCENARIOS = {
  stopwatch: [
    { expect: "0:00.0" }, { expect: "ready" }, { expect: "No laps yet" },
    { press: "Start" },
    { wait: 2500 },
    { expect: "0:02.5" }, { expect: "running" },
    { press: "Lap" },
    { expect: "Lap 1" }, { expectNot: "No laps yet" },
    { wait: 1200 },
    { press: "Lap" },
    { expect: "Lap 2" }, { expect: "0:01.2" },
    { press: "Stop" },
    { expect: "hold to reset" }, { expect: "Start" },
    { wait: 1000 },
    { expect: "0:03.7" },
    { longPress: "hold to reset" },
    { expect: "0:00.0" }, { expect: "No laps yet" },
  ],
  checklist: [
    { expect: "0 / 7" }, { expectProp: ["progress", "value", 0] },
    { press: "Buy milk" },
    { expect: "1 / 7" }, { expectProp: ["progress", "value", 1 / 7] },
    { press: "Call the dentist" },
    { press: "Buy milk" },
    { press: "Buy milk" },
    { expect: "2 / 7" },
    { press: "Clear done" },
    { expect: "0 / 5" }, { expectNot: "Buy milk" }, { expectNot: "Call the dentist" },
    { state: { items: ["Pack lunch", "Charge headphones"] } },
    { expect: "0 / 2" }, { expectNot: "Water the plants" },
    { press: "Pack lunch" },
    { press: "Charge headphones" },
    { press: "Clear done" },
    { expect: "All clear" },
  ],
  gauge: [
    { expect: "LOW" }, { expectProp: ["progress", "value", 0] },
    { crown: 42 },
    { expect: "42" }, { expect: "LOW" }, { expectProp: ["progress", "value", 0.42] },
    { crown: 72 },
    { expect: "HIGH" },
    { crown: 90 },
    { expect: "MAX" }, { expectProp: ["progress", "color", "red"] },
    { press: "Reset" },
    { expect: "LOW" }, { expectProp: ["crown", "value", 0] },
  ],
};

/** Runs a bundle in a fresh vm context through `script`; returns the log lines. */
function runNode(src, script) {
  const ctx = vm.createContext({}, { microtaskMode: "afterEvaluate" });
  vm.runInContext(DRIVER, ctx, { filename: "driver.js" });
  const it = ctx.__swDriver(() => vm.runInContext(src, ctx, { filename: "bundle.js" }), script);
  let r;
  while (!(r = it.next()).done) vm.runInContext("", ctx);
  return Array.from(r.value, String);
}

/** The tree a mutation log builds: tag -> { type, props, text, children, parent }. */
function tree(lines) {
  const nodes = new Map();
  const detach = (child) => {
    const n = nodes.get(child);
    if (n && n.parent) {
      const p = nodes.get(n.parent);
      p.children.splice(p.children.indexOf(child), 1);
      n.parent = 0;
    }
  };
  for (const line of lines) {
    const [op, ...a] = JSON.parse(line);
    if (op === "#mount") nodes.set(a[0], { type: "root", props: {}, text: "", children: [], parent: 0 });
    else if (op === "createNode") nodes.set(a[0], { type: a[1], props: {}, text: "", children: [], parent: 0 });
    else if (op === "createText") nodes.set(a[0], { type: "#text", props: {}, text: a[1], children: [], parent: 0 });
    else if (op === "setProp") {
      const n = nodes.get(a[0]);
      n.props[a[1]] = a[2];
      if (a[1] === "text") n.text = a[2] ?? "";
    } else if (op === "insert") {
      const [parent, child, before] = a;
      detach(child);
      const p = nodes.get(parent);
      const i = before ? p.children.indexOf(before) : -1;
      p.children.splice(i < 0 ? p.children.length : i, 0, child);
      nodes.get(child).parent = parent;
    } else if (op === "remove") detach(a[1]);
  }
  const textOf = (tag) => {
    const n = nodes.get(tag);
    return n.text + n.children.map(textOf).join(n.type === "text" || n.type === "#text" ? "" : " ");
  };
  const attached = [];
  const walk = (tag) => {
    attached.push(tag);
    nodes.get(tag).children.forEach(walk);
  };
  walk(1);
  return { nodes, attached, textOf, screen: textOf(1) };
}

// The recording host takes any prop; the watch does not. So every setProp in
// a log is held to the schema here: a prop the node type has, an enum value
// it lists, a colour that is a token or #RRGGBB[AA].
const SCHEMA = mergeSchema(JSON.parse(readFileSync("node_modules/solid-watch/schema/nodes.json", "utf8")));
const COLOR = /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
function checkProps(lines) {
  const types = new Map([[1, "view"]]);
  for (const line of lines) {
    const [op, ...a] = JSON.parse(line);
    if (op === "createNode") types.set(a[0], a[1]);
    else if (op === "createText") types.set(a[0], "#text");
    else if (op === "setProp") {
      const [tag, key, v] = a;
      const type = types.get(tag);
      if (type === "#text" || (type === "text" && key === "text")) continue;
      const spec = SCHEMA.nodes[type] && SCHEMA.nodes[type].props[key];
      if (!spec) throw new Error(`<${type}> has no prop ${key} (schema/nodes.json)`);
      if (v === null || spec.type === "event") continue;
      if (spec.type === "enum" && !spec.values.includes(v)) throw new Error(`<${type}> ${key}: ${JSON.stringify(v)} is not one of ${spec.values.join(", ")}`);
      if (spec.type === "color" && !(v in SCHEMA.colors) && !COLOR.test(v)) throw new Error(`<${type}> ${key}: ${JSON.stringify(v)} is not a colour`);
    }
  }
}

function find(t, pred, what) {
  const hits = t.attached.filter((tag) => pred(t.nodes.get(tag), tag));
  if (hits.length !== 1) throw new Error(`${what}: ${hits.length} matches on screen (want 1); screen: ${t.screen}`);
  return hits[0];
}

let failed = 0;
for (const name of examples) {
  const scenario = SCENARIOS[name];
  try {
    if (!scenario) throw new Error("no scenario in test.mjs");
    const src = readFileSync(`dist/${name}/bundle.js`, "utf8");
    const steps = [];
    // The driver's clock (README: Golden mutation logs): T0 at mount, a wait
    // moves it on. Each state and tap is stamped with the clock as it is
    // (localMs), so it happens at once, as a tap after a wait does.
    let clock = 1000000;
    const push = (s) => {
      if ("wait" in s) clock += s.wait;
      steps.push("wait" in s ? s : { ...s, localMs: clock });
    };
    const run = () => runNode(src, { ctx: CTX, steps });
    const check = (lines) => {
      const err = lines.find((l) => l.startsWith('["#error"'));
      if (err) throw new Error(`the bundle threw: ${err}`);
      const unhandled = lines.findIndex((l) => l === '["#handled",false]');
      if (unhandled >= 0) throw new Error(`a dispatch found no handler: ${lines[unhandled - 1]}`);
      checkProps(lines);
    };
    for (const s of scenario) {
      if ("wait" in s || "state" in s) {
        push(s);
        continue;
      }
      const lines = run();
      check(lines);
      const t = tree(lines);
      if ("expect" in s) {
        if (!t.screen.includes(s.expect)) throw new Error(`expected "${s.expect}" on screen after ${steps.length} steps; screen: ${t.screen}`);
      } else if ("expectNot" in s) {
        if (t.screen.includes(s.expectNot)) throw new Error(`"${s.expectNot}" still on screen after ${steps.length} steps`);
      } else if ("expectProp" in s) {
        const [type, prop, want] = s.expectProp;
        const tags = t.attached.filter((tag) => t.nodes.get(tag).type === type);
        if (!tags.length) throw new Error(`no ${type} on screen`);
        for (const tag of tags) {
          const got = t.nodes.get(tag).props[prop];
          const ok = typeof want === "number" ? Math.abs(got - want) < 1e-9 : got === want;
          if (!ok) throw new Error(`${type} ${tag} ${prop} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        }
      } else if ("press" in s || "longPress" in s) {
        const label = s.press ?? s.longPress;
        const tag = find(t, (n, tg) => n.type === "button" && t.textOf(tg).includes(label), `button "${label}"`);
        push({ dispatch: { tag, name: "press" in s ? "press" : "longPress", payload: null } });
      } else if ("crown" in s) {
        const tag = find(t, (n) => n.type === "crown", "crown");
        push({ dispatch: { tag, name: "change", payload: s.crown } });
      } else throw new Error(`bad scenario step ${JSON.stringify(s)}`);
    }
    const lines = run();
    check(lines);
    const commits = lines.filter((l) => l === '["commit"]').length;
    const script = { ctx: CTX, steps };
    writeFileSync(`dist/${name}/script.json`, JSON.stringify(script, null, 2) + "\n");
    let qjs = "";
    if (process.env.QJS) {
      const r = spawnSync(process.env.QJS, [PKG + "test/qjs-runner.js", PKG + "test/driver.js", `dist/${name}/bundle.js`, `dist/${name}/script.json`], { encoding: "utf8", maxBuffer: 1 << 28 });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`qjs exited ${r.status}: ${r.stderr}`);
      const q = r.stdout.split("\n").filter((l) => l !== "");
      const i = q.findIndex((l, k) => l !== lines[k]);
      if (q.length !== lines.length || i >= 0) throw new Error(`qjs and node logs differ at line ${(i < 0 ? Math.min(q.length, lines.length) : i) + 1}`);
      qjs = ", qjs log identical";
    }
    console.log(`ok ${name}: ${src.length} B bundle, ${steps.length} steps, ${lines.length} log lines, ${commits} commits${qjs}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
