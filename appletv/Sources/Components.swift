import SwiftUI
import UIKit

// ============================================================================
// The Braun-edition building blocks. Everything focusable in the app goes
// through one of these, so focus looks the same everywhere.
//
// FOCUS: tvOS's stock `.buttonStyle(.card)` paints a white platter and bounces
// the tile. We don't use it anywhere. Instead every control is `.plain` with the
// system effect switched off, and draws its own state: the frame goes to ink, a
// signal bar lands under the item, and the label takes weight. Readable across a
// room, and it never covers the artwork.
// ============================================================================

// tvOS draws a soft white rounded halo behind ANY focusable control. Marquee
// draws its own focus, so the system effect is switched off app-wide (see
// ContentView) and the button style itself contributes NOTHING — no platter, no
// background, no shape. `.plain` still brought chrome of its own on tvOS 26.
struct BareButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label }
}
extension ButtonStyle where Self == BareButtonStyle {
    static var bare: BareButtonStyle { BareButtonStyle() }
}

// A corner badge on a poster.
enum CardBadge: Hashable {
    case new
    case newCount(Int)
    case quality(String)
    case stream(String, UInt)
    case alsoOn(String, UInt)
}

// ---------------------------------------------------------------- type helpers

// The small caps label that runs the whole system: section heads, spec keys,
// eyebrows. Braun put a word like this under every control.
struct Lab: View {
    let text: String
    var small = false
    @Environment(\.pal) private var pal
    init(_ text: String, small: Bool = false) { self.text = text; self.small = small }
    var body: some View {
        Text(text.uppercased())
            .font(small ? F.semi(15) : F.semi(18))
            .tracking(small ? 2.6 : 3.4)
            .foregroundStyle(small ? pal.ink3 : pal.ink2)
    }
}

// A section head: label, a hairline running out to the count on the right.
// A row reads as a drawer with a quantity in it, not a banner.
struct RowHead: View {
    let title: String
    var count: String? = nil
    @Environment(\.pal) private var pal
    var body: some View {
        HStack(alignment: .center, spacing: 20) {
            Lab(title)
            Rectangle().fill(pal.rule2).frame(height: 1)
            if let count { Text(count).font(F.mono(16)).foregroundStyle(pal.ink3) }
        }
    }
}

// The wordmark. Letterspaced, ink, no gradient — the identity is the spacing.
struct MarqueeWordmark: View {
    @Environment(\.pal) private var pal
    var body: some View {
        Text("MARQUEE")
            .font(F.semi(30)).tracking(9)
            .foregroundStyle(pal.ink)
            .accessibilityHidden(true)
    }
}

// ---------------------------------------------------------------- controls

enum MButtonKind { case primary, secondary }

// The one button in the system. Primary is the orange one; there is at most one
// per screen. Focus fills it with ink (or deepens the signal).
struct MButton: View {
    let title: String
    var kind: MButtonKind = .secondary
    var play = false                 // draw the play triangle
    var wide = false
    var height: CGFloat = 64
    let action: () -> Void

    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                if play {
                    Triangle().fill(fg).frame(width: 15, height: 18)
                }
                Text(title.uppercased()).font(F.semi(18)).tracking(2.6)
            }
            .foregroundStyle(fg)
            .frame(maxWidth: wide ? .infinity : nil)
            .frame(height: height)
            .padding(.horizontal, wide ? 0 : 32)
            .background(bg)
            .overlay(Rectangle().strokeBorder(border, lineWidth: focused ? 4 : 2))
            // An inner keyline as well, so the frame reads as a pressed edge and
            // not just a thicker outline. Both stay INSIDE the button's bounds.
            .overlay(
                Rectangle()
                    .strokeBorder(focused ? pal.onSignal.opacity(kind == .primary ? 0.85 : 0) : .clear,
                                  lineWidth: 2)
                    .padding(5)
            )
        }
        .buttonStyle(.bare)
        .focused($focused)
        .focusEffectDisabled()
    }

    // The primary is ALREADY orange, so focus can't be "turn orange". It presses
    // in instead: the fill deepens and an ink frame closes around it. Without
    // this you genuinely could not tell you were standing on Resume.
    private var bg: Color {
        switch kind {
        case .primary: return focused ? pal.signalDeep : pal.signal
        case .secondary: return focused ? pal.inverse : .clear
        }
    }
    private var fg: Color {
        switch kind {
        case .primary: return pal.onSignal
        case .secondary: return focused ? pal.onInverse : pal.ink
        }
    }
    private var border: Color {
        switch kind {
        case .primary: return focused ? pal.ink : pal.signal
        case .secondary: return focused ? pal.inverse : pal.rule
        }
    }
}

