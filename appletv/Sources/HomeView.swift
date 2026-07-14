import SwiftUI

// Marquee's home: a cinematic hero backdrop, then Continue Watching and
// content rows — the same shape as the web home view, built for the couch.
struct HomeView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]

    // A featured title for the hero — first Continue item, else a recent movie.
    private var hero: Movie? {
        store.movies.max(by: { ($0.id) < ($1.id) }) ?? store.movies.first
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                if let hero { HeroHeader(movie: hero) { route.append(.movie(hero.id)) } }

                if !store.continueItems.isEmpty {
                    MediaRow(title: "Continue Watching") {
                        ForEach(store.continueItems) { item in
                            ContinueCard(title: item.title, subtitle: item.subtitle,
                                         posterURL: item.poster, progress: item.progressFraction) {
                                if item.kind == "movie" { route.append(.movie(item.id)) }
                            }
                        }
                    }
                }

                if !store.movies.isEmpty {
                    MediaRow(title: "Movies") {
                        ForEach(store.movies.prefix(30)) { movie in
                            PosterCard(title: movie.title, posterURL: movie.poster,
                                       subtitle: movie.year.map(String.init),
                                       progress: movie.progressFraction) {
                                route.append(.movie(movie.id))
                            }
                        }
                    }
                }

                if !store.shows.isEmpty {
                    MediaRow(title: "TV Shows") {
                        ForEach(store.shows.prefix(30)) { show in
                            PosterCard(title: show.title, posterURL: show.poster,
                                       subtitle: show.year.map(String.init)) { /* show detail — next pass */ }
                        }
                    }
                }

                if !store.collections.isEmpty {
                    MediaRow(title: "Collections") {
                        ForEach(store.collections.prefix(20)) { col in
                            PosterCard(title: col.name, posterURL: col.poster,
                                       subtitle: col.count.map { "\($0) films" }) { /* collection — next pass */ }
                        }
                    }
                }
            }
            .padding(.bottom, Theme.gutter)
        }
        .ignoresSafeArea(edges: .top)
        .task { if store.movies.isEmpty { await store.loadHome() } }
    }
}

// Full-bleed hero: backdrop, gradient scrim, title/overview, a Play affordance.
struct HeroHeader: View {
    let movie: Movie
    let action: () -> Void

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            ArtImage(url: movie.backdrop ?? movie.poster, aspect: 16.0 / 9.0)
                .frame(height: 720)
                .frame(maxWidth: .infinity)
                .clipped()
                .overlay {
                    LinearGradient(colors: [.clear, Theme.bg.opacity(0.5), Theme.bg],
                                   startPoint: .top, endPoint: .bottom)
                }

            VStack(alignment: .leading, spacing: 18) {
                Text(movie.title)
                    .font(.system(size: 68, weight: .bold))
                    .shadow(radius: 12)
                HStack(spacing: 18) {
                    if let y = movie.year { Chip(String(y)) }
                    if let r = movie.rating, r > 0 { Chip(String(format: "★ %.1f", r)) }
                    ForEach(movie.genreList.prefix(3), id: \.self) { Chip($0) }
                }
                if let o = movie.overview {
                    Text(o).font(.title3).foregroundStyle(.white.opacity(0.85))
                        .lineLimit(3).frame(maxWidth: 1100, alignment: .leading)
                }
                Button(action: action) {
                    Label("View", systemImage: "play.fill")
                        .font(.headline).padding(.horizontal, 12)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .padding(.top, 8)
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.bottom, 60)
        }
    }
}

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
