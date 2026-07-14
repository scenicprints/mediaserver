import SwiftUI

// Marquee's visual identity, tuned for a 4K TV viewed from the couch (the
// "10-foot UI"). tvOS renders at 1080p logical points on a 4K panel, so sizes
// here are generous on purpose — small web spacing looks cramped across the room.
enum Theme {
    // Brand accent — matches the web UI (--accent / --accent-2 / --hot).
    static let accent = Color(hex: 0x6c5cff)
    static let accent2 = Color(hex: 0x37c2ff)
    static let accentSoft = Color(hex: 0x8b7dff)
    static let hot = Color(hex: 0xff4d6d)            // "NEW"/unwatched badge
    static let grad = LinearGradient(colors: [Color(hex: 0x6c5cff), Color(hex: 0x37c2ff)],
                                     startPoint: .leading, endPoint: .trailing)

    // Backgrounds — exact web values so the hero blends seamlessly into the page.
    static let bg = Color(hex: 0x0b0c10)             // --bg
    static let bg2 = Color(hex: 0x0f1116)
    static let card = Color(hex: 0x171a22)           // --panel
    static let muted = Color(hex: 0x9aa1b4)
    static let stroke = Color.white.opacity(0.10)
    // Poster placeholder gradient (web: linear 160deg #232838 → #14161d).
    static let posterFill = LinearGradient(colors: [Color(hex: 0x232838), Color(hex: 0x14161d)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)

    // Poster geometry (2:3). Big enough that a row of ~6 fills a 4K screen.
    static let posterWidth: CGFloat = 240
    static let posterHeight: CGFloat = posterWidth * 3 / 2
    static let posterRadius: CGFloat = 10

    // Backdrop/landscape geometry (16:9) — Continue Watching, hero thumbs.
    static let backdropWidth: CGFloat = 460
    static let backdropHeight: CGFloat = backdropWidth * 9 / 16  // ~259

    // Layout — safe-area-aware gutters for overscan-prone TVs.
    static let gutter: CGFloat = 80
    static let rowSpacing: CGFloat = 56
    static let cardSpacing: CGFloat = 40
}

// Hex color helper (shared across the app; matches the web UI's palette).
extension Color {
    init(hex: UInt) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255.0,
                  green: Double((hex >> 8) & 0xff) / 255.0,
                  blue: Double(hex & 0xff) / 255.0,
                  opacity: 1.0)
    }
}
