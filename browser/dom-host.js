// The browser host: implements the host interface (README: Host interface)
// on a ShadowTree (yoga-layout) and draws it with absolutely positioned divs.
//
//   const host = new DomHost(Yoga, element, { schema, fragments, onEvent })
//   realm.__host = host.api;  // then evaluate the bundle in `realm`
//   host.mount(realm.__app, { width, height }); host.state(value)
//
// A bundle installs its own setTimeout & co. (README: Timers) on its global
// object, so evaluate it in a realm of its own (the harness uses an iframe),
// not in the page.
//
// Text is measured with the DOM in the bundled font (fonts/Inter-roman.ttf,
// loaded as a web font): canvas measureText can't apply tabular figures.
import { Edge } from "yoga-layout";
import { ShadowTree } from "./shadow.js";
import { crownValue, imageRect, imageSource, progressValue, ringGeometry, toggleKnob } from "./controls.js";

// The page's own timers, for the host's timers (a bundle evaluated in this
// realm would replace the globals).
const pageSetTimeout = globalThis.setTimeout.bind(globalThis);
const pageClearTimeout = globalThis.clearTimeout.bind(globalThis);

const FONT_FAMILY = "SolidWatchInter";
const WEIGHT = { normal: 400, bold: 700 };
const weightOf = (w) => WEIGHT[w] ?? (Number(w) || 400);
const SVG = "http://www.w3.org/2000/svg";
/** Hold time before a button's onLongPress (README: Behaviour). */
export const LONG_PRESS_MS = 500;
/** The crown in the browser: one wheel notch (deltaY 100) moves a <crown> by one increment (README: crown). */
const SENSITIVITY = { low: 0.5, medium: 1, high: 2 };

/** Load the bundled font as a web font (call once before measuring). */
export async function loadFont(url) {
  const face = new FontFace(FONT_FAMILY, `url(${url})`, { weight: "100 900" });
  await face.load();
  document.fonts.add(face);
}

function cssFont(el, run, scale) {
  el.style.fontFamily = FONT_FAMILY;
  el.style.fontSize = run.fontSize * scale + "px";
  el.style.fontWeight = String(weightOf(run.fontWeight));
  el.style.fontVariantNumeric = run.tabular ? "tabular-nums" : "normal";
  el.style.fontKerning = "normal";
  el.style.letterSpacing = run.letterSpacing ? run.letterSpacing * scale + "px" : "";
}

/**
 * DOM measurer (text-layout.js contract). Lays the runs out in a hidden
 * inline-block with a 1000 px line box, so each line's index is
 * floor(midY / 1000); the widest line is the largest right - left over the
 * line's client rects.
 */
export function domMeasurer(lineHeightRatio) {
  const LINE = 1000;
  const box = document.createElement("div");
  Object.assign(box.style, { position: "absolute", visibility: "hidden", left: "-100000px", top: "0", lineHeight: LINE + "px", display: "inline-block" });
  document.body.appendChild(box);
  return {
    lineHeightRatio,
    lines(runs, scale, maxWidth) {
      box.textContent = "";
      box.style.whiteSpace = maxWidth < Infinity ? "pre-wrap" : "pre";
      box.style.maxWidth = maxWidth < Infinity ? maxWidth + "px" : "none";
      box.style.overflowWrap = "anywhere";
      for (const r of runs) {
        const s = document.createElement("span");
        cssFont(s, r, scale);
        s.style.lineHeight = LINE + "px";
        s.textContent = r.text;
        box.appendChild(s);
      }
      const top = box.getBoundingClientRect().top;
      const range = document.createRange();
      const lines = new Map();
      for (const s of box.childNodes) {
        range.selectNodeContents(s);
        for (const rect of range.getClientRects()) {
          const i = Math.floor((rect.top + rect.height / 2 - top) / LINE);
          const l = lines.get(i) || { left: Infinity, right: -Infinity };
          l.left = Math.min(l.left, rect.left);
          l.right = Math.max(l.right, rect.right);
          lines.set(i, l);
        }
      }
      // "\n" lines with nothing on them still count
      const count = Math.max(lines.size, Math.round(box.getBoundingClientRect().height / LINE));
      let widest = 0;
      for (const l of lines.values()) if (l.right > l.left) widest = Math.max(widest, l.right - l.left);
      return { lines: count || 1, widest };
    },
  };
}

