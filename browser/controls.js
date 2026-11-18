// The rules of the core controls that are more than paint (README:
// Behaviour), written once for the browser host; the Swift host's
// Controls.swift is a line-for-line port and test/controls.test.mjs holds
// both to the same cases (fixtures/controls.json).

/** Round to 1e-9 (JS Math.round: halves up), so steps of 0.1 give 0.3, not 0.30000000000000004; no -0. */
const tidy = (v) => Math.round(v * 1e9) / 1e9 || 0;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The value a <crown> sends for a raw crown position `v`: with `wrap` (and
 * min < max) brought into [min, max); else kept in [min, max] (either end
 * may be null = open); with `increment`, snapped to min (or 0) + k x increment and kept
 * on that grid inside the range where it fits.
 */
export function crownValue(v, { min = null, max = null, increment = null, wrap = false } = {}) {
  if (!Number.isFinite(v)) return null;
  const lo = num(min), hi = num(max), st = num(increment) > 0 ? num(increment) : null;
  const span = lo !== null && hi !== null && hi > lo ? hi - lo : null;
  const base = lo ?? 0;
  const snap = (x) => (st === null ? x : base + Math.round((x - base) / st) * st);
  if (wrap && span !== null) {
    const into = (x) => lo + ((((x - lo) % span) + span) % span);
    return tidy(into(tidy(snap(into(v)))));
  }
  const clamp = (x) => (lo !== null && x < lo ? lo : hi !== null && x > hi ? hi : x);
  let x = snap(clamp(v));
  if (st !== null && hi !== null && x > hi) x -= st;
  if (st !== null && lo !== null && x < lo) x += st;
  return tidy(clamp(x));
}

/**
 * Where an image of natural size iw x ih (points: pixels / 2) is drawn in a
 * box bw x bh, for a resizeMode: { x, y, w, h } relative to the box (it is
 * clipped to the box).
 */
export function imageRect(mode, iw, ih, bw, bh) {
  if (mode === "stretch" || !(iw > 0) || !(ih > 0)) return { x: 0, y: 0, w: bw, h: bh };
  let k;
  if (mode === "contain") k = Math.min(bw / iw, bh / ih);
  else if (mode === "center") k = Math.min(1, bw / iw, bh / ih);
  else k = Math.max(bw / iw, bh / ih); // cover
  const w = iw * k, h = ih * k;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

/** A progress value as drawn: 0..1 (anything else, NaN included, is clamped / 0). */
export const progressValue = (v) => (typeof v === "number" && v > 0 ? Math.min(v, 1) : 0);

/**
 * A ring's or arc's circle in a content box cw x ch: the largest centred
 * square, stroked `t` wide inside it. { cx, cy, r, t } (r: the stroke's
 * centre line).
 */
export function ringGeometry(cw, ch, thickness) {
  const d = Math.max(0, Math.min(cw, ch));
  const t = Math.max(0, Math.min(num(thickness) ?? 0, d / 2));
  return { cx: cw / 2, cy: ch / 2, r: Math.max(0, (d - t) / 2), t };
}

/** A toggle's knob in a content box cw x ch: { x, y, d }. */
export function toggleKnob(on, cw, ch) {
  const d = Math.max(0, ch - 4);
  return { x: on ? Math.max(2, cw - d - 2) : 2, y: 2, d };
}

/** The PNG or JPEG payload of an image source; null for anything else. */
export const imageSource = (s) => (typeof s === "string" && /^data:image\/(png|jpeg);base64,(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$|^data:image\/(png|jpeg);base64,(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(s) ? s : null);
