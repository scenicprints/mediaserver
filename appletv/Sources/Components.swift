import SwiftUI

// Shared building blocks for the "10-foot" UI. tvOS gives us focus scale/parallax
// for free via .buttonStyle(.card); we layer Marquee's art + labels on top.

// A 2:3 poster tile that pushes a movie detail screen when selected.
struct PosterCard: View {
    let title: String
    let posterURL: String?
    let subtitle: String?
    let progress: Double
    let action: () -> Void

    init(title: String, posterURL: String?, subtitle: String? = nil,
         progress: Double = 0, action: @escaping () -> Void) {
        self.title = title; self.posterURL = posterURL
        self.subtitle = subtitle; self.progress = progress; self.action = action
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                ArtImage(url: posterURL, aspect: 2.0 / 3.0)
                    .frame(width: Theme.posterWidth, height: Theme.posterHeight)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.posterRadius))
                    .overlay(alignment: .bottom) { ProgressBar(progress: progress) }

                Text(title)
                    .font(.callout).fontWeight(.medium)
                    .lineLimit(1)
                    .frame(width: Theme.posterWidth, alignment: .leading)
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .buttonStyle(.card)
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
                    Rectangle().fill(Theme.card)
                    Image(systemName: "film").font(.system(size: 44)).foregroundStyle(.secondary)
                }
                .aspectRatio(aspect, contentMode: .fill)
            }
        }
    }
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
                    Rectangle().fill(.black.opacity(0.55))
                    Rectangle().fill(Theme.accent)
                        .frame(width: geo.size.width * progress)
                }
            }
            .frame(height: 6)
        }
    }
}
