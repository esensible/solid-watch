import CoreGraphics
import Foundation

/// The rules of the core controls that are more than paint (README:
/// Behaviour): a line-for-line port of the browser host's
/// `browser/controls.js`; both are held to `fixtures/controls.json`.
public enum Controls {
    /// JS `Math.round` (halves up, also below zero).
    static func jsRound(_ v: Double) -> Double {
        let r = v.rounded(.down)
        return v - r >= 0.5 ? r + 1 : r
    }

    /// Round to 1e-9, so steps of 0.1 give 0.3, not 0.30000000000000004; no -0.
    static func tidy(_ v: Double) -> Double {
        let t = jsRound(v * 1e9) / 1e9
        return t == 0 ? 0 : t
    }

    /// The value a `crown` sends for a raw crown position `v`: with `wrap`
    /// (and min < max) brought into [min, max); else kept in [min, max]
    /// (either end may be nil = open); with `increment`, snapped to min (or 0) +
    /// k x increment and kept on that grid inside the range where it fits.
    public static func crownValue(_ v: Double, min lo: Double?, max hi: Double?, increment: Double?, wrap: Bool) -> Double? {
        guard v.isFinite else { return nil }
        let lo = lo.flatMap { $0.isFinite ? $0 : nil }, hi = hi.flatMap { $0.isFinite ? $0 : nil }
        let st = increment.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let base = lo ?? 0
        func snap(_ x: Double) -> Double {
            guard let st else { return x }
            return base + jsRound((x - base) / st) * st
        }
        if wrap, let lo, let hi, hi > lo {
            let span = hi - lo
            func into(_ x: Double) -> Double {
                lo + ((x - lo).truncatingRemainder(dividingBy: span) + span).truncatingRemainder(dividingBy: span)
            }
            return tidy(into(tidy(snap(into(v)))))
        }
        func clamp(_ x: Double) -> Double {
            if let lo, x < lo { return lo }
            if let hi, x > hi { return hi }
            return x
        }
        var x = snap(clamp(v))
        if let st, let hi, x > hi { x -= st }
        if let st, let lo, x < lo { x += st }
        return tidy(clamp(x))
    }

    public static func crownValue(_ v: Double, _ p: CrownProps) -> Double? {
        crownValue(v, min: p.min, max: p.max, increment: p.increment, wrap: p.wrap)
    }

    /// Where an image of natural size `image` (points: pixels / 2) is drawn
    /// in a box of size `box`, for a resizeMode (relative to the box, which
    /// clips it).
    public static func imageRect(_ mode: ImageResizeMode, image: CGSize, box: CGSize) -> CGRect {
        let (iw, ih, bw, bh) = (Double(image.width), Double(image.height), Double(box.width), Double(box.height))
        if mode == .stretch || !(iw > 0) || !(ih > 0) { return CGRect(x: 0, y: 0, width: bw, height: bh) }
        let k: Double
        switch mode {
        case .contain: k = Swift.min(bw / iw, bh / ih)
        case .center: k = Swift.min(1, bw / iw, bh / ih)
        default: k = Swift.max(bw / iw, bh / ih) // cover
        }
        let w = iw * k, h = ih * k
        return CGRect(x: (bw - w) / 2, y: (bh - h) / 2, width: w, height: h)
    }

    /// A progress value as drawn: 0...1 (anything else, NaN included, is clamped / 0).
    public static func progressValue(_ v: Double) -> Double { v > 0 ? Swift.min(v, 1) : 0 }

    /// A ring's or arc's circle in a content box: the largest centred
    /// square, stroked `thickness` wide inside it (r: the stroke's centre line).
    public static func ringGeometry(_ box: CGSize, thickness: Double) -> (cx: Double, cy: Double, r: Double, t: Double) {
        let d = Swift.max(0, Swift.min(Double(box.width), Double(box.height)))
        let t = Swift.max(0, Swift.min(thickness.isFinite ? thickness : 0, d / 2))
        return (Double(box.width) / 2, Double(box.height) / 2, Swift.max(0, (d - t) / 2), t)
    }

    /// A toggle's knob in a content box: origin and diameter.
    public static func toggleKnob(on: Bool, _ box: CGSize) -> (x: Double, y: Double, d: Double) {
        let d = Swift.max(0, Double(box.height) - 4)
        return (on ? Swift.max(2, Double(box.width) - d - 2) : 2, 2, d)
    }

    /// The bytes of a PNG or JPEG data URL; nil for anything else.
    public static func imageData(_ source: String?) -> Data? {
        guard let s = source else { return nil }
        for prefix in ["data:image/png;base64,", "data:image/jpeg;base64,"] where s.hasPrefix(prefix) {
            return Data(base64Encoded: String(s.dropFirst(prefix.count)))
        }
        return nil
    }

    /// Corner radii as drawn in a box: each at most half its shorter side
    /// (both hosts, so no corner rule of the drawing library applies).
    public static func fitted(_ c: CornerRadii, in size: CGSize) -> CornerRadii {
        let h = Swift.max(0, Swift.min(size.width, size.height) / 2)
        func f(_ r: CGFloat) -> CGFloat { Swift.max(0, Swift.min(r, h)) }
        return CornerRadii(topLeft: f(c.topLeft), topRight: f(c.topRight), bottomRight: f(c.bottomRight), bottomLeft: f(c.bottomLeft))
    }
}