struct Triangle: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.midY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        p.closeSubpath()
        return p
    }
}

// A labelled control row: name left, value right, on a hairline. The whole
// detail page's action column and the whole Settings screen are made of these.
struct ControlRow: View {
    let name: String
    var value: String? = nil
    var on = false                   // value is actively switched on -> signal
    var action: (() -> Void)? = nil

    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: { action?() }) {
            HStack(spacing: 20) {
                Text(name).font(F.med(20)).foregroundStyle(pal.ink)
                Spacer(minLength: 12)
                if let value {
                    Text(value).font(F.mono(18))
                        .foregroundStyle(on ? pal.signal : pal.ink2)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 18).padding(.vertical, 19)
            .background(focused ? pal.panel2 : .clear)
            .overlay(alignment: .leading) {
                Rectangle().fill(pal.signal).frame(width: focused ? 6 : 0)
            }
            .overlay(alignment: .bottom) {
                Rectangle().fill(pal.rule2).frame(height: 1)
            }
        }
        .buttonStyle(.bare)
        .focused($focused)
        .focusEffectDisabled()
        .disabled(action == nil)
    }
}

// An outlined metadata chip (genre, quality). Never filled — a chip is a label,
// not a state.
struct Chip: View {
    let text: String
    @Environment(\.pal) private var pal
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(F.med(15)).tracking(1.6)
            .foregroundStyle(pal.ink2)
            .padding(.horizontal, 17).padding(.vertical, 10)
            .overlay(Rectangle().strokeBorder(pal.rule, lineWidth: 1))
    }
}

// The instrument panel: the handful of facts you actually decide on, in cells
// divided by hairlines, tiny key over a big value.
struct SpecGrid: View {
    struct Cell: Identifiable {
        let id = UUID()
        let key: String
        let value: String
        var mono = true
    }
    let cells: [Cell]
    @Environment(\.pal) private var pal

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.element.id) { i, c in
                VStack(alignment: .leading, spacing: 11) {
                    Lab(c.key, small: true)
                    Text(c.value)
                        .font(c.mono ? F.monoMed(24) : F.med(26))
                        .foregroundStyle(pal.ink)
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 18)
                .overlay(alignment: .trailing) {
                    if i < cells.count - 1 { Rectangle().fill(pal.rule2).frame(width: 1) }
                }
            }
        }
        .overlay(alignment: .top) { Rectangle().fill(pal.rule).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(pal.rule).frame(height: 1) }
    }
}

// Credits: name left, part right, on a hairline, two columns. The back page of a
// Braun manual — not a row of cropped faces.
struct CreditsBlock: View {
    let people: [(String, String)]
    @Environment(\.pal) private var pal

    var body: some View {
        let cols = [GridItem(.flexible(), spacing: 52), GridItem(.flexible(), spacing: 52)]
        LazyVGrid(columns: cols, alignment: .leading, spacing: 0) {
            ForEach(Array(people.enumerated()), id: \.offset) { _, p in
                HStack(spacing: 16) {
                    Text(p.0).font(F.med(19)).foregroundStyle(pal.ink).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(p.1).font(F.reg(18)).foregroundStyle(pal.ink3).lineLimit(1)
                }
                .padding(.vertical, 12)
                .overlay(alignment: .bottom) { Rectangle().fill(pal.rule2).frame(height: 1) }
            }
        }
        .overlay(alignment: .top) { Rectangle().fill(pal.rule).frame(height: 1) }
    }
}

// Resume progress, pinned to the bottom of a tile. Orange, because it is state.
struct ProgressBar: View {
    let progress: Double
    @Environment(\.pal) private var pal
    var body: some View {
        if progress > 0.01 {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Color.black.opacity(0.45))
                    Rectangle().fill(pal.signal).frame(width: geo.size.width * min(progress, 1))
                }
            }
            .frame(height: 6)
        }
    }
}

// ---------------------------------------------------------------- cards

