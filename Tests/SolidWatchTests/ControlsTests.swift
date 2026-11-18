import XCTest
@testable import SolidWatch

/// The controls' rules agree with the browser host's (fixtures/controls.json,
/// written from browser/controls.js), and the session routes the controls'
/// events.
final class ControlsTests: XCTestCase {
    func fixture() throws -> JSData { try JSData(json: Fx.text("controls.json")) }

    func items(_ v: JSData?) -> [JSData] {
        if case .array(let a)? = v { return a }
        XCTFail("not an array")
        return []
    }

    func testCrownValueMatchesTheBrowserHost() throws {
        let cases = items(try fixture()["crown"])
        XCTAssertGreaterThan(cases.count, 10)
        for c in cases {
            let r = c["range"]
            let got = Controls.crownValue(c["v"]?.number ?? .nan, min: r?["min"]?.number, max: r?["max"]?.number,
                                          increment: r?["increment"]?.number, wrap: r?["wrap"]?.bool ?? false)
            XCTAssertEqual(got, c["out"]?.number, "\(json(c))")
        }
    }

    func testImageRectMatchesTheBrowserHost() throws {
        for c in items(try fixture()["images"]) {
            guard let mode = c["mode"]?.string.flatMap(ImageResizeMode.init(rawValue:)),
                  case .array(let i)? = c["image"], case .array(let b)? = c["box"] else { XCTFail(json(c)); continue }
            let r = Controls.imageRect(mode, image: CGSize(width: i[0].number!, height: i[1].number!),
                                       box: CGSize(width: b[0].number!, height: b[1].number!))
            let o = c["out"]
            XCTAssertEqual([r.minX, r.minY, r.width, r.height].map(Double.init),
                           [o?["x"]?.number, o?["y"]?.number, o?["w"]?.number, o?["h"]?.number].map { $0 ?? .nan }, json(c))
        }
    }

    func testRingAndKnobMatchTheBrowserHost() throws {
        let f = try fixture()
        for c in items(f["rings"]) {
            guard case .array(let b)? = c["box"] else { XCTFail(json(c)); continue }
            let g = Controls.ringGeometry(CGSize(width: b[0].number!, height: b[1].number!), thickness: c["thickness"]?.number ?? 0)
            let o = c["out"]
            XCTAssertEqual([g.cx, g.cy, g.r, g.t], [o?["cx"]?.number, o?["cy"]?.number, o?["r"]?.number, o?["t"]?.number].map { $0 ?? .nan }, json(c))
        }
        for c in items(f["knobs"]) {
            guard case .array(let b)? = c["box"] else { XCTFail(json(c)); continue }
            let k = Controls.toggleKnob(on: c["on"]?.bool ?? false, CGSize(width: b[0].number!, height: b[1].number!))
            let o = c["out"]
            XCTAssertEqual([k.x, k.y, k.d], [o?["x"]?.number, o?["y"]?.number, o?["d"]?.number].map { $0 ?? .nan }, json(c))
        }
    }

    func testImageSourcesMatchTheBrowserHost() throws {
        for c in items(try fixture()["sources"]) {
            XCTAssertEqual(Controls.imageData(c["source"]?.string) != nil, c["ok"]?.bool, json(c))
        }
    }

    func testCornerRadiiAreAtMostHalfTheShorterSide() {
        let c = Controls.fitted(CornerRadii(topLeft: 30, topRight: 0, bottomRight: 5, bottomLeft: -2), in: CGSize(width: 40, height: 20))
        XCTAssertEqual(c, CornerRadii(topLeft: 10, topRight: 0, bottomRight: 5, bottomLeft: 0))
    }

