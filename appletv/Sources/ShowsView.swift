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

// ---- Show detail: season picker + episode list with resume playback ----
struct ShowDetailView: View {
    @EnvironmentObject var store: Store
    let showId: Int

    @State private var detail: ShowDetail?
    @State private var loading = true
    @State private var selectedSeason = 0
    @State private var playing: Episode?

    private var currentEpisodes: [Episode] {
        detail?.seasons.first(where: { $0.season == selectedSeason })?.episodes ?? []
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
                        .frame(height: 640).frame(maxWidth: .infinity).clipped()
                        .overlay {
                            LinearGradient(colors: [.clear, Theme.bg.opacity(0.6), Theme.bg],
                                           startPoint: .top, endPoint: .bottom)
                        }
                    VStack(alignment: .leading, spacing: 16) {
                        Text(d.title).font(.system(size: 60, weight: .bold)).shadow(radius: 10)
                        HStack(spacing: 16) {
                            if let y = d.year { Chip(String(y)) }
                            if let r = d.rating, r > 0 { Chip(String(format: "★ %.1f", r)) }
                            ForEach(d.genreList.prefix(3), id: \.self) { Chip($0) }
                        }
                        if let o = d.overview {
                            Text(o).font(.title3).foregroundStyle(.white.opacity(0.85))
                                .lineLimit(2).frame(maxWidth: 1100, alignment: .leading)
                        }
                    }
                    .padding(.horizontal, Theme.gutter).padding(.bottom, 40)
                }

                if d.seasons.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 16) {
                            ForEach(d.seasons, id: \.season) { s in
                                Button { selectedSeason = s.season } label: {
                                    Text(s.season == 0 ? "Specials" : "Season \(s.season)")
                                        .font(.headline).padding(.horizontal, 20).padding(.vertical, 12)
                                }
                                .buttonStyle(.bordered)
                                .tint(selectedSeason == s.season ? Theme.accent : .gray)
                            }
                        }
                        .padding(.horizontal, Theme.gutter)
                    }
                    .padding(.top, 20)
                }

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
