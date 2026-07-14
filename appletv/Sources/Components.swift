import SwiftUI

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

// A 2:3 poster tile. Title/subtitle reveal on focus (like the web hover), and
// corner badges show NEW/quality (top-right) and streaming provider (top-left).
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
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                ArtImage(url: posterURL, aspect: 2.0 / 3.0)
                    .frame(width: Theme.posterWidth, height: Theme.posterHeight)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.posterRadius))
                    .overlay(alignment: .topTrailing) { if let b = topRight { pill(b) } }
                    .overlay(alignment: .topLeading) { if let b = topLeft { pill(b) } }
                    .overlay(alignment: .bottom) { ProgressBar(progress: progress) }

                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.callout).fontWeight(.semibold).lineLimit(1)
                    Text(subtitle ?? " ").font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                }
                .frame(width: Theme.posterWidth, alignment: .leading)
                .opacity(focused ? 1 : 0)
            }
        }
        .buttonStyle(.card)
        .focused($focused)
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

// A 16:9 landscape tile used for Continue Watching (shows the resume progress).
struct ContinueCard: View {
    let title: String
    let subtitle: String?
    let posterURL: String?
    let progress: Double
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                ArtImage(url: posterURL, aspect: 16.0 / 9.0)
                    .frame(width: Theme.backdropWidth, height: Theme.backdropHeight)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.posterRadius))
                    .overlay(alignment: .bottomLeading) {
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 44)).padding(16)
                            .foregroundStyle(.white).shadow(radius: 6)
                    }
                    .overlay(alignment: .bottom) { ProgressBar(progress: progress) }

                Text(title).font(.callout).fontWeight(.medium).lineLimit(1)
                    .frame(width: Theme.backdropWidth, alignment: .leading)
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.card)
    }
}

// A titled horizontal carousel — the core of Marquee's home layout.
struct MediaRow<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(title)
                .font(.title2).fontWeight(.semibold)
                .padding(.leading, Theme.gutter)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: Theme.cardSpacing) {
                    content()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.vertical, 12)   // room for focus scale
            }
        }
    }
}

// Poster/backdrop loader with a graceful placeholder.
struct ArtImage: View {
    let url: String?
    let aspect: CGFloat

    var body: some View {
        AsyncImage(url: URL(string: url ?? "")) { phase in
            switch phase {
            case .success(let image):
                image.resizable().aspectRatio(contentMode: .fill)
            default:
                ZStack {
                    Rectangle().fill(Theme.posterFill)
                    Image(systemName: "film").font(.system(size: 44)).foregroundStyle(Theme.muted)
                }
                .aspectRatio(aspect, contentMode: .fill)
            }
        }
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
