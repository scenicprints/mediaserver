import SwiftUI

// Marquee's visual identity, tuned for a 4K TV viewed from the couch (the
// "10-foot UI"). tvOS renders at 1080p logical points on a 4K panel, so sizes
// here are generous on purpose — small web spacing looks cramped across the room.
enum Theme {
    // Brand accent — matches the web UI's --accent (#6c5cff).
    static let accent = Color(hex: 0x6c5cff)
    static let accentSoft = Color(hex: 0x8b7dff)

    // Backgrounds — deep near-black so cinematic art pops.
    static let bg = Color(hex: 0x0b0b12)
    static let card = Color(hex: 0x16161f)
    static let stroke = Color.white.opacity(0.08)

    // Poster geometry (2:3). Big enough that a row of ~6 fills a 4K screen.
    static let posterWidth: CGFloat = 260
    static let posterHeight: CGFloat = posterWidth * 3 / 2   // 390
    static let posterRadius: CGFloat = 12

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
