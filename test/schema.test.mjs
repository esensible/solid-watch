import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mergeSchema } from "../js/schema-merge.js";
import { ROOT, schema } from "./lib.mjs";

const fragment = {
  name: "demo",
  colors: { accent: "#FF9F0A" },
  extends: { button: { props: { payload: { kind: "behavior", type: "bytes", default: null } } } },
  nodes: { gauge: { doc: "a dial", groups: ["layout", "box"], children: "none", props: { value: { kind: "paint", type: "number", default: 0 } } } },
};

test("core schema: every node type resolves; RN defaults", () => {
  const m = mergeSchema(schema);
  assert.deepEqual(Object.keys(m.nodes), ["view", "text", "scroll", "button", "toggle", "progress", "icon", "image", "haptic", "crown"]);
  for (const t of ["haptic", "crown"]) assert.equal(m.nodes[t].layout, false, t);
  for (const t of ["toggle", "icon", "image"]) assert.equal(m.nodes[t].children, "none", t);
  assert.equal(m.nodes.progress.children, "nodes");
  // every event prop of a core node, and what its handler gets (README: Behaviour)
  const events = Object.entries(m.nodes).flatMap(([t, n]) => Object.keys(n.props).filter((k) => n.props[k].type === "event").map((k) => `${t}.${k}`));
  assert.deepEqual(events, ["button.onPress", "button.onLongPress", "button.onPressIn", "button.onPressOut", "toggle.onChange", "crown.onChange"]);
  // colour defaults are colours both hosts resolve
  for (const [t, n] of Object.entries(m.nodes)) {
    for (const [k, p] of Object.entries(n.props)) {
      if (p.type === "color" && p.default !== null) assert.ok(m.colors[p.default] || /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(p.default), `${t}.${k}: ${p.default}`);
    }
  }
  const p = m.nodes.view.props;
  assert.equal(p.flexDirection.default, "column");
  assert.equal(p.flexShrink.default, 0);
  assert.equal(p.alignItems.default, "stretch");
  assert.equal(p.alignContent.default, "flex-start");
  assert.equal(p.boxSizing.default, "border-box");
  assert.equal(m.nodes.haptic.layout, false);
  assert.equal(m.nodes.text.children, "text");
});

test("contract version: the schema's, the recording driver's and the generated Swift agree", () => {
  assert.ok(Number.isInteger(schema.version) && schema.version >= 2);
  assert.match(readFileSync(ROOT + "test/driver.js", "utf8"), new RegExp(`var HOST_VERSION = ${schema.version};`));
  assert.match(readFileSync(ROOT + "Sources/SolidWatch/Generated/NodeProps.swift", "utf8"), new RegExp(`public static let version = ${schema.version}\\n`));
});

test("fragments add props, node types and colours", () => {
  const m = mergeSchema(schema, fragment);
  assert.equal(m.nodes.button.props.payload.group, "demo:button");
  assert.equal(m.nodes.gauge.native, true);
  assert.equal(m.colors.accent, "#FF9F0A");
});

test("only event props are named onXxx (the renderer takes every onXxx prop for a handler)", () => {
  assert.throws(() => mergeSchema(schema, { name: "x", extends: { toggle: { props: { onTint: { kind: "paint", type: "color", default: null } } } } }), /only event props are named onXxx/);
});

test("the gallery sets every non-event prop of the new controls on the host (none is swallowed as a handler)", () => {
  const log = readFileSync(ROOT + "fixtures/mutations/gallery/log.jsonl", "utf8");
  const set = new Set([...log.matchAll(/\["setProp",\d+,"(\w+)"/g)].map((m) => m[1]));
  const m = mergeSchema(schema);
  for (const t of ["toggle", "progress", "icon", "image", "crown"]) {
    for (const [k, p] of Object.entries(m.nodes[t].props)) {
      if (p.group === t) assert.ok(set.has(k), `<${t}> ${k} reaches the host in the gallery`);
    }
  }
  for (const k of ["borderTopLeftRadius", "rotate", "scale", "letterSpacing", "showsVerticalScrollIndicator", "onLongPress", "pressedOpacity", "pressedScale", "pressedBackground"]) assert.ok(set.has(k), k);
});

test("fragments can't redefine", () => {
  assert.throws(() => mergeSchema(schema, { name: "x", nodes: { view: { groups: [] } } }), /defined twice/);
  assert.throws(() => mergeSchema(schema, { name: "x", extends: { button: { props: { disabled: { kind: "behavior", type: "boolean", default: false } } } } }), /defined twice/);
  assert.throws(() => mergeSchema(schema, { name: "x", extends: { nope: { props: {} } } }), /unknown node/);
});

test("codegen: core outputs are up to date; a fragment generates", () => {
  const check = spawnSync(process.execPath, [ROOT + "codegen/codegen.mjs", "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const dir = mkdtempSync(tmpdir() + "/sw-");
  writeFileSync(dir + "/f.json", JSON.stringify(fragment));
  const r = spawnSync(process.execPath, [ROOT + "codegen/codegen.mjs", "--fragment", dir + "/f.json", "--ts", dir + "/f.d.ts", "--swift", dir + "/F.swift", "--js", dir + "/f.js"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const swift = readFileSync(dir + "/F.swift", "utf8");
  assert.match(swift, /public struct DemoButtonProps/);
  assert.match(swift, /public var payload: \[UInt8\]\? = nil/);
  assert.match(swift, /public struct DemoGaugeProps/);
  assert.match(swift, /self\.value = v/); // a prop named like the parameter
  assert.doesNotMatch(swift, /pressHandlers/);
  const ts = readFileSync(dir + "/f.d.ts", "utf8");
  assert.match(ts, /"gauge": GaugeElement;/);
});
