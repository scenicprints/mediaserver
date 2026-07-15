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

// ---- Show detail: the "description window" (like the movie page) — backdrop
// splash with poster/title/chips/actions at its bottom edge, the overview and
// cast BELOW the splash, then season cards and the selected season's episodes.
struct ShowDetailView: View {
    @EnvironmentObject var store: Store
    let showId: Int

    @State private var detail: ShowDetail?
    @State private var extra: ShowExtra?
    @State private var loading = true
    @State private var selectedSeason = 0
    @State private var session: PlaySession?
    @State private var subJobText: String?
    @State private var episodePage: Episode?     // selected episode → its description scene

    private var flatEpisodes: [Episode] { detail?.seasons.flatMap { $0.episodes } ?? [] }
    // Next up: an in-progress episode first, else the first unwatched.
    private var nextUp: Episode? {
        flatEpisodes.first(where: { ($0.resumePosition ?? 0) > 5 && $0.watched != 1 })
            ?? flatEpisodes.first(where: { $0.watched != 1 })
            ?? flatEpisodes.first
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
        .fullScreenCover(item: $session, onDismiss: {
            Task { await load(); await store.loadHome() }   // fresh resume state
        }) { s in
            PlayerView(session: s, store: store).ignoresSafeArea()
        }
        .fullScreenCover(item: $episodePage, onDismiss: {
            Task { await load() }                            // watched/resume may have changed
        }) { ep in
            EpisodeDetailView(showTitle: detail?.title ?? "", episode: ep,
                              fallbackArt: seasonPoster(ep.season ?? selectedSeason) ?? detail?.backdrop)
                .environmentObject(store)
        }
    }

    // Resolve and present playback for one episode (optionally a specific file).
    private func play(_ ep: Episode, at position: Double? = nil, file: MovieFile? = nil) {
        guard let f = file ?? ep.bestFile, let d = detail else { return }
        Task {
            guard let url = await store.resolvePlaybackURL(kind: "episode", file: f) else { return }
            session = PlaySession(url: url, ref: .episode(ep.id), duration: ep.duration,
                                  startAt: position ?? ep.resumePosition ?? 0,
                                  title: d.title,
                                  subtitle: "\(ep.tag) · \(ep.displayTitle)",
                                  fileId: f.id)
        }
    }

    @ViewBuilder
    private func content(_ d: ShowDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // ---- Splash ----
                ZStack(alignment: .bottomLeading) {
                    ArtImage(url: d.backdrop ?? d.poster, aspect: 16.0 / 9.0)
                        .frame(height: 740).frame(maxWidth: .infinity).clipped()
                        .overlay {
                            LinearGradient(stops: [
                                .init(color: Theme.bg.opacity(0.95), location: 0.0),
                                .init(color: Theme.bg.opacity(0.6), location: 0.30),
                                .init(color: .clear, location: 0.66)
                            ], startPoint: .leading, endPoint: .trailing)
                        }
                        .overlay {
                            LinearGradient(stops: [
                                .init(color: Theme.bg, location: 0.0),
                                .init(color: Theme.bg.opacity(0.45), location: 0.32),
                                .init(color: .clear, location: 0.72)
                            ], startPoint: .bottom, endPoint: .top)
                        }

                    HStack(alignment: .bottom, spacing: 44) {
                        ArtImage(url: d.poster, aspect: 2.0 / 3.0, placeholderTitle: d.title)
                            .frame(width: 260, height: 390)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.1), lineWidth: 1))
                            .shadow(color: .black.opacity(0.5), radius: 24, y: 10)

