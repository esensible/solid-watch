import ImageIO
import SwiftUI

/// Draws a session's tree: every node at its Yoga frame (ZStack topLeading +
/// frame + offset). Each node view observes only its own `NodeModel`, so a
/// commit re-evaluates only the nodes that changed. Shows the error screen
/// when the bundle failed. On the watch, an attached `crown` node gets the
/// Digital Crown (README: Behaviour).
public struct MountView: View {
    @ObservedObject var session: SolidWatchSession
    @ObservedObject var store: NodeStore

    public init(session: SolidWatchSession) {
        self.session = session
        store = session.store
    }

    public var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                if let e = session.error {
                    SolidErrorView(error: e)
                } else if let root = store.root {
                    // Tags are unique only within one mounted tree: a new
                    // bundle (or a remount) numbers its nodes from the same
                    // tags again. Keyed by the root's model, each mount gets
                    // fresh views rather than the last tree's views fed new
                    // models.
                    NodeView(model: root, ctx: MountContext(session: session))
                        .id(ObjectIdentifier(root))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            #if os(watchOS)
            .modifier(CrownHost(session: session, binding: session.crown))
            #endif
            .onAppear { session.setViewport(geo.size) }
            .onChange(of: geo.size) { _, size in session.setViewport(size) }
        }
    }
}

/// The error screen for a failed bundle.
public struct SolidErrorView: View {
    public let error: JSHostError
    public init(error: JSHostError) { self.error = error }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text(error.title).font(.headline).foregroundColor(.red)
                Text(error.description)
                    .font(.system(size: 11, design: .monospaced))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Shared, identity-stable inputs of every node view.
struct MountContext: Equatable {
    unowned let session: SolidWatchSession
    var store: NodeStore { session.store }

    static func == (a: MountContext, b: MountContext) -> Bool { a.session === b.session }
}

extension RGBA {
    var color: Color { Color(.sRGB, red: r, green: g, blue: b, opacity: a) }
}

struct NodeView: View {
    @ObservedObject var model: NodeModel
    let ctx: MountContext

    var body: some View {
        let n = model.node
        let _ = ctx.store.noteBody()
        if case .button(let b)? = n.control {
            ButtonNodeView(node: n, props: b, session: ctx.session) { ChildrenView(node: n, ctx: ctx) }
                .offset(x: n.frame.minX, y: n.frame.minY)
        } else {
            content(n)
                .frame(width: n.frame.width, height: n.frame.height, alignment: .topLeading)
                .modifier(PaintModifier(paint: n.paint))
                .modifier(TransformModifier(rotate: n.paint.rotate, scale: n.paint.scale))
                .offset(x: n.frame.minX, y: n.frame.minY)
        }
    }

    @ViewBuilder
    private func content(_ n: LayoutNode) -> some View {
        switch n.control {
        case .scroll(let s)?:
            ScrollView(.vertical, showsIndicators: s.showsVerticalScrollIndicator) {
                ChildrenView(node: n, ctx: ctx)
                    .frame(width: n.frame.width, height: n.contentHeight, alignment: .topLeading)
            }
            .frame(width: n.frame.width, height: n.frame.height)
        case let .toggle(p, on, off, thumb)?:
            ToggleNodeView(node: n, props: p, on: on, off: off, thumb: thumb, session: ctx.session)
        case let .progress(p, color, track)?:
            ZStack(alignment: .topLeading) {
                ProgressDrawing(props: p, color: color, track: track, box: n.contentRect)
                ChildrenView(node: n, ctx: ctx)
            }
        case let .icon(p, color)?:
            IconDrawing(props: p, color: color, box: n.contentRect)
        case let .image(p, tint)?:
            ImageDrawing(props: p, tint: tint, box: n.contentRect)
        default:
            if n.type == "text" {
                TextLeafView(node: n)
            } else if let v = ctx.session.registry.views[n.type] {
                v.view(CustomNodeContext(
                    node: n, children: AnyView(ChildrenView(node: n, ctx: ctx)),
                    dispatch: { [weak session = ctx.session] name, payload in
                        session?.dispatch(tag: n.tag, name: name, payload: payload)
                    }))
            } else {
                ChildrenView(node: n, ctx: ctx)
            }
        }
    }
}

struct ChildrenView: View {
    let node: LayoutNode
    let ctx: MountContext

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(node.children, id: \.self) { t in
                if let m = ctx.store.model(t) { NodeView(model: m, ctx: ctx) }
            }
        }
        .frame(width: node.frame.width, height: node.type == "scroll" ? node.contentHeight : node.frame.height,
               alignment: .topLeading)
    }
}