// An element positioned at a node's content box (inside padding and border).
function contentBox(el, y) {
  const l = y.getComputedPadding(Edge.Left) + y.getComputedBorder(Edge.Left);
  const t = y.getComputedPadding(Edge.Top) + y.getComputedBorder(Edge.Top);
  const w = Math.max(0, y.getComputedWidth() - l - y.getComputedPadding(Edge.Right) - y.getComputedBorder(Edge.Right));
  const h = Math.max(0, y.getComputedHeight() - t - y.getComputedPadding(Edge.Bottom) - y.getComputedBorder(Edge.Bottom));
  Object.assign(el.style, { position: "absolute", left: l + "px", top: t + "px", width: w + "px", height: h + "px", pointerEvents: "none" });
  return { w, h };
}

export class DomHost {
  /**
   * el: the element to draw into (the watch screen).
   * onEvent(kind, detail): "commit" {ops}, "haptic" {pattern}, "press" {tag,
   * handled}, "longPress" {tag, handled}, "pressIn" {tag, handled},
   * "pressOut" {tag, handled}, "change" {tag, value, handled},
   * "timer" {id, handled}, "send" {bytes}, "log" {message}, "error" {error}.
   * onSend(bytes): the bundle's send(bytes), an array of byte values (the
   * app's native side; default: nothing beyond the "send" event).
   */
  constructor(Yoga, el, { schema, fragments = [], onEvent = () => {}, onSend = () => {} }) {
    this.el = el;
    el.style.position = "relative";
    this.screen = document.createElement("div");
    Object.assign(this.screen.style, { position: "absolute", inset: "0", overflow: "hidden" });
    el.appendChild(this.screen);
    this.onEvent = onEvent;
    this.onSend = onSend;
    this.timers = new Map(); // id -> page timeout handle
    this.tree = new ShadowTree(Yoga, { schema, fragments, measurer: domMeasurer(schema.font.lineHeightRatio) });
    this.colors = this.tree.schema.colors;
    this.els = new Map();
    this.images = new Map(); // source -> { id, w, h } in points once loaded ({ id, loading } / { id, failed })
    this.crownState = null; // { tag, value (the prop), raw, sent }
    this.ops = 0;
    this.app = null;
    this.screen.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
    const t = this.tree;
    this.api = {
      version: schema.version,
      createNode: (type) => (this.ops++, t.createNode(type)),
      createText: (s) => (this.ops++, t.createText(s)),
      setProp: (tag, k, v) => (this.ops++, t.setProp(tag, k, v)),
      insert: (p, c, b) => (this.ops++, t.insert(p, c, b)),
      remove: (p, c) => (this.ops++, t.remove(p, c)),
      commit: () => this._commit(),
      setTimer: (id, ms) => {
        pageClearTimeout(this.timers.get(id));
        this.timers.set(id, pageSetTimeout(() => this._fire(id), ms));
      },
      clearTimer: (id) => {
        pageClearTimeout(this.timers.get(id));
        this.timers.delete(id);
      },
      log: (message) => this.onEvent("log", { message: String(message) }),
      send: (bytes) => {
        this.onEvent("send", { bytes });
        this.onSend(bytes);
      },
      release: (tag) => {
        t.release(tag);
        const el = this.els.get(tag);
        if (el && el._endPress) el._endPress();
        if (el) el.remove();
        this.els.delete(tag);
        this.onEvent("release", { tag });
      },
    };
  }

  dispose() {
    for (const h of this.timers.values()) pageClearTimeout(h);
    this.timers.clear();
    this.disposed = true;
    this.el.textContent = "";
  }

