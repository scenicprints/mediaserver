import SwiftUI

// ============================================================================
// Marquee's visual system, after Dieter Rams.
//
// Two FINISHES of one system: "white" (the Braun housing grey) and "black" (the
// night edition). Nothing outside this file writes a hex value — every view
// reads the palette out of the environment, so switching the finish repaints
// the whole app with no per-screen code.
//
// The rule that keeps it honest: SIGNAL (Braun orange) means exactly one thing —
// where you are, or what happens next. Focus, progress, the live line, the
// primary action. Nothing decorative may use it.
//
// Sizes are generous: tvOS lays out in 1080p logical points on a 4K panel, and
// this is read from a couch, not a desk.
// ============================================================================

enum Finish: String, CaseIterable, Identifiable {
    case white, black
    var id: String { rawValue }
    var label: String { self == .white ? "White" : "Black" }
}

struct Palette {
    let paper: Color        // the housing — the page ground
    let panel: Color        // the recessed face content sits on
    let panel2: Color       // a tinted row/cell inside the panel
    let sunk: Color         // behind artwork before it loads
    let ink: Color          // the printed mark
    let ink2: Color         // secondary text
    let ink3: Color         // labels, units, the quiet layer
    let rule: Color         // structural hairline
    let rule2: Color        // divider hairline inside a group
    let signal: Color       // Braun orange. State only, never decoration.
    let signalDeep: Color   // the same switch, pressed in (a focused primary)
    let onSignal: Color     // what sits on top of the signal
    let inverse: Color      // a filled control (focused secondary button)
    let onInverse: Color
}

enum Theme {
    static let white = Palette(
        paper: Color(hex: 0xE7E6E1), panel: Color(hex: 0xF8F7F4),
        panel2: Color(hex: 0xEFEEE9), sunk: Color(hex: 0xDEDCD5),
        ink: Color(hex: 0x1A1B1D), ink2: Color(hex: 0x75756E), ink3: Color(hex: 0xA3A29B),
        rule: Color(hex: 0xCBC9C2), rule2: Color(hex: 0xDCDAD3),
        signal: Color(hex: 0xDE5F10), signalDeep: Color(hex: 0xB84A08), onSignal: .white,
        inverse: Color(hex: 0x1A1B1D), onInverse: Color(hex: 0xF8F7F4))

    static let black = Palette(
        paper: Color(hex: 0x141416), panel: Color(hex: 0x1D1D20),
        panel2: Color(hex: 0x232327), sunk: Color(hex: 0x0E0E10),
        ink: Color(hex: 0xEFEEE9), ink2: Color(hex: 0x8C8C86), ink3: Color(hex: 0x65655F),
        rule: Color(hex: 0x33333A), rule2: Color(hex: 0x28282E),
        signal: Color(hex: 0xF26A16), signalDeep: Color(hex: 0xC85410), onSignal: Color(hex: 0x141416),
        inverse: Color(hex: 0xEFEEE9), onInverse: Color(hex: 0x141416))

    static func palette(_ f: Finish) -> Palette { f == .white ? white : black }

    // ---- Layout. A strict grid; hairlines divide, boxes don't. ----
    static let gutter: CGFloat = 80          // title-safe side margin
    static let railHeight: CGFloat = 104     // the top rail
    static let posterWidth: CGFloat = 156
    static let posterHeight: CGFloat = 234
    static let cardSpacing: CGFloat = 26
    static let rowSpacing: CGFloat = 34
    static let hairline: CGFloat = 2         // 1pt is a single pixel on a 1080p set
}

// ---- Type. Archivo for anything a person reads, Roboto Mono for anything a
// machine produced: filenames, timecodes, sizes, bitrates. Two faces, no more.
// Fixed sizes on purpose — this is a fixed 1920x1080 canvas, not a document. ----
enum F {
    static func reg(_ s: CGFloat) -> Font { .custom("Archivo-Regular", fixedSize: s) }
    static func med(_ s: CGFloat) -> Font { .custom("Archivo-Medium", fixedSize: s) }
    static func semi(_ s: CGFloat) -> Font { .custom("Archivo-SemiBold", fixedSize: s) }
    static func mono(_ s: CGFloat) -> Font { .custom("RobotoMono-Regular", fixedSize: s) }
    static func monoMed(_ s: CGFloat) -> Font { .custom("RobotoMono-Medium", fixedSize: s) }
}

// The palette travels in the environment so every view reads the SAME finish and
// nothing has to be threaded through initialisers.
private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Theme.white
}
extension EnvironmentValues {
    var pal: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

// Hex colour helper.
extension Color {
    init(hex: UInt) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255.0,
                  green: Double((hex >> 8) & 0xff) / 255.0,
                  blue: Double(hex & 0xff) / 255.0,
                  opacity: 1.0)
    }
}
