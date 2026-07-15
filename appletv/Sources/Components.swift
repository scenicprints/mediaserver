import SwiftUI
import UIKit

// Shared building blocks for the "10-foot" UI. tvOS gives us focus scale/parallax
// for free via .buttonStyle(.card); we layer Marquee's art + labels on top.

// A corner badge on a poster, mirroring the web card badges.
enum CardBadge: Hashable {
    case new                       // "NEW" (hot pink)
    case newCount(Int)             // "N new" (shows with unwatched)
    case quality(String)           // "4K"/"1080p" (dark pill, top-right)
    case stream(String, UInt)      // streaming-only: solid provider colour, top-left
    case alsoOn(String, UInt)      // owned + also on a service: outlined, top-left
}

// The MARQUEE gradient wordmark. Lives at the top of each page's scroll content
// (it scrolls away with the page — it is NOT pinned over everything).
struct MarqueeWordmark: View {
    var body: some View {
        Text("MARQUEE")
            .font(.system(size: 34, weight: .heavy)).kerning(1.5)
            .foregroundStyle(Theme.grad)
            .accessibilityHidden(true)
    }
}

// A 2:3 poster tile. ONLY the artwork sits inside the focusable button (the
// .card style wraps its whole label in the focus platter — putting text in
// there is what produced the grey strip under focused posters). The title and
// year live below, always visible, like a TV app should.
struct PosterCard: View {
    let title: String
    let posterURL: String?
    let subtitle: String?
    let progress: Double
    let badges: [CardBadge]
    let action: () -> Void
    @FocusState private var focused: Bool

    init(title: String, posterURL: String?, subtitle: String? = nil,
         progress: Double = 0, badges: [CardBadge] = [], action: @escaping () -> Void) {
        self.title = title; self.posterURL = posterURL; self.subtitle = subtitle
        self.progress = progress; self.badges = badges; self.action = action
    }

    private var topRight: CardBadge? { badges.first { if case .stream = $0 { return false }; if case .alsoOn = $0 { return false }; return true } }
    private var topLeft: CardBadge? { badges.first { if case .stream = $0 { return true }; if case .alsoOn = $0 { return true }; return false } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button(action: action) {
                ArtImage(url: posterURL, aspect: 2.0 / 3.0, placeholderTitle: title)
                    .frame(width: Theme.posterWidth, height: Theme.posterHeight)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.posterRadius))
                    .overlay(alignment: .topTrailing) { if let b = topRight { pill(b) } }
                    .overlay(alignment: .topLeading) { if let b = topLeft { pill(b) } }
                    .overlay(alignment: .bottom) { ProgressBar(progress: progress) }
            }
            .buttonStyle(.card)
            .focused($focused)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.callout).fontWeight(.semibold).lineLimit(1)
                    .foregroundStyle(focused ? .white : Color(hex: 0xd3d7e3))
                Text(subtitle ?? " ")
                    .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .frame(width: Theme.posterWidth, alignment: .leading)
        }
    }

    @ViewBuilder private func pill(_ badge: CardBadge) -> some View {
        switch badge {
        case .new:                    pillText("NEW", bg: Theme.hot, fg: .white)
        case .newCount(let n):        pillText("\(n) new", bg: Theme.hot, fg: .white)
        case .quality(let q):         pillText(q, bg: Color.black.opacity(0.72), fg: Color(hex: 0xeaf0ff))
        case .stream(let name, let c):pillText(name, bg: Color(hex: c), fg: .white)
        case .alsoOn(let name, let c):pillText("▸ \(name)", bg: Color.black.opacity(0.78), fg: .white, stroke: Color(hex: c))
        }
    }

    private func pillText(_ text: String, bg: Color, fg: Color, stroke: Color? = nil) -> some View {
        Text(text)
            .font(.caption2).fontWeight(.bold).foregroundStyle(fg)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(bg, in: Capsule())
            .overlay(stroke.map { Capsule().strokeBorder($0, lineWidth: 2) })
            .padding(10)
    }
}