/// A box with per-corner radii, continuous corners (each radius at most half
/// the shorter side: `Controls.fitted`).
struct CornersShape: InsettableShape {
    var corners: CornerRadii
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let c = Controls.fitted(corners, in: rect.size)
        func r(_ v: CGFloat) -> CGFloat { max(0, v - inset) }
        return UnevenRoundedRectangle(
            topLeadingRadius: r(c.topLeft), bottomLeadingRadius: r(c.bottomLeft),
            bottomTrailingRadius: r(c.bottomRight), topTrailingRadius: r(c.topRight), style: .continuous)
            .path(in: rect.insetBy(dx: inset, dy: inset))
    }

    func inset(by amount: CGFloat) -> CornersShape {
        var s = self
        s.inset += amount
        return s
    }
}

struct PaintModifier: ViewModifier {
    let paint: Paint

    func body(content: Content) -> some View {
        if let c = paint.corners {
            painted(content, CornersShape(corners: c))
        } else {
            painted(content, RoundedRectangle(cornerRadius: paint.borderRadius, style: .continuous))
        }
    }

    @ViewBuilder
    private func painted<S: InsettableShape>(_ content: Content, _ shape: S) -> some View {
        let painted = content
            .background(paint.background.map { shape.fill($0.color) })
            .overlay {
                if let bc = paint.borderColor, paint.borderWidth > 0 {
                    shape.strokeBorder(bc.color, lineWidth: paint.borderWidth)
                }
            }
        if paint.clips {
            painted.clipShape(shape).opacity(paint.opacity)
        } else {
            painted.opacity(paint.opacity)
        }
    }
}

/// `rotate` / `scale` about the centre, drawing only (the frame is Yoga's).
/// Always applied (at 0 and 1 they draw nothing different): a conditional
/// would change the view's identity when a value crosses its default,
/// rebuilding everything under it (a button mid-press, a needle at north).
struct TransformModifier: ViewModifier {
    let rotate: Double
    let scale: Double

    func body(content: Content) -> some View {
        content.scaleEffect(scale).rotationEffect(.degrees(rotate))
    }
}

// MARK: - text

func styledText(_ runs: [TextRun]) -> Text {
    runs.reduce(Text("")) { acc, r in
        var t = Text(r.text).font(Font(Fonts.ctFont(r.style, size: r.style.fontSize)))
            .foregroundColor(r.style.color.color)
        if r.style.letterSpacing != 0 { t = t.kerning(r.style.letterSpacing) }
        return acc + t
    }
}

extension TextAlign {
    var horizontal: HorizontalAlignment {
        switch self {
        case .left: return .leading
        case .center: return .center
        case .right: return .trailing
        }
    }

    var frame: Alignment {
        switch self {
        case .left: return .topLeading
        case .center: return .top
        case .right: return .topTrailing
        }
    }
}

/// Draws the lines the shadow tree measured, one `Text` per line (so the
/// breaks are the measured ones), each in a box of the measured line height.
struct TextLeafView: View {
    let node: LayoutNode