// A 2:3 poster tile. Only the artwork is inside the button; the title and year
// live below it and are ALWAYS visible.
struct PosterCard: View {
    let title: String
    let posterURL: String?
    var subtitle: String? = nil
    var progress: Double = 0
    var badges: [CardBadge] = []
    var width: CGFloat = Theme.posterWidth
    var height: CGFloat = Theme.posterHeight
    var showPlay = false
    var onMarkWatched: (() -> Void)? = nil
    let action: () -> Void

    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    private var topRight: CardBadge? {
        badges.first { if case .stream = $0 { return false }; if case .alsoOn = $0 { return false }; return true }
    }
    private var topLeft: CardBadge? {
        badges.first { if case .stream = $0 { return true }; if case .alsoOn = $0 { return true }; return false }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The context menu is attached ONLY when there is one. An empty
            // .contextMenu still wraps the tile in a focus container of its own,
            // which put a halo around every poster in the app.
            if onMarkWatched != nil {
                poster.contextMenu {
                    Button("Mark Watched", systemImage: "checkmark.circle") { onMarkWatched?() }
                }
            } else {
                poster
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(focused ? F.semi(17) : F.med(17))
                    .foregroundStyle(focused ? pal.ink : pal.ink2)
                    .lineLimit(1)
                Text(subtitle ?? " ").font(F.mono(15)).foregroundStyle(pal.ink3).lineLimit(1)
            }
            .frame(width: width, alignment: .leading)
            .padding(.top, 12)

            // The signal bar: the whole of the focus indication, under the caption.
            Rectangle()
                .fill(focused ? pal.signal : Color.clear)
                .frame(width: width, height: 6)
                .padding(.top, 9)
        }
    }

    private var poster: some View {
        Button(action: action) {
            ArtImage(url: posterURL, aspect: 2.0 / 3.0, placeholderTitle: title)
                .frame(width: width, height: height)
                .clipped()
                .overlay(alignment: .topTrailing) { if let b = topRight { pill(b) } }
                .overlay(alignment: .topLeading) { if let b = topLeft { pill(b) } }
                .overlay(alignment: .bottomLeading) {
                    if showPlay {
                        Triangle().fill(.white).frame(width: 16, height: 19)
                            .shadow(color: .black.opacity(0.6), radius: 4)
                            .padding(12)
                    }
                }
                .overlay(alignment: .bottom) { ProgressBar(progress: progress) }
                .overlay(Rectangle().strokeBorder(focused ? pal.ink : pal.rule,
                                                  lineWidth: focused ? 3 : 1))
        }
        .buttonStyle(.bare)
        .focused($focused)
        .focusEffectDisabled()
    }

    // Badges are LABELS, not state — so none of them is orange. A row of nine
    // "NEW" pills in signal orange drowned out the one thing orange is for.
    @ViewBuilder private func pill(_ badge: CardBadge) -> some View {
        switch badge {
        case .new:                     pillText("New")
        case .newCount(let n):         pillText("\(n) new")
        case .quality(let q):          pillText(q, caps: false)   // "1080p", not "1080P"
        case .stream(let name, _):     pillText(name)
        case .alsoOn(let name, _):     pillText(name)
        }
    }
    private func pillText(_ text: String, caps: Bool = true) -> some View {
        Text(caps ? text.uppercased() : text)
            .font(F.semi(12)).tracking(caps ? 1.4 : 0.6)
            .foregroundStyle(.white)
            .padding(.horizontal, 9).padding(.vertical, 6)
            .background(Color.black.opacity(0.78))
            .padding(8)
    }
}

// A titled horizontal carousel.
struct MediaRow<Content: View>: View {
    let title: String
    var count: String? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            RowHead(title: title, count: count).padding(.horizontal, Theme.gutter)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: Theme.cardSpacing) { content() }
                    .padding(.horizontal, Theme.gutter)
            }
        }
        // One focus section per row: moving up or down from ANY card lands on the
        // neighbouring row even when nothing sits directly above it.
        .focusSection()
    }
}

// ---------------------------------------------------------------- artwork

// Decoded artwork, kept in memory. Without this every poster was re-downloaded
// from URLCache AND re-decoded on the main thread each time it scrolled back
// into view, which is what made moving through rows feel heavy.
final class ArtCache {
    static let shared = ArtCache()
    private let cache = NSCache<NSString, UIImage>()
    private init() { cache.countLimit = 500 }
    func image(_ url: String) -> UIImage? { cache.object(forKey: url as NSString) }
    func store(_ img: UIImage, _ url: String) { cache.setObject(img, forKey: url as NSString) }
}

