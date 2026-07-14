import SwiftUI

// TV: rotating Marquee hero (shows) + the full categorized row set.
struct ShowsView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]

    var body: some View {
        Group {
            if store.shows.isEmpty {
                ZStack {
                    Theme.bg.ignoresSafeArea()
                    VStack(spacing: 14) {
                        Text("No shows yet").font(.title2)
                        Button("Reload") { Task { await store.loadHome() } }
                    }
                }
            } else {
                BrowseScreen(route: $route,
                             heroItems: Browse.heroFromShows(store.shows),
                             rows: Browse.showRows(store.shows),
                             continueKind: "episode")
            }
        }
        .task { if store.shows.isEmpty { await store.loadHome() } }
    }
}

// ---- Show detail: hero + season cards + the selected season's episodes ----
struct ShowDetailView: View {
    @EnvironmentObject var store: Store
    let showId: Int

    @State private var detail: ShowDetail?
    @State private var extra: ShowExtra?
    @State private var loading = true
    @State private var selectedSeason = 0
    @State private var playing: Episode?

    private var flatEpisodes: [Episode] { detail?.seasons.flatMap { $0.episodes } ?? [] }
    private var firstUnwatched: Episode? {
        flatEpisodes.first(where: { $0.watched != 1 }) ?? flatEpisodes.first
    }
    private var currentEpisodes: [Episode] {
        detail?.seasons.first(where: { $0.season == selectedSeason })?.episodes ?? []
    }
    private func seasonPoster(_ s: Int) -> String? {
        extra?.seasons?.first(where: { $0.season == s })?.poster ?? detail?.poster
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if let d = detail { content(d) }
            else if loading { ProgressView().scaleEffect(1.6) }
            else { Text("Couldn't load this show.").foregroundStyle(.secondary) }
        }
        .toolbar(.hidden, for: .tabBar)
        .task { await load() }
        .fullScreenCover(item: $playing) { ep in
            if let f = ep.bestFile, let url = store.playbackURL(kind: "episode", file: f) {
                PlayerView(url: url, startAt: ep.resumePosition ?? 0,
                           ref: .episode(ep.id), duration: ep.duration, store: store)
                    .ignoresSafeArea()
            }
        }
    }

    @ViewBuilder
    private func content(_ d: ShowDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .bottomLeading) {
                    ArtImage(url: d.backdrop ?? d.poster, aspect: 16.0 / 9.0)
                        .frame(height: 720).frame(maxWidth: .infinity).clipped()
                        .overlay {
                            LinearGradient(stops: [
                                .init(color: Theme.bg, location: 0.0),
                                .init(color: Theme.bg.opacity(0.35), location: 0.4),
                                .init(color: .clear, location: 0.75)
                            ], startPoint: .bottom, endPoint: .top)
                        }
                    VStack(alignment: .leading, spacing: 16) {
                        Text(d.title).font(.system(size: 60, weight: .bold)).shadow(radius: 10)
                        HStack(spacing: 16) {
                            if let y = d.year { Chip(String(y)) }
                            if let r = d.rating, r > 0 { Chip(String(format: "★ %.1f", r)) }
                            Chip("\(flatEpisodes.count) episodes")
                            ForEach(d.genreList.prefix(2), id: \.self) { Chip($0) }
                        }
                        Button {
                            playing = firstUnwatched
                        } label: {
                            Label(firstUnwatched.map { ($0.resumePosition ?? 0) > 5 ? "Resume \($0.tag)" : "Play \($0.tag)" } ?? "Play",
                                  systemImage: "play.fill")
                                .font(.headline).padding(.horizontal, 16)
                        }
                        .buttonStyle(.borderedProminent).tint(Theme.accent)
                        if let o = d.overview {
                            Text(o).font(.title3).foregroundStyle(.white.opacity(0.85))
                                .lineLimit(2).frame(maxWidth: 1100, alignment: .leading)
                        }
                    }
                    .padding(.horizontal, Theme.gutter).padding(.bottom, 40)
                }

                // Season cards
                Text("Seasons").font(.title2).fontWeight(.semibold)
                    .padding(.horizontal, Theme.gutter).padding(.top, 30)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Theme.cardSpacing) {
                        ForEach(d.seasons, id: \.season) { s in
                            SeasonCard(title: s.season == 0 ? "Specials" : "Season \(s.season)",
                                       posterURL: seasonPoster(s.season),
                                       episodes: s.episodes.count,
                                       selected: s.season == selectedSeason) {
                                withAnimation { selectedSeason = s.season }
                            }
                        }
                    }
                    .padding(.horizontal, Theme.gutter).padding(.vertical, 12)
                }

                // Selected season's episodes
                LazyVStack(spacing: 24) {
                    ForEach(currentEpisodes) { ep in
                        EpisodeRow(episode: ep) { playing = ep }
                    }
                }
                .padding(Theme.gutter)
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    private func load() async {
        loading = true
        detail = await store.showDetail(showId)
        selectedSeason = detail?.seasons.first?.season ?? 0
        loading = false
        extra = await store.showExtra(showId)
    }
}

// A season poster card in the show detail.
struct SeasonCard: View {
    let title: String
    let posterURL: String?
    let episodes: Int
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                ArtImage(url: posterURL, aspect: 2.0 / 3.0)
                    .frame(width: 200, height: 300)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.posterRadius))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.posterRadius)
                            .strokeBorder(Theme.accent, lineWidth: selected ? 5 : 0)
                    }
                Text(title).font(.callout).fontWeight(.semibold).lineLimit(1)
                Text("\(episodes) episodes").font(.caption).foregroundStyle(Theme.muted)
            }
        }
        .buttonStyle(.card)
    }
}

struct EpisodeRow: View {
    let episode: Episode
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 28) {
                ArtImage(url: episode.still, aspect: 16.0 / 9.0)
                    .frame(width: 360, height: 202)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.posterRadius))
                    .overlay(alignment: .bottom) { ProgressBar(progress: episode.progressFraction) }
                    .overlay(alignment: .center) {
                        Image(systemName: "play.circle.fill").font(.system(size: 46))
                            .foregroundStyle(.white.opacity(0.9)).shadow(radius: 6)
                    }
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 12) {
                        Text(episode.tag).font(.callout).foregroundStyle(Theme.accentSoft)
                        if episode.watched == 1 {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        }
                    }
                    Text(episode.displayTitle).font(.title3).fontWeight(.semibold).lineLimit(1)
                    if let o = episode.overview {
                        Text(o).font(.body).foregroundStyle(.secondary).lineLimit(3)
                    }
                }
                Spacer()
            }
            .padding(20)
        }
        .buttonStyle(.card)
    }
}