  /** A bundle timer is due: __app.timer(id) (it commits itself). */
  _fire(id) {
    this.timers.delete(id);
    if (this.disposed || !this.app) return;
    let handled = false;
    this._guard(() => (handled = this.app.timer(id)));
    this.onEvent("timer", { id, handled });
  }

  mount(app, ctx) {
    this.app = app;
    this.tree.createRoot(1, ctx);
    this._guard(() => app.mount(1, ctx));
  }

  /** Deliver a state. */
  state(value) {
    this._guard(() => this.app.onState(value));
  }

  /** Dispatch an event to the bundle as a tap or the crown would; returns whether a handler ran. */
  dispatch(tag, name, payload = null) {
    if (this.disposed || !this.app) return false;
    let handled = false;
    this._guard(() => (handled = this.app.dispatch(tag, name, payload)));
    this.onEvent(name, { tag, handled, value: payload });
    return handled;
  }

  /**
   * Turn the crown by `notches` (one wheel notch; positive = up, increasing):
   * the attached <crown>'s position moves by increment (or 1, or a 50th of its
   * range when continuous and bounded) x its sensitivity, and its handler gets
   * the new value if that differs from the last one sent. Returns the value
   * sent, or null.
   */
  turnCrown(notches) {
    const c = this.crownState;
    if (!c || this.disposed) return null;
    const n = this.tree.nodes.get(c.tag);
    if (!n || !n.props.onChange) return null;
    const P = n.props, increment = typeof P.increment === "number" && P.increment > 0 ? P.increment : null;
    const bounded = typeof P.min === "number" && typeof P.max === "number" && P.max > P.min;
    const unit = increment ?? (bounded ? (P.max - P.min) / 50 : 1);
    c.raw += notches * unit * (SENSITIVITY[P.sensitivity] ?? 1);
    const range = { min: P.min ?? null, max: P.max ?? null, increment, wrap: P.wrap === true };
    // each end bounds the crown on its own (as on the watch), unless it wraps
    if (!(range.wrap && bounded)) {
      if (typeof P.min === "number") c.raw = Math.max(c.raw, P.min);
      if (typeof P.max === "number") c.raw = Math.min(c.raw, P.max);
    }
    const v = crownValue(c.raw, range);
    if (v === null || v === c.sent) return null;
    c.sent = v;
    this.dispatch(c.tag, "change", v);
    return v;
  }

  _wheel(e) {
    if (!this.crownState) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    this._wheelAcc = (this._wheelAcc || 0) - px / 100;
    const whole = Math.trunc(this._wheelAcc);
    if (whole !== 0) {
      this._wheelAcc -= whole;
      this.turnCrown(whole);
    }
  }

  // A call that threw: its error, as thrown (Solid 2 passes any thrown value
  // on unchanged, an Error from another realm included).
  _guard(fn) {
    try {
      fn();
    } catch (e) {
      this.onEvent("error", { error: e });
    }
  }

  _commit() {
    const ops = this.ops;
    this.ops = 0;
    this.tree.commit();
    this._syncCrown();
    this._paint();
    this.onEvent("commit", { ops });
    for (const h of this.tree.hapticsFired) this._haptic(h);
  }

  // The crown follows the attached <crown>: its position resets to `value`
  // whenever that prop changes (or another node takes the crown).
  _syncCrown() {
    const n = this.tree.crown;
    if (!n) {
      this.crownState = null;
      return;
    }
    const value = typeof n.props.value === "number" ? n.props.value : 0;
    const c = this.crownState;
    if (!c || c.tag !== n.tag || c.value !== value) this.crownState = { tag: n.tag, value, raw: value, sent: this._crownReads(n, value) };
  }

  // What the crown at `value` reads as: seating it there is not a turn.
  _crownReads(n, value) {
    const P = n.props;
    const increment = typeof P.increment === "number" && P.increment > 0 ? P.increment : null;
    return crownValue(value, { min: P.min ?? null, max: P.max ?? null, increment, wrap: P.wrap === true }) ?? value;
  }

  _haptic(h) {
    this.onEvent("haptic", h);
    this.el.animate([{ boxShadow: "inset 0 0 0 3px #FF9F0A" }, { boxShadow: "inset 0 0 0 0 transparent" }], 400);
  }