    var body: some View {
        if let t = node.text {
            let rect = node.contentRect
            VStack(alignment: t.align.horizontal, spacing: 0) {
                ForEach(Array(t.lines.enumerated()), id: \.offset) { i, line in
                    let last = i == t.lines.count - 1
                    if last && t.measured.truncated {
                        styledText(line).lineLimit(1).truncationMode(.tail)
                            .frame(maxWidth: rect.width, alignment: t.align.frame)
                            .frame(height: t.measured.lineHeight)
                    } else {
                        styledText(line).lineLimit(1).fixedSize()
                            .frame(height: t.measured.lineHeight)
                    }
                }
            }
            .frame(width: rect.width, alignment: t.align.frame)
            .offset(x: rect.minX, y: rect.minY)
        }
    }
}

// MARK: - button

/// The pressed look of a button's content; reports the pressed state to
/// the button (for pressedScale and pressedBackground, which apply to the
/// whole button).
struct PressStyle: ButtonStyle {
    var pressedOpacity: Double = 0.6
    var pressed: Binding<Bool>?

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? pressedOpacity : 1)
            .onChange(of: configuration.isPressed) { _, p in pressed?.wrappedValue = p }
    }
}

struct ButtonNodeView<Label: View>: View {
    let node: LayoutNode
    let props: ButtonProps
    let session: SolidWatchSession
    @ViewBuilder let label: () -> Label
    @State private var pressed = false
    /// A long press fired during this touch: its release is not a press.
    @State private var longPressed = false
    /// While a press is reported (pressIn sent): the bundle it was sent to,
    /// which gets the one pressOut that ends it.
    @State private var pressedIn: Int?

    var body: some View {
        let disabled = props.disabled
        let down = pressed && !disabled
        var paint = node.paint
        if down, let pb = props.pressedBackground, let c = session.registry.color(pb) { paint.background = c }
        let scale = node.paint.scale * (down ? props.pressedScale : 1)
        return Button {
            if longPressed {
                longPressed = false
                return
            }
            session.press(node)
        } label: {
            label().contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(pressedOpacity: props.pressedOpacity, pressed: $pressed))
        .modifier(LongPress(enabled: props.onLongPress && !disabled) {
            longPressed = true
            session.longPress(node)
        })
        .onChange(of: pressed) { _, p in if p { longPressed = false } }
        // pressIn / pressOut follow the Button's own pressed state (its
        // style's isPressed: down on touch-down, up on lift, slide-off or
        // cancel, a scroll taking the touch included); disabling ends a
        // press, and so does the button leaving the screen.
        .onChange(of: down) { _, d in if d { beginPress() } else { endPress() } }
        .onDisappear { endPress() }
        .disabled(disabled)
        .opacity(disabled ? 0.35 : 1)
        .frame(width: node.frame.width, height: node.frame.height, alignment: .topLeading)
        .modifier(PaintModifier(paint: paint))
        .modifier(TransformModifier(rotate: node.paint.rotate, scale: scale))
    }

    private func beginPress() {
        guard pressedIn == nil else { return }
        pressedIn = session.pressIn(node)
    }

    private func endPress() {
        guard let g = pressedIn else { return }
        pressedIn = nil
        session.pressOut(node, pressedIn: g)
    }
}

/// A button's onLongPress: a hold of 0.5 s, alongside the button's own tap
/// (which then skips the release that ends the hold). Nothing is added
/// without one, so a plain button is the plain SwiftUI Button.
struct LongPress: ViewModifier {
    let enabled: Bool
    let action: () -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in action() })
        } else {
            content
        }
    }
}

// MARK: - toggle

struct ToggleNodeView: View {
    let node: LayoutNode
    let props: ToggleProps
    let on: RGBA
    let off: RGBA
    let thumb: RGBA
    let session: SolidWatchSession

