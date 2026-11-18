// Cases for the controls' rules (browser/controls.js), written with their
// results to fixtures/controls.json (test/make-layout-fixtures.mjs), which
// the Swift host's Controls is held to (Tests/SolidWatchTests/ControlsTests.swift).
import { crownValue, imageRect, imageSource, ringGeometry, toggleKnob } from "../browser/controls.js";

/** fixtures/controls.json: each rule's cases with the browser host's results. */
export function controlFixtures() {
  return {
    crown: crown.map(([v, range]) => ({ v, range, out: crownValue(v, range) })),
    images: images.map(([mode, iw, ih, bw, bh]) => ({ mode, image: [iw, ih], box: [bw, bh], out: imageRect(mode, iw, ih, bw, bh) })),
    rings: rings.map(([w, h, t]) => ({ box: [w, h], thickness: t, out: ringGeometry(w, h, t) })),
    knobs: knobs.map(([on, w, h]) => ({ on, box: [w, h], out: toggleKnob(on, w, h) })),
    sources: sources.map((s) => ({ source: s, ok: imageSource(s) !== null })),
  };
}

export const crown = [
  [3.3, {}],
  [-7.25, { min: 0, max: 10 }],
  [12, { min: 0, max: 10 }],
  [4.26, { min: 0, max: 10, increment: 0.5 }],
  [4.24, { min: 0, max: 10, increment: 0.5 }],
  [9.9, { min: 0, max: 10, increment: 3 }],
  [10, { min: 1, max: 10, increment: 3 }],
  [0.30000000000000004, { increment: 0.1 }],
  [0.7, { min: 0, increment: 0.1 }],
  [-0.25, { increment: 0.5 }],
  [-1.25, { increment: 0.5 }],
  [365, { min: 0, max: 360, wrap: true }],
  [-5, { min: 0, max: 360, wrap: true }],
  [358, { min: 0, max: 360, increment: 5, wrap: true }],
  [720, { min: 0, max: 360, increment: 5, wrap: true }],
  [-722.5, { min: 0, max: 360, increment: 5, wrap: true }],
  [5, { min: 0, wrap: true }],
  [5, { min: 10, max: 0 }],
  [1e9 + 0.25, { increment: 0.5 }],
];

export const images = [
  ["cover", 16, 16, 40, 28],
  ["contain", 16, 16, 40, 28],
  ["stretch", 16, 16, 40, 28],
  ["center", 16, 16, 40, 28],
  ["center", 64, 16, 40, 28],
  ["cover", 30, 10, 20, 20],
  ["contain", 0, 10, 20, 20],
];

export const rings = [
  [64, 64, 7],
  [64, 40, 4],
  [10, 64, 30],
  [0, 0, 4],
  [20, 20, -3],
];

export const knobs = [
  [false, 40, 24],
  [true, 40, 24],
  [true, 52, 30],
  [true, 10, 30],
  [false, 40, 2],
];

export const sources = [
  "data:image/png;base64,iVBORw0KGgo=",
  "data:image/jpeg;base64,/9j/4AAQ",
  "data:image/svg+xml;base64,PHN2Zy8+",
  "data:image/png;base64,not base64!",
  "data:image/png;base64,iVBORw0KGgo",
  "data:image/png;base64,iVBORw0KGg==",
  "https://example.com/a.png",
  "",
];