// Continue Watching: a poster card like the web's, with the resume progress
// pinned to the poster and a long-press menu to mark it watched (the web ✓).
struct ContinueCard: View {
    let title: String
    let subtitle: String?
    let posterURL: String?
    let progress: Double
    let action: () -> Void
    var onMarkWatched: (() -> Void)? = nil
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button(action: action) {
                ArtImage(url: posterURL, aspect: 2.0 / 3.0, placeholderTitle: title)
                    .frame(width: Theme.posterWidth, height: Theme.posterHeight)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.posterRadius))
                    .overlay(alignment: .bottomLeading) {
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 40)).padding(12)
                            .foregroundStyle(.white).shadow(radius: 6)
                    }
                    .overlay(alignment: .bottom) { ProgressBar(progress: progress) }
            }
            .buttonStyle(.card)
            .focused($focused)
            .contextMenu {
                if let onMarkWatched {
                    Button("Mark Watched", systemImage: "checkmark.circle", action: onMarkWatched)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.callout).fontWeight(.semibold).lineLimit(1)
                    .foregroundStyle(focused ? .white : Color(hex: 0xd3d7e3))
                Text(subtitle ?? " ")
                    .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .frame(width: Theme.posterWidth, alignment: .leading)
        }
    }
}

// A titled horizontal carousel — the core of Marquee's home layout.
struct MediaRow<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title)
                .font(.title2).fontWeight(.semibold)
                .padding(.leading, Theme.gutter)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: Theme.cardSpacing) {
                    content()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.vertical, 12)   // room for focus scale
            }
        }
        // Whole row is one focus section: moving up/down from ANY card lands on
        // the neighboring row/hero even when nothing sits directly above it
        // (cards deep in a row used to be dead ends).
        .focusSection()
    }
}

// Poster/backdrop loader with a graceful placeholder. Unlike AsyncImage this
// RETRIES failed loads (TMDB hiccups were leaving random marquee/poster tiles
// blank) and goes through URLCache, so a retried image costs nothing later.
struct ArtImage: View {
    let url: String?
    let aspect: CGFloat
    var placeholderTitle: String? = nil
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fill)
            } else {
                ZStack {
                    Rectangle().fill(Theme.posterFill)
                    if let t = placeholderTitle, !t.isEmpty {
                        Text(t)
                            .font(.callout).fontWeight(.semibold)
                            .foregroundStyle(Theme.muted)
                            .multilineTextAlignment(.center)
                            .padding(14)
                    } else {
                        Image(systemName: "film").font(.system(size: 44)).foregroundStyle(Theme.muted)
                    }
                }
                .aspectRatio(aspect, contentMode: .fill)
            }
        }
        .task(id: url) { await load() }
    }

    private func load() async {
        image = nil   // view reuse: drop stale art when the URL changes
        guard let s = url, !s.isEmpty, let u = URL(string: s) else { return }
        for attempt in 1...3 {
            if let (data, resp) = try? await URLSession.shared.data(from: u),
               (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true,
               let img = UIImage(data: data) {
                image = img
                return
            }
            if attempt < 3 { try? await Task.sleep(nanoseconds: UInt64(attempt) * 500_000_000) }
        }
    }
}

// A detail-page action row that never wraps: buttons keep their intrinsic
// one-line size and the row scrolls horizontally when it runs out of width
// (compressed buttons used to wrap their labels into giant two-line pills).
struct ActionRow<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 18) { content() }
                .padding(.vertical, 10)   // focus-scale headroom
        }
        .focusSection()
    }
}

// Seconds -> H:MM:SS or M:SS timecode.
func timecode(_ seconds: Double) -> String {
    let s = Int(seconds)
    let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec)
                 : String(format: "%d:%02d", m, sec)
}

// A small rounded metadata pill (year, rating, genre, quality…).
struct Chip: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.callout).fontWeight(.medium)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(.white.opacity(0.14), in: Capsule())
    }
}

// Resume-progress bar pinned to the bottom of a tile.
struct ProgressBar: View {
    let progress: Double
    var body: some View {
        if progress > 0.01 {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(.white.opacity(0.18))
                    Rectangle().fill(Theme.grad)
                        .frame(width: geo.size.width * progress)
                }
            }
            .frame(height: 6)
        }
    }
}