    /// The gallery bundle on a session: a toggle's change, a long press and
    /// the crown binding reach the bundle (its golden log says what each does).
    @MainActor
    func testSessionRoutesControlEvents() throws {
        let (src, sha) = try Gallery.bundle()
        let session = SolidWatchSession()
        session.makeMeasurer = { StubTextMeasurer() }
        var dispatched: [String] = []
        session.onDispatch = { tag, name in dispatched.append("\(tag) \(name)") }
        session.load(src, expectedSHA256: sha)
        session.setViewport(CGSize(width: 198, height: 242))
        session.setState(["page": 0])
        XCTAssertNil(session.error)
        let hold = try XCTUnwrap(session.snapshot?.nodes.values.first { $0.button?.onLongPress == true })
        session.longPress(hold)
        XCTAssertTrue(session.snapshot?.nodes.values.contains { $0.text?.lines.first?.map(\.text).joined() == "presses 0 · holds 1" } == true)
        XCTAssertNil(session.crown, "no crown on page 0")
        session.setState(["page": 2])
        let crown = try XCTUnwrap(session.crown)
        XCTAssertEqual(crown.props.value, 4)
        XCTAssertEqual(crown.props.increment, 0.5)
        session.dispatch(tag: crown.tag, name: "change", payload: .number(7.5))
        XCTAssertEqual(session.crown?.props.value, 7.5, "the app set the value it was sent")
        session.setState(["page": 1])
        XCTAssertNil(session.crown)
        let toggle = try XCTUnwrap(session.snapshot?.nodes.values.first {
            if case .toggle(let p, _, _, _)? = $0.control { return p.onChange }
            return false
        })
        session.dispatch(tag: toggle.tag, name: "change", payload: .bool(true))
        if case .toggle(let p, _, _, _)? = session.snapshot?.nodes[toggle.tag]?.control {
            XCTAssertTrue(p.value)
        } else {
            XCTFail("the toggle is gone")
        }
        XCTAssertEqual(dispatched, ["\(hold.tag) longPress", "\(crown.tag) change", "\(toggle.tag) change"])
    }

    /// The hold bundle on a session: pressIn / pressOut reach the bundle
    /// (only where a handler is set), and a press begun in one bundle sends
    /// no pressOut into the bundle loaded after it.
    @MainActor
    func testSessionRoutesPressInAndOut() throws {
        let dir = Fx.fixtures.appendingPathComponent("mutations/hold")
        let src = try Data(contentsOf: dir.appendingPathComponent("bundle.js"))
        let sha = String(try Fx.text("mutations/hold/bundle.js.sha256").split(separator: " ")[0])
        let session = SolidWatchSession()
        session.makeMeasurer = { StubTextMeasurer() }
        var dispatched: [String] = []
        session.onDispatch = { tag, name in dispatched.append("\(tag) \(name)") }
        session.load(src, expectedSHA256: sha)
        session.setViewport(CGSize(width: 198, height: 242))
        session.setState(["armed": true])
        XCTAssertNil(session.error)
        func button(_ text: String) throws -> LayoutNode {
            let nodes = try XCTUnwrap(session.snapshot?.nodes)
            return try XCTUnwrap(nodes.values.first { n in
                n.button != nil && n.children.contains { nodes[$0]?.text?.lines.first?.map(\.text).joined() == text }
            }, text)
        }
        func shows(_ text: String) -> Bool {
            session.snapshot?.nodes.values.contains { $0.text?.lines.first?.map(\.text).joined() == text } == true
        }
        let hold = try button("Hold")
        let g = try XCTUnwrap(session.pressIn(hold))
        XCTAssertTrue(shows("Held") && shows("in 1 out 0"))
        session.pressOut(hold, pressedIn: g)
        XCTAssertTrue(shows("Hold") && shows("in 1 out 1"))
        // the out-only button: its pressIn is no event, its pressOut is
        let outOnly = try button("Out only")
        let g2 = try XCTUnwrap(session.pressIn(outOnly))
        session.pressOut(outOnly, pressedIn: g2)
        XCTAssertTrue(shows("in 1 out 101"))
        // pressed, then another bundle (here the same one again) loaded: the old press ends silently
        let g3 = try XCTUnwrap(session.pressIn(hold))
        session.load(src, expectedSHA256: sha)
        session.setState(["armed": true])
        session.pressOut(try button("Hold"), pressedIn: g3)
        XCTAssertTrue(shows("in 0 out 0"), "the new bundle got no pressOut")
        XCTAssertEqual(dispatched, ["\(hold.tag) pressIn", "\(hold.tag) pressOut", "\(outOnly.tag) pressOut", "\(hold.tag) pressIn"])
        session.unload()
        XCTAssertNil(session.pressIn(hold), "no bundle: nothing to press")
    }
}

enum Gallery {
    static func bundle() throws -> (Data, String) {
        let dir = Fx.fixtures.appendingPathComponent("mutations/gallery")
        let src = try Data(contentsOf: dir.appendingPathComponent("bundle.js"))
        let sha = String(try Fx.text("mutations/gallery/bundle.js.sha256").split(separator: " ")[0])
        return (src, sha)
    }
}