                        VStack(alignment: .leading, spacing: 16) {
                            Text(d.title).font(.system(size: 56, weight: .bold))
                                .shadow(radius: 12).lineLimit(2)
                            HStack(spacing: 14) {
                                if let y = d.year { Chip(String(y)) }
                                if let r = d.rating, r > 0 { Chip(String(format: "★ %.1f", r)) }
                                Chip("\(flatEpisodes.count) episodes")
                            }
                            if !d.genreList.isEmpty {
                                HStack(spacing: 10) {
                                    ForEach(d.genreList.prefix(4), id: \.self) { g in
                                        Text(g)
                                            .font(.caption).fontWeight(.medium).foregroundStyle(Color(hex: 0xcfd4e2))
                                            .padding(.horizontal, 14).padding(.vertical, 6)
                                            .overlay(Capsule().strokeBorder(.white.opacity(0.2), lineWidth: 1))
                                    }
                                }
                            }
                            actions(d)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Theme.gutter).padding(.bottom, 48)
                }

                // ---- Description + cast below the splash ----
                VStack(alignment: .leading, spacing: 14) {
                    if let o = d.overview, !o.isEmpty {
                        Text(o).font(.title3).foregroundStyle(Color(hex: 0xd7dbe6))
                            .frame(maxWidth: 1250, alignment: .leading)
                    }
                    if let job = subJobText {
                        Text(job).font(.callout).foregroundStyle(Theme.accent2)
                    }
                }
                .padding(.horizontal, Theme.gutter).padding(.top, 8)

                if let cast = extra?.cast, !cast.isEmpty {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("Cast").font(.title2).fontWeight(.semibold).padding(.leading, Theme.gutter)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 36) {
                                ForEach(Array(cast.enumerated()), id: \.offset) { _, c in
                                    castTile(c)
                                }
                            }
                            .padding(.horizontal, Theme.gutter).padding(.vertical, 8)
                        }
                    }
                    .padding(.top, 26)
                }

                // ---- Season cards ----
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

                // ---- Selected season's episodes ----
                LazyVStack(spacing: 24) {
                    ForEach(currentEpisodes) { ep in
                        // Selecting an episode opens its description scene (like
                        // the web); playback starts from there.
                        EpisodeRow(episode: ep, fallbackArt: seasonPoster(ep.season ?? selectedSeason)) {
                            episodePage = ep
                        }
                        .contextMenu { episodeMenu(ep) }
                    }
                }
                .padding(Theme.gutter)
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    @ViewBuilder
    private func actions(_ d: ShowDetail) -> some View {
        HStack(spacing: 18) {
            if let ep = nextUp {
                if (ep.resumePosition ?? 0) > 5 {
                    Button { play(ep) } label: {
                        Label("Resume \(ep.tag) · \(timecode(ep.resumePosition ?? 0))", systemImage: "play.fill")
                            .font(.headline).padding(.horizontal, 14)
                    }.buttonStyle(.borderedProminent).tint(Theme.accent)
                    Button { play(ep, at: 0) } label: {
                        Label("From Beginning", systemImage: "gobackward").font(.headline).padding(.horizontal, 10)
                    }.buttonStyle(.bordered)
                } else {
                    Button { play(ep) } label: {
                        Label("Play \(ep.tag)", systemImage: "play.fill").font(.headline).padding(.horizontal, 14)
                    }.buttonStyle(.borderedProminent).tint(Theme.accent)
                }
            }
            if let f = nextUp?.bestFile, (nextUp?.files.count ?? 0) > 1, let ep = nextUp {
                Menu {
                    ForEach(ep.files) { file in
                        Button(file.quality ?? file.filename ?? "Version") { play(ep, file: file) }
                    }
                } label: {
                    Label(f.quality ?? "Version", systemImage: "rectangle.stack")
                }.buttonStyle(.bordered)
            }
        }
        .padding(.top, 6)
    }

    // Long-press menu on an episode: versions, restart, AI subtitles.
    @ViewBuilder
    private func episodeMenu(_ ep: Episode) -> some View {
        if ep.files.count > 1 {
            ForEach(ep.files) { f in
                Button("Play \(f.quality ?? f.filename ?? "version")", systemImage: "rectangle.stack") {
                    play(ep, file: f)
                }
            }
        }
        Button("Play From Beginning", systemImage: "gobackward") { play(ep, at: 0) }
        if let f = ep.bestFile {
            Button("Generate AI Subtitles", systemImage: "captions.bubble") {
                generateAISubs(fileId: f.id)
            }
        }
    }

    private func generateAISubs(fileId: Int) {
        subJobText = "AI subtitles: starting…"
        Task {
            var job = await store.generateSubtitles(kind: "episode", fileId: fileId)
            while let j = job, j.status == "running" {
                subJobText = "AI subtitles: \(j.phase ?? "working")… \(j.pct ?? 0)%"
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                job = await store.subtitleJobStatus(kind: "episode", fileId: fileId)
            }
            if let j = job, j.status == "done" {
                subJobText = "AI subtitles ready — pick them from the player's subtitle menu."
            } else {
                subJobText = job?.error ?? "AI subtitles failed."
            }
        }
    }

    private func castTile(_ c: CastMember) -> some View {
        VStack(spacing: 10) {
            Group {
                if let p = c.profile {
                    AsyncImage(url: URL(string: p)) { img in
                        img.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: { Circle().fill(Theme.card) }
                } else {
                    ZStack { Circle().fill(Theme.card); Text(String(c.name.prefix(1))).font(.title) }
                }
            }
            .frame(width: 150, height: 150).clipShape(Circle())
            Text(c.name).font(.callout).lineLimit(1).frame(width: 160)
            if let role = c.character {
                Text(role).font(.caption).foregroundStyle(.secondary).lineLimit(1).frame(width: 160)
            }
        }
    }

    private func load() async {
        loading = detail == nil
        detail = await store.showDetail(showId)
        if detail?.seasons.first(where: { $0.season == selectedSeason }) == nil {
            selectedSeason = detail?.seasons.first?.season ?? 0
        }
        loading = false
        extra = await store.showExtra(showId)
    }
}