    var body: some View {
        let box = node.contentRect
        let k = Controls.toggleKnob(on: props.value, box.size)
        ZStack(alignment: .topLeading) {
            Capsule().fill((props.value ? on : off).color)
                .frame(width: box.width, height: box.height)
            Circle().fill(thumb.color)
                .frame(width: k.d, height: k.d)
                .offset(x: k.x, y: k.y)
        }
        .frame(width: box.width, height: box.height, alignment: .topLeading)
        .offset(x: box.minX, y: box.minY)
        .frame(width: node.frame.width, height: node.frame.height, alignment: .topLeading)
        .contentShape(Rectangle())
        .modifier(ToggleTap(enabled: props.onChange && !props.disabled) {
            session.dispatch(tag: node.tag, name: "change", payload: .bool(!props.value))
        })
        .opacity(props.disabled ? 0.35 : 1)
    }
}

/// A toggle without onChange takes no taps (they reach an enclosing button).
struct ToggleTap: ViewModifier {
    let enabled: Bool
    let action: () -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled { content.onTapGesture(perform: action) } else { content }
    }
}

// MARK: - progress

struct ProgressDrawing: View {
    let props: ProgressProps
    let color: RGBA
    let track: RGBA
    let box: CGRect

    var body: some View {
        let v = Controls.progressValue(props.value)
        Group {
            switch props.shape {
            case .bar:
                let vertical = box.height > box.width
                Capsule().fill(track.color)
                    .overlay(alignment: vertical ? .bottom : .leading) {
                        if v > 0 {
                            Rectangle().fill(color.color)
                                .frame(width: vertical ? box.width : box.width * v,
                                       height: vertical ? box.height * v : box.height)
                        }
                    }
                    .clipShape(Capsule())
                    .frame(width: box.width, height: box.height)
            case .ring, .arc:
                let g = Controls.ringGeometry(box.size, thickness: props.thickness)
                let part = props.shape == .arc ? 0.75 : 1.0
                let from: Double = props.shape == .arc ? 135 : -90
                let style = StrokeStyle(lineWidth: g.t, lineCap: .round)
                ZStack {
                    if g.r > 0 && g.t > 0 {
                        Circle().trim(from: 0, to: part).stroke(track.color, style: style)
                        if v > 0 { Circle().trim(from: 0, to: part * v).stroke(color.color, style: style) }
                    }
                }
                .frame(width: 2 * g.r, height: 2 * g.r)
                .rotationEffect(.degrees(from))
                .frame(width: box.width, height: box.height)
            }
        }
        .offset(x: box.minX, y: box.minY)
    }
}

// MARK: - icon

struct IconDrawing: View {
    let props: IconProps
    let color: RGBA
    let box: CGRect

    var body: some View {
        if let name = props.name {
            Image(systemName: name)
                .font(.system(size: max(0, props.size), weight: props.weight.font))
                .symbolRenderingMode(props.renderingMode.mode)
                .foregroundStyle(color.color)
                .fixedSize()
                .frame(width: box.width, height: box.height)
                .offset(x: box.minX, y: box.minY)
        } else {
            // not EmptyView: the node's frame and box paint still draw
            Color.clear
        }
    }
}

extension IconWeight {
    var font: Font.Weight {
        switch self {
        case .w100: return .ultraLight
        case .w200: return .thin
        case .w300: return .light
        case .normal, .w400: return .regular
        case .w500: return .medium
        case .w600: return .semibold
        case .bold, .w700: return .bold
        case .w800: return .heavy
        case .w900: return .black
        }
    }
}

extension IconRenderingMode {
    var mode: SymbolRenderingMode {
        switch self {
        case .monochrome: return .monochrome
        case .hierarchical: return .hierarchical
        case .multicolor: return .multicolor
        }
    }
}

// MARK: - image

/// Decoded images by source (data URLs repeat across commits and nodes).
enum ImageCache {
    /// At most 8 MB of decoded pixels (a watch app's memory is small).
    private static let cache: NSCache<NSString, CGImage> = {
        let c = NSCache<NSString, CGImage>()
        c.totalCostLimit = 8 << 20
        return c
    }()

    /// The decoded image, or nil (not a PNG or JPEG data URL, or undecodable).
    static func image(_ source: String?) -> CGImage? {
        guard let source else { return nil }
        let key = source as NSString
        if let hit = cache.object(forKey: key) { return hit }
        guard let data = Controls.imageData(source),
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        cache.setObject(img, forKey: key, cost: img.width * img.height * 4)
        return img
    }
}