// Poster/backdrop loader. Unlike AsyncImage this RETRIES failed loads (TMDB
// hiccups were leaving random tiles blank), caches the DECODED image, and never
// blanks a tile it can already draw.
struct ArtImage: View {
    let url: String?
    let aspect: CGFloat
    var placeholderTitle: String? = nil
    @State private var image: UIImage?
    @Environment(\.pal) private var pal

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fill)
            } else {
                ZStack {
                    Rectangle().fill(pal.sunk)
                    if let t = placeholderTitle, !t.isEmpty {
                        Text(t.uppercased())
                            .font(F.semi(14)).tracking(1.8)
                            .foregroundStyle(pal.ink3)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            .padding(12)
                    }
                }
                .aspectRatio(aspect, contentMode: .fill)
            }
        }
        .task(id: url) { await load() }
    }

    private func load() async {
        guard let s = url, !s.isEmpty else { image = nil; return }
        // A cache hit paints immediately — no blank frame, no decode, no flash
        // when a row scrolls back into view.
        if let hit = ArtCache.shared.image(s) { image = hit; return }
        image = nil   // view reuse: drop stale art when the URL changes
        guard let u = URL(string: s) else { return }
        for attempt in 1...3 {
            if let img = await Self.fetch(u) {
                ArtCache.shared.store(img, s)
                if url == s { image = img }   // the tile may have been recycled
                return
            }
            if attempt < 3 { try? await Task.sleep(nanoseconds: UInt64(attempt) * 400_000_000) }
        }
    }

    // Download AND decode off the main actor. UIImage(data:) is lazy, so without
    // preparingForDisplay() every tile pays for its decode during the scroll,
    // on the main thread, exactly when it can least afford it.
    nonisolated private static func fetch(_ u: URL) async -> UIImage? {
        guard let (data, resp) = try? await URLSession.shared.data(from: u),
              (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true,
              let img = UIImage(data: data) else { return nil }
        return img.preparingForDisplay() ?? img
    }
}

// An art plate: the artwork, in a hairline frame, never scrimmed and never with
// type on top of it. The image is the image; the label is a label.
struct ArtPlate: View {
    let url: String?
    var width: CGFloat? = nil          // nil = fill the available width
    var height: CGFloat
    var aspect: CGFloat = 16.0 / 9.0
    var title: String? = nil
    @Environment(\.pal) private var pal

    var body: some View {
        // The plate MUST own its own size. Artwork is scaled to FILL, so it
        // overflows its box unless the clip comes AFTER the final frame — when
        // the caller applied the height instead, the image kept painting at its
        // natural size and covered whatever sat below it (the detail page's text
        // ran over the backdrop, and Continue Watching over the hero).
        ArtImage(url: url, aspect: aspect, placeholderTitle: title)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil)
            .clipped()
            .contentShape(Rectangle())
            .overlay(Rectangle().strokeBorder(pal.rule, lineWidth: 1))
    }
}


// A wrapping (flow) layout: lays children left-to-right, dropping to a new row
// when the next would overflow. Chips and any other run of small items use it so
// nothing scrolls off the side of the screen. (Kept from the pre-Braun tree.)
struct FlowLayout: Layout {
    var spacing: CGFloat = 12
    var lineSpacing: CGFloat = 12

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
        let maxWidth = proposal.width ?? .greatestFiniteMagnitude
        let rows = computeRows(subviews, maxWidth: maxWidth)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + CGFloat(max(0, rows.count - 1)) * lineSpacing
        return CGSize(width: min(maxWidth, width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
        var y = bounds.minY
        for row in computeRows(subviews, maxWidth: bounds.width) {
            var x = bounds.minX
            for idx in row.items {
                let size = subviews[idx].sizeThatFits(.unspecified)
                subviews[idx].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func computeRows(_ subviews: Subviews, maxWidth: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for i in subviews.indices {
            let size = subviews[i].sizeThatFits(.unspecified)
            let addend = row.items.isEmpty ? size.width : spacing + size.width
            if !row.items.isEmpty && row.width + addend > maxWidth {
                rows.append(row); row = Row()
            }
            row.items.append(i)
            row.width += (row.items.count == 1 ? size.width : spacing + size.width)
            row.height = max(row.height, size.height)
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}

// Seconds -> H:MM:SS or M:SS timecode.
func timecode(_ seconds: Double) -> String {
    let s = Int(seconds)
    let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec)
                 : String(format: "%d:%02d", m, sec)
}