  // ---- painting ---------------------------------------------------------------
  _color(v) {
    if (v === null || v === undefined) return "";
    const s = this.colors[v] ?? v;
    // only what the watch draws (ColorParse): "#RRGGBB", "#RRGGBBAA" or a token;
    // anything else (a CSS name, "#fff", rgba()) draws nothing here too
    if (typeof s !== "string" || !/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return "";
    if (/^#[0-9a-fA-F]{8}$/.test(s)) {
      const n = parseInt(s.slice(1), 16);
      return `rgba(${(n >>> 24) & 255},${(n >>> 16) & 255},${(n >>> 8) & 255},${(n & 255) / 255})`;
    }
    return s;
  }

  _paint() {
    const seen = new Set();
    const t = this.tree;
    // Children in order; an element already in place is not touched (moving
    // a button between pointerdown and pointerup would swallow the click).
    // `first`: a drawing of the node's own that its children go after.
    const paintChildren = (n, parentEl, first = null) => {
      let prev = first;
      for (const c of n.children) if (t._hasLayout(c)) prev = paintNode(c, parentEl, prev);
    };
    const paintNode = (n, parentEl, prevEl) => {
      seen.add(n.tag);
      let el = this.els.get(n.tag);
      if (!el) {
        el = document.createElement("div");
        el.dataset.tag = n.tag;
        el.dataset.type = n.type;
        el.style.position = "absolute";
        el.style.boxSizing = "border-box";
        if (n.type === "button") this._wireButton(el, n);
        if (n.type === "toggle") this._wireToggle(el, n);
        this.els.set(n.tag, el);
      }
      const y = n.yoga;
      Object.assign(el.style, {
        left: y.getComputedLeft() + "px",
        top: y.getComputedTop() + "px",
        width: y.getComputedWidth() + "px",
        height: y.getComputedHeight() + "px",
      });
      const P = n.props;
      if (P.disabled && el._endPress) el._endPress(); // disabling a pressed button ends its press
      this._paintBox(el, n);
      el.style.overflow = n.type === "scroll" ? "hidden auto" : P.overflow === "hidden" || n.type === "image" ? "hidden" : "visible";
      if (n.type === "scroll") el.style.scrollbarWidth = P.showsVerticalScrollIndicator === true ? "thin" : "none";
      if (el.parentNode !== parentEl || el.previousElementSibling !== prevEl) parentEl.insertBefore(el, prevEl ? prevEl.nextSibling : parentEl.firstChild);
      if (n.measured) this._paintText(el, n);
      else if (n.type === "progress") paintChildren(n, el, this._paintProgress(el, n));
      else if (n.type === "toggle") this._paintToggle(el, n);
      else if (n.type === "icon") this._paintIcon(el, n);
      else if (n.type === "image") this._paintImage(el, n);
      else paintChildren(n, el);
      if (n.type === "button" || n.type === "toggle") this._dimContent(el, n); // children made just now
      return el;
    };
    paintChildren(t.root, this.screen);
    for (const [tag, el] of this.els) {
      if (!seen.has(tag)) {
        if (el._endPress) el._endPress(); // a pressed button leaving the screen ends its press
        el.remove();
        this.els.delete(tag);
      }
    }
  }

  // Box paint (README: Drawing): background, border, corners, opacity,
  // rotate/scale, and a button's or toggle's pressed and disabled looks.
  _paintBox(el, n) {
    const P = n.props;
    const pressed = n.type === "button" && !P.disabled && !!el.dataset.pressed;
    el.style.background = (pressed && this._color(P.pressedBackground)) || this._color(P.background);
    // each corner at most half the shorter side (as the Swift host draws it)
    const r = P.borderRadius ?? 0;
    const half = Math.max(0, Math.min(n.yoga.getComputedWidth(), n.yoga.getComputedHeight()) / 2);
    const corner = (k) => Math.max(0, Math.min(typeof P[k] === "number" ? P[k] : r, half)) + "px";
    el.style.borderRadius = [corner("borderTopLeftRadius"), corner("borderTopRightRadius"), corner("borderBottomRightRadius"), corner("borderBottomLeftRadius")].join(" ");
    el.style.border = P.borderWidth ? `${P.borderWidth}px solid ${this._color(P.borderColor) || "transparent"}` : "";
    // numbers as the Swift host decodes them: anything else is the default
    const num = (k, d) => (typeof P[k] === "number" && Number.isFinite(P[k]) ? P[k] : d);
    el.style.opacity = String(num("opacity", 1));
    if (n.type === "button") el.style.cursor = P.disabled === true ? "default" : "pointer";
    if (n.type === "toggle") el.style.cursor = P.onChange && P.disabled !== true ? "pointer" : "";
    const scale = num("scale", 1) * (pressed ? num("pressedScale", 1) : 1);
    const rotate = num("rotate", 0);
    el.style.transform = [rotate ? `rotate(${rotate}deg)` : "", scale !== 1 ? `scale(${scale})` : ""].join(" ").trim();
    this._dimContent(el, n);
  }

  // A button's content (not its box) at pressedOpacity while pressed and
  // x 0.35 when disabled; a disabled toggle's drawing x 0.35 (README:
  // Opacity and transforms compose). On the child elements, as a filter
  // (their own opacity is their own paint).
  _dimContent(el, n) {
    const P = n.props;
    let f = 1;
    if (n.type === "button") {
      if (P.disabled === true) f = 0.35;
      else if (el.dataset.pressed) f = typeof P.pressedOpacity === "number" && Number.isFinite(P.pressedOpacity) ? P.pressedOpacity : 0.6;
    }
    if (n.type === "toggle" && P.disabled === true) f = 0.35;
    for (const c of el.children) c.style.filter = f < 1 ? `opacity(${f})` : "";
  }

  // A drawing of the node's own, the first child element: re-created only when
  // `key` changes. Returns it.
  _deco(el, key, draw) {
    let d = el.firstElementChild && el.firstElementChild.dataset.deco ? el.firstElementChild : null;
    if (d && d.dataset.deco === key) return d;
    const fresh = document.createElement("div");
    fresh.dataset.deco = key;
    draw(fresh);
    if (d) d.replaceWith(fresh);
    else el.insertBefore(fresh, el.firstChild);
    return fresh;
  }

  _paintProgress(el, n) {
    const P = n.props, D = this.tree.schema.nodes.progress.props;
    const v = progressValue(P.value ?? D.value.default);
    const shape = P.shape ?? D.shape.default;
    const color = (this._color(P.color ?? D.color.default) || "#FFFFFF"), track = (this._color(P.trackColor ?? D.trackColor.default) || "#FFFFFF");
    const y = n.yoga;
    const probe = { style: {} };
    const { w, h } = contentBox(probe, y);
    const key = JSON.stringify([v, shape, color, track, P.thickness ?? D.thickness.default, probe.style]);
    return this._deco(el, key, (d) => {
      Object.assign(d.style, probe.style);
      if (shape === "bar") {
        const vertical = h > w;
        Object.assign(d.style, { borderRadius: Math.min(w, h) / 2 + "px", background: track, overflow: "hidden" });
        if (v > 0) {
          const f = document.createElement("div");
          Object.assign(f.style, { position: "absolute", background: color }, vertical ? { left: "0", bottom: "0", width: "100%", height: v * h + "px" } : { left: "0", top: "0", height: "100%", width: v * w + "px" });
          d.appendChild(f);
        }
        return;
      }
      const g = ringGeometry(w, h, P.thickness ?? D.thickness.default);
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
      svg.style.overflow = "visible";
      const C = 2 * Math.PI * g.r, part = shape === "arc" ? 0.75 : 1, from = shape === "arc" ? 135 : -90;
      const circle = (stroke, len) => {
        const c = document.createElementNS(SVG, "circle");
        for (const [k, val] of Object.entries({ cx: g.cx, cy: g.cy, r: g.r, fill: "none", stroke, "stroke-width": g.t, "stroke-linecap": "round", transform: `rotate(${from} ${g.cx} ${g.cy})` })) c.setAttribute(k, String(val));
        if (len < C) c.setAttribute("stroke-dasharray", `${len} ${C}`);
        svg.appendChild(c);
      };
      if (g.r > 0 && g.t > 0) {
        circle(track, part * C);
        if (v > 0) circle(color, v * part * C);
      }
      d.appendChild(svg);
    });
  }

  _paintToggle(el, n) {
    const P = n.props, D = this.tree.schema.nodes.toggle.props;
    const on = P.value === true;
    const probe = { style: {} };
    const { w, h } = contentBox(probe, n.yoga);
    const track = this._color(on ? (P.activeTrackColor ?? D.activeTrackColor.default) : (P.inactiveTrackColor ?? D.inactiveTrackColor.default)) || "#FFFFFF";
    const thumb = this._color(P.thumbColor ?? D.thumbColor.default) || "#FFFFFF";
    const k = toggleKnob(on, w, h);
    this._deco(el, JSON.stringify([on, track, thumb, probe.style]), (d) => {
      Object.assign(d.style, probe.style, { borderRadius: h / 2 + "px", background: track });
      const knob = document.createElement("div");
      Object.assign(knob.style, { position: "absolute", left: k.x + "px", top: k.y + "px", width: k.d + "px", height: k.d + "px", borderRadius: "50%", background: thumb });
      d.appendChild(knob);
    });
  }

  // The browser has no SF Symbols: a placeholder of the symbol's size, in its colour.
  _paintIcon(el, n) {
    const P = n.props, D = this.tree.schema.nodes.icon.props;
    const probe = { style: {} };
    contentBox(probe, n.yoga);
    const name = P.name ?? null, size = P.size ?? D.size.default, color = this._color(P.color ?? D.color.default) || "#FFFFFF";
    el.title = name ?? "";
    this._deco(el, JSON.stringify([name, size, color, probe.style]), (d) => {
      Object.assign(d.style, probe.style, { display: "flex", alignItems: "center", justifyContent: "center" });
      if (name === null) return;
      const g = document.createElement("div");
      const s = Math.max(0, size * 0.8);
      Object.assign(g.style, { width: s + "px", height: s + "px", border: `1px dashed ${color}`, borderRadius: s * 0.25 + "px", boxSizing: "border-box", flex: "none" });
      g.dataset.symbol = name;
      d.appendChild(g);
    });
  }

  _paintImage(el, n) {
    const P = n.props, D = this.tree.schema.nodes.image.props;
    const src = imageSource(P.source ?? null);
    const probe = { style: {} };
    const { w, h } = contentBox(probe, n.yoga);
    const mode = P.resizeMode ?? D.resizeMode.default, tint = this._color(P.tintColor ?? null);
    let natural = src ? this.images.get(src) : null;
    if (src && natural === undefined) {
      const id = this.images.size + 1; // a short key for the drawing's cache key
      this.images.set(src, { id, loading: true });
      const img = new Image();
      img.onload = () => {
        this.images.set(src, { id, w: img.naturalWidth / 2, h: img.naturalHeight / 2 });
        if (!this.disposed) this._paint();
      };
      img.onerror = () => this.images.set(src, { id, failed: true });
      img.src = src;
    }
    natural = src ? this.images.get(src) : null;
    const ready = src && natural && !natural.loading && !natural.failed;
    const r = ready ? imageRect(mode, natural.w, natural.h, w, h) : null;
    this._deco(el, JSON.stringify([ready ? natural.id : null, r, tint, probe.style]), (d) => {
      Object.assign(d.style, probe.style, { overflow: "hidden" });
      if (!r) return;
      const pic = document.createElement("div");
      Object.assign(pic.style, { position: "absolute", left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
      if (tint) Object.assign(pic.style, { background: tint, maskImage: `url("${src}")`, webkitMaskImage: `url("${src}")`, maskSize: "100% 100%", webkitMaskSize: "100% 100%" });
      else Object.assign(pic.style, { backgroundImage: `url("${src}")`, backgroundSize: "100% 100%" });
      d.appendChild(pic);
    });
  }

  _paintText(el, n) {
    const m = n.measured, P = n.props;
    const key = JSON.stringify([m.fontSize, m.lines, m.runs, P.numberOfLines, P.minScale, P.textAlign]);
    if (el.dataset.paintKey === key) return; // unchanged: keep the element under the pointer
    el.dataset.paintKey = key;
    const scale = m.fontSize / (P.fontSize ?? 16);
    el.textContent = "";
    const inner = document.createElement("div");
    const L = m.runs.length ? m.runs.reduce((h, r) => Math.max(h, (r.lineHeight ?? r.fontSize * this.tree.measurer.lineHeightRatio) * scale), 0) : 0;
    Object.assign(inner.style, {
      lineHeight: L + "px",
      whiteSpace: m.lines === 1 && (P.minScale < 1 || P.numberOfLines === 1) ? "pre" : "pre-wrap",
      overflowWrap: "anywhere",
      textAlign: P.textAlign ?? "left",
      overflow: "hidden",
      textOverflow: "ellipsis",
      position: "absolute",
      inset: "0",
      padding: "inherit",
    });
    if ((P.numberOfLines ?? 0) > 1) Object.assign(inner.style, { display: "-webkit-box", webkitBoxOrient: "vertical", webkitLineClamp: String(P.numberOfLines) });
    for (const r of m.runs) {
      const s = document.createElement("span");
      cssFont(s, r, scale);
      s.style.color = this._color(r.color) || "#FFFFFF";
      s.textContent = r.text;
      inner.appendChild(s);
    }
    el.appendChild(inner);
  }

  _wireButton(el, n) {
    // Only the box paint changes: repainting here would replace the text
    // element under the pointer and the browser would drop the click.
    let hold = null;
    let longPressed = false;
    // pressIn sent, pressOut owed (README: Behaviour): exactly one per pressIn
    let pressedIn = false;
    const press = (on) => {
      if (on) el.dataset.pressed = "1";
      else delete el.dataset.pressed;
      this._paintBox(el, n);
    };
    const pressOut = () => {
      if (!pressedIn) return;
      pressedIn = false;
      if (n.props.onPressOut) this.dispatch(n.tag, "pressOut", null);
    };
    // The press ends without a lift: the button disabled or gone. Called while
    // painting (inside a commit), so the pressOut goes after it, as an event.
    el._endPress = () => {
      pageClearTimeout(hold);
      hold = null;
      if (el.dataset.pressed) press(false);
      if (!pressedIn) return;
      pressedIn = false;
      if (n.props.onPressOut) pageSetTimeout(() => this.dispatch(n.tag, "pressOut", null), 0);
    };
    el.addEventListener("pointerdown", () => {
      longPressed = false;
      if (n.props.disabled) return;
      press(true);
      pressedIn = true;
      if (n.props.onPressIn) this.dispatch(n.tag, "pressIn", null);
      pageClearTimeout(hold);
      if (n.props.onLongPress) {
        hold = pageSetTimeout(() => {
          hold = null;
          if (!el.dataset.pressed || n.props.disabled || !n.props.onLongPress) return;
          longPressed = true;
          this.dispatch(n.tag, "longPress", null);
        }, LONG_PRESS_MS);
      }
    });
    const end = () => {
      pageClearTimeout(hold);
      hold = null;
      if (el.dataset.pressed) press(false);
      pressOut();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointerleave", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (longPressed) {
        longPressed = false;
        return; // the release that ends a long press is not a press
      }
      if (n.props.disabled || !n.props.onPress) return;
      this.dispatch(n.tag, "press", null);
    });
  }

  _wireToggle(el, n) {
    el.addEventListener("click", (e) => {
      if (n.props.disabled || !n.props.onChange) return; // a bare toggle: the tap is its button's
      e.stopPropagation();
      this.dispatch(n.tag, "change", !(n.props.value === true));
    });
  }
}