struct ImageDrawing: View {
    let props: ImageProps
    let tint: RGBA?
    let box: CGRect

    var body: some View {
        if let cg = ImageCache.image(props.source) {
            // an image's own size: its pixel size / 2 points
            let r = Controls.imageRect(props.resizeMode, image: CGSize(width: Double(cg.width) / 2, height: Double(cg.height) / 2),
                                       box: box.size)
            ZStack(alignment: .topLeading) {
                picture(cg)
                    .frame(width: r.width, height: r.height)
                    .offset(x: r.minX, y: r.minY)
            }
            .frame(width: box.width, height: box.height, alignment: .topLeading)
            .clipped()
            .offset(x: box.minX, y: box.minY)
        } else {
            // not EmptyView: the node's frame and box paint still draw
            Color.clear
        }
    }

    @ViewBuilder
    private func picture(_ cg: CGImage) -> some View {
        let img = Image(decorative: cg, scale: 2).resizable()
        if let tint {
            img.renderingMode(.template).foregroundStyle(tint.color)
        } else {
            img
        }
    }
}

// MARK: - crown

#if os(watchOS)
/// Only a tree with a `crown` node gets the crown modifiers: without one the
/// view tree is what it was before crowns existed (scroll views keep the
/// crown).
struct CrownHost: ViewModifier {
    let session: SolidWatchSession
    let binding: LayoutSnapshot.CrownBinding?

    @ViewBuilder
    func body(content: Content) -> some View {
        if binding != nil {
            content.modifier(CrownModifier(session: session, binding: binding))
        } else {
            content
        }
    }
}

/// Gives the Digital Crown to the attached `crown` node: its position starts
/// at the node's `value` (and again whenever that changes); each turn sends
/// `change` with `Controls.crownValue` of the position when that differs
/// from the last value sent. Without a crown node nothing is focusable, so
/// scroll views keep the crown.
struct CrownModifier: ViewModifier {
    let session: SolidWatchSession
    let binding: LayoutSnapshot.CrownBinding?
    @State private var position = 0.0
    @State private var sent: Double?
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        let p = binding?.props ?? CrownProps()
        // each end bounds the crown on its own (an open end: far away)
        let lo = p.min ?? -1e12
        let hi = Swift.max(p.max ?? 1e12, lo + 1e-9)
        let bounded = p.min != nil && p.max != nil && p.max! > p.min!
        let increment = p.increment.flatMap { $0 > 0 ? $0 : nil }
        content
            .focusable(binding != nil)
            .focusEffectDisabled()
            .focused($focused)
            .digitalCrownRotation($position, from: lo, through: hi, by: increment,
                                  sensitivity: p.sensitivity.digital, isContinuous: p.wrap && bounded,
                                  isHapticFeedbackEnabled: true)
            .onChange(of: position) { _, raw in
                guard let b = binding, b.props.onChange, let v = Controls.crownValue(raw, b.props), v != sent else { return }
                sent = v
                session.dispatch(tag: b.tag, name: "change", payload: .number(v))
            }
            .onChange(of: binding, initial: true) { old, new in
                focused = new != nil
                guard let new else { return }
                if old?.tag != new.tag || old?.props.value != new.props.value || sent == nil { seat(new.props) }
            }
    }

    /// Puts the crown at the app's value. `sent` is what that position reads
    /// as, so moving it there sends nothing (an off-grid or out-of-range
    /// value is not a turn).
    private func seat(_ p: CrownProps) {
        sent = Controls.crownValue(p.value, p) ?? p.value
        position = p.value
    }
}

extension CrownSensitivity {
    var digital: DigitalCrownRotationalSensitivity {
        switch self {
        case .low: return .low
        case .medium: return .medium
        case .high: return .high
        }
    }
}
#endif
