// The controls' rules (browser/controls.js): what they mean, and that
// fixtures/controls.json (which the Swift host is held to) is current.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOT } from "./lib.mjs";
import { controlFixtures } from "./control-cases.mjs";
import { crownValue, imageRect, imageSource, progressValue, ringGeometry, toggleKnob } from "../browser/controls.js";

test("fixtures/controls.json is current", () => {
  assert.deepEqual(JSON.parse(readFileSync(ROOT + "fixtures/controls.json", "utf8")), JSON.parse(JSON.stringify(controlFixtures())));
});

test("crown: clamps, snaps to the increment grid from min, wraps", () => {
  assert.equal(crownValue(12, { min: 0, max: 10 }), 10);
  assert.equal(crownValue(-1, { min: 0, max: 10 }), 0);
  assert.equal(crownValue(3.3, {}), 3.3);
  assert.equal(crownValue(4.26, { min: 0, max: 10, increment: 0.5 }), 4.5);
  assert.equal(crownValue(4.24, { min: 0, max: 10, increment: 0.5 }), 4);
  assert.equal(crownValue(9.9, { min: 0, max: 10, increment: 3 }), 9, "the grid's last value inside the range");
  assert.equal(crownValue(10, { min: 1, max: 10, increment: 3 }), 10, "grid from min: 1, 4, 7, 10");
  assert.equal(crownValue(0.30000000000000004, { increment: 0.1 }), 0.3);
  assert.equal(crownValue(-0.25, { increment: 0.5 }), 0, "halves round up, as Math.round");
  assert.equal(crownValue(365, { min: 0, max: 360, wrap: true }), 5);
  assert.equal(crownValue(-5, { min: 0, max: 360, wrap: true }), 355);
  assert.equal(crownValue(358, { min: 0, max: 360, increment: 5, wrap: true }), 0, "max is min again");
  assert.equal(crownValue(5, { min: 0, wrap: true }), 5, "wrap needs both ends");
  assert.equal(crownValue(NaN, {}), null);
});

test("image: React Native's resize modes; own size = pixels / 2", () => {
  assert.deepEqual(imageRect("cover", 16, 16, 40, 28), { x: 0, y: -6, w: 40, h: 40 });
  assert.deepEqual(imageRect("contain", 16, 16, 40, 28), { x: 6, y: 0, w: 28, h: 28 });
  assert.deepEqual(imageRect("stretch", 16, 16, 40, 28), { x: 0, y: 0, w: 40, h: 28 });
  assert.deepEqual(imageRect("center", 16, 16, 40, 28), { x: 12, y: 6, w: 16, h: 16 }, "not enlarged");
  assert.deepEqual(imageRect("center", 64, 16, 40, 28), { x: 0, y: 9, w: 40, h: 10 }, "shrunk to fit");
  assert.equal(imageSource("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(imageSource("data:image/svg+xml;base64,PHN2Zy8+"), null);
});

test("a leaf type takes no children (Yoga refuses children under a measured node)", async () => {
  const { ShadowTree } = await import("../browser/shadow.js");
  const { stubMeasurer } = await import("../browser/text-layout.js");
  const Yoga = (await import("yoga-layout")).default;
  const { schema } = await import("./lib.mjs");
  const t = new ShadowTree(Yoga, { schema, measurer: stubMeasurer });
  t.createRoot(1, { width: 100, height: 100 });
  for (const type of ["icon", "toggle", "image", "haptic", "crown"]) {
    const leaf = t.createNode(type), child = t.createNode("view");
    assert.throws(() => t.insert(leaf, child, 0), new RegExp(`<${type}> takes no children`));
  }
  const p = t.createNode("progress"), label = t.createNode("text");
  t.insert(p, label, 0);
  t.insert(1, p, 0);
  t.commit();
});

test("progress, ring and toggle geometry", () => {
  assert.equal(progressValue(1.5), 1);
  assert.equal(progressValue(-1), 0);
  assert.equal(progressValue(NaN), 0);
  assert.deepEqual(ringGeometry(64, 40, 4), { cx: 32, cy: 20, r: 18, t: 4 });
  assert.deepEqual(ringGeometry(10, 64, 30), { cx: 5, cy: 32, r: 2.5, t: 5 }, "thickness at most half the square");
  assert.deepEqual(toggleKnob(false, 40, 24), { x: 2, y: 2, d: 20 });
  assert.deepEqual(toggleKnob(true, 40, 24), { x: 18, y: 2, d: 20 });
});
