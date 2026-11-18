import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import XCTest
@testable import SolidWatch

/// Draws every page of the gallery bundle (test/bundles/gallery: every core
/// control and style prop) with SwiftUI, in the schema font, at the watch's
/// 2x. Each page must draw, and differently from the others. With
/// SOLID_WATCH_SNAPSHOTS=<dir> the pages are written there as PNGs
/// (gallery-<n>-<name>.png) for a person to look at.
@MainActor
final class GalleryTests: XCTestCase {
    static let pages = ["buttons", "toggles", "crown", "progress", "icons", "text", "colors", "list"]
    /// ImageRenderer "does not render views provided by native platform
    /// frameworks", and SwiftUI's ScrollView is one (NSScrollView here): a
    /// scroll's content is drawn on the watch (the simulator screenshots),
    /// not in these images.
    static let scrollPages: Set = ["list"]

    func testEveryPageDraws() throws {
        let font = Fx.packageRoot.appendingPathComponent("fonts/Inter-roman.ttf")
        _ = try Fonts.register(font)
        Fonts.family = CoreSchema.fontFamily
        defer { Fonts.family = nil }
        let (src, sha) = try Gallery.bundle()
        let session = SolidWatchSession()
        let size = CGSize(width: 198, height: 242)
        session.load(src, expectedSHA256: sha)
        session.setViewport(size)
        let out = ProcessInfo.processInfo.environment["SOLID_WATCH_SNAPSHOTS"].map { URL(fileURLWithPath: $0) }
        if let out { try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true) }
        var digests: [String: Int] = [:]
        for (i, name) in Self.pages.enumerated() {
            session.setState(["page": .number(Double(i))])
            XCTAssertNil(session.error, name)
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
            let r = ImageRenderer(content: MountView(session: session).frame(width: size.width, height: size.height).background(Color.black))
            r.scale = 2
            let image = try XCTUnwrap(r.cgImage, name)
            XCTAssertEqual(image.width, 396, name)
            let data = try XCTUnwrap(image.dataProvider?.data as Data?, name)
            XCTAssertNil(digests[JSHost.sha256Hex(data)], "\(name) draws the same as page \(digests[JSHost.sha256Hex(data)] ?? -1)")
            digests[JSHost.sha256Hex(data)] = i
            if !Self.scrollPages.contains(name) {
                XCTAssertGreaterThan(Self.litPixels(image), 5000, "\(name): its controls are drawn")
            }
            if let out {
                let url = out.appendingPathComponent("gallery-\(i)-\(name).png")
                let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
                CGImageDestinationAddImage(dest, image, nil)
                XCTAssertTrue(CGImageDestinationFinalize(dest), url.path)
            }
        }
    }

    /// An icon or image that draws nothing (no name; an SVG source) still
    /// draws its own box paint: its content is not an EmptyView, whose
    /// modifiers SwiftUI drops.
    func testEmptyIconAndImageKeepTheirBoxPaint() throws {
        let bundle = """
        globalThis.__app = {
          mount(root) {
            const h = globalThis.__host;
            for (const [type, x, extra] of [["icon", 0, []], ["image", 50, [["source", "data:image/svg+xml;base64,PHN2Zy8+"]]]]) {
              const t = h.createNode(type);
              for (const [k, v] of [["position", "absolute"], ["left", x], ["top", 0], ["width", 40], ["height", 40], ["background", "#FF0000"], ...extra]) h.setProp(t, k, v);
              h.insert(root, t, 0);
            }
            h.commit();
          },
          onState() {}, dispatch() { return false; }, timer() { return false; },
        };
        """
        let session = SolidWatchSession()
        session.makeMeasurer = { StubTextMeasurer() }
        session.load(Data(bundle.utf8))
        let size = CGSize(width: 100, height: 40)
        session.setViewport(size)
        XCTAssertNil(session.error)
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        let r = ImageRenderer(content: MountView(session: session).frame(width: size.width, height: size.height).background(Color.black))
        let image = try XCTUnwrap(r.cgImage)
        // two red 40 x 40 boxes at scale 1
        XCTAssertEqual(Self.litPixels(image), 2 * 40 * 40, accuracy: 80)
    }

    /// Pixels brighter than black.
    static func litPixels(_ image: CGImage) -> Int {
        let w = image.width, h = image.height
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        var n = 0
        for i in stride(from: 0, to: px.count, by: 4) where Int(px[i]) + Int(px[i + 1]) + Int(px[i + 2]) > 60 { n += 1 }
        return n
    }
}