// ---- Episode description scene (mirrors the web openEpisodeDetail) ----
// A full-screen page for ONE episode: still splash, S/E title, air date /
// rating / runtime / quality chips, Resume / From Beginning, Mark Watched,
// version picker, overview and Cast & Crew. Menu (Back) returns to the show.
struct EpisodeDetailView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let showTitle: String
    let episode: Episode
    var fallbackArt: String? = nil

    @State private var extra: EpisodeExtra?
    @State private var session: PlaySession?
    @State private var watched = false
    @State private var resumeAt: Double = 0
    @State private var selectedFile: MovieFile?
    @State private var subJobText: String?

    private var art: String? { extra?.still ?? episode.still ?? fallbackArt }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            content
        }
        .onExitCommand { dismiss() }
        .task {
            watched = episode.watched == 1
            resumeAt = (episode.resumePosition ?? 0) > 5 ? (episode.resumePosition ?? 0) : 0
            extra = await store.episodeExtra(episode.id)
        }
        .fullScreenCover(item: $session) { s in
            PlayerView(session: s, store: store).ignoresSafeArea()
        }
    }

    private func play(at position: Double) {
        guard let f = selectedFile ?? episode.bestFile else { return }
        Task {
            guard let url = await store.resolvePlaybackURL(kind: "episode", file: f) else { return }
            session = PlaySession(url: url, ref: .episode(episode.id), duration: episode.duration,
                                  startAt: position, title: showTitle,
                                  subtitle: "\(episode.tag) · \(episode.displayTitle)", fileId: f.id)
        }
    }

    private var content: some View {
        ScrollView {
            ZStack(alignment: .bottomLeading) {
                ArtImage(url: art, aspect: 16.0 / 9.0)
                    .frame(height: 700).frame(maxWidth: .infinity).clipped()
                    .overlay {
                        LinearGradient(stops: [
                            .init(color: Theme.bg.opacity(0.95), location: 0.0),
                            .init(color: Theme.bg.opacity(0.6), location: 0.30),
                            .init(color: .clear, location: 0.66)
                        ], startPoint: .leading, endPoint: .trailing)
                    }
                    .overlay {
                        LinearGradient(stops: [
                            .init(color: Theme.bg, location: 0.0),
                            .init(color: Theme.bg.opacity(0.45), location: 0.32),
                            .init(color: .clear, location: 0.72)
                        ], startPoint: .bottom, endPoint: .top)
                    }

                VStack(alignment: .leading, spacing: 16) {
                    Text(showTitle).font(.headline).foregroundStyle(Theme.accent2)
                    Text("\(episode.tag) · \(episode.displayTitle)")
                        .font(.system(size: 48, weight: .bold)).shadow(radius: 12).lineLimit(2)

                    HStack(spacing: 14) {
                        if let d = extra?.airDate { Chip(d) }
                        if let r = extra?.rating, r > 0 { Chip(String(format: "★ %.1f", r)) }
                        if let rt = extra?.runtime, rt > 0 { Chip("\(rt)m") }
                        if let q = (selectedFile ?? episode.bestFile)?.quality { Chip(q) }
                        if watched { Chip("✓ Watched") }
                    }

                    HStack(spacing: 18) {
                        if resumeAt > 0 {
                            Button { play(at: resumeAt) } label: {
                                Label("Resume · \(timecode(resumeAt))", systemImage: "play.fill")
                                    .font(.headline).padding(.horizontal, 14)
                            }.buttonStyle(.borderedProminent).tint(Theme.accent)
                            Button { play(at: 0) } label: {
                                Label("From Beginning", systemImage: "gobackward").font(.headline).padding(.horizontal, 10)
                            }.buttonStyle(.bordered)
                        } else {
                            Button { play(at: 0) } label: {
                                Label("Play", systemImage: "play.fill").font(.headline).padding(.horizontal, 14)
                            }.buttonStyle(.borderedProminent).tint(Theme.accent)
                        }

                        Button {
                            watched.toggle()
                            if watched { resumeAt = 0 }
                            Task { await store.setEpisodeWatched(episode.id, watched) }
                        } label: {
                            Label(watched ? "Watched" : "Mark Watched",
                                  systemImage: watched ? "checkmark.circle.fill" : "checkmark.circle")
                        }.buttonStyle(.bordered)

                        if episode.files.count > 1 {
                            Menu {
                                ForEach(episode.files) { f in
                                    Button(f.quality ?? f.filename ?? "Version") { selectedFile = f }
                                }
                            } label: {
                                Label((selectedFile ?? episode.bestFile)?.quality ?? "Version",
                                      systemImage: "rectangle.stack")
                            }.buttonStyle(.bordered)
                        }

                        if let f = selectedFile ?? episode.bestFile {
                            Button { generateAISubs(fileId: f.id) } label: {
                                Label("AI Subtitles", systemImage: "captions.bubble")
                            }.buttonStyle(.bordered)
                        }
                    }
                    .padding(.top, 6)
                }
                .padding(.horizontal, Theme.gutter).padding(.bottom, 48)
            }

            VStack(alignment: .leading, spacing: 14) {
                let overview = extra?.overview ?? episode.overview
                if let o = overview, !o.isEmpty {
                    Text(o).font(.title3).foregroundStyle(Color(hex: 0xd7dbe6))
                        .frame(maxWidth: 1250, alignment: .leading)
                }
                if let job = subJobText {
                    Text(job).font(.callout).foregroundStyle(Theme.accent2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.gutter).padding(.top, 8)

            if let people = extra?.people, !people.isEmpty {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Cast & Crew").font(.title2).fontWeight(.semibold).padding(.leading, Theme.gutter)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 36) {
                            ForEach(Array(people.enumerated()), id: \.offset) { _, p in
                                VStack(spacing: 10) {
                                    Group {
                                        if let pr = p.profile {
                                            AsyncImage(url: URL(string: pr)) { img in
                                                img.resizable().aspectRatio(contentMode: .fill)
                                            } placeholder: { Circle().fill(Theme.card) }
                                        } else {
                                            ZStack { Circle().fill(Theme.card); Text(String(p.name.prefix(1))).font(.title) }
                                        }
                                    }
                                    .frame(width: 150, height: 150).clipShape(Circle())
                                    Text(p.name).font(.callout).lineLimit(1).frame(width: 160)
                                    if let role = p.role {
                                        Text(role).font(.caption).foregroundStyle(.secondary).lineLimit(1).frame(width: 160)
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, Theme.gutter).padding(.vertical, 8)
                    }
                }
                .padding(.top, 26)
            }
            Color.clear.frame(height: Theme.gutter)
        }
        .ignoresSafeArea(edges: .top)
    }

    private func generateAISubs(fileId: Int) {
        subJobText = "AI subtitles: starting…"
        Task {
            var job = await store.generateSubtitles(kind: "episode", fileId: fileId)
            while let j = job, j.status == "running" {
                subJobText = "AI subtitles: \(j.phase ?? "working")… \(j.pct ?? 0)%"
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                job = await store.subtitleJobStatus(kind: "episode", fileId: fileId)
            }
            if let j = job, j.status == "done" {
                subJobText = "AI subtitles ready — pick them from the player's subtitle menu."
            } else {
                subJobText = job?.error ?? "AI subtitles failed."
            }
        }
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
        VStack(alignment: .leading, spacing: 10) {
            Button(action: action) {
                ArtImage(url: posterURL, aspect: 2.0 / 3.0, placeholderTitle: title)
                    .frame(width: 200, height: 300)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.posterRadius))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.posterRadius)
                            .strokeBorder(Theme.accent, lineWidth: selected ? 5 : 0)
                    }
            }
            .buttonStyle(.card)
            Text(title).font(.callout).fontWeight(.semibold).lineLimit(1)
                .foregroundStyle(selected ? Theme.accent2 : .white)
            Text("\(episodes) episodes").font(.caption).foregroundStyle(Theme.muted)
        }
    }
}

struct EpisodeRow: View {
    let episode: Episode
    var fallbackArt: String? = nil     // season poster when the episode has no still
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 28) {
                ArtImage(url: episode.still ?? fallbackArt, aspect: 16.0 / 9.0)
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
