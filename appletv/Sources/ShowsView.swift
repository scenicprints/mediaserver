import SwiftUI

// TV: the Marquee hero (shows) + the full categorized row set.
struct ShowsView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
    @Binding var route: [Route]

    var body: some View {
        Group {
            if store.shows.isEmpty {
                ZStack {
                    pal.paper.ignoresSafeArea()
                    VStack(spacing: 18) {
                        Text("No shows yet").font(F.med(30)).foregroundStyle(pal.ink)
                        MButton(title: "Reload") { Task { await store.loadHome() } }
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

// ============================================================================
// Show detail. Two columns: the show on the left, the season and its episodes
// on the right. Episodes are a LIST, not a carousel — number, still, title, one
// line, runtime — because a season is an ordered thing and reads as one.
// ============================================================================

struct ShowDetailView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
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
            pal.paper.ignoresSafeArea()
            if let d = detail { content(d) }
            else if loading { ProgressView().scaleEffect(1.6) }
            else { Text("Couldn't load this show.").font(F.reg(24)).foregroundStyle(pal.ink2) }
        }
        .task { await load() }
        .fullScreenCover(item: $session, onDismiss: {
            Task { await load(); await store.loadHome() }   // fresh resume state
        }) { s in
            PlayerRouter(session: s, store: store).ignoresSafeArea()
        }
        .fullScreenCover(item: $episodePage, onDismiss: {
            Task { await load() }                            // watched/resume may have changed
        }) { ep in
            EpisodeDetailView(showTitle: detail?.title ?? "", episode: ep,
                              fallbackArt: seasonPoster(ep.season ?? selectedSeason) ?? detail?.backdrop)
                .environmentObject(store)
                .environment(\.pal, pal)
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
                                  fileId: f.id, upNext: upNextQueue(after: ep, in: d))
        }
    }

    // Every playable episode after this one (in season/episode order) — feeds the
    // player's in-player "Up Next" autoplay.
    private func upNextQueue(after ep: Episode, in d: ShowDetail) -> [UpNextItem] {
        let all = d.seasons.sorted { $0.season < $1.season }.flatMap { $0.episodes }
        guard let idx = all.firstIndex(where: { $0.id == ep.id }) else { return [] }
        return all[(idx + 1)...].compactMap { e in
            guard let f = e.bestFile else { return nil }
            return UpNextItem(fileId: f.id, ref: .episode(e.id), title: e.displayTitle,
                              subtitle: e.tag, still: e.still, duration: e.duration)
        }
    }

    @ViewBuilder
    private func content(_ d: ShowDetail) -> some View {
        HStack(alignment: .top, spacing: 56) {
            showColumn(d).frame(width: 780)
            seasonColumn(d).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, 24)
    }

    @ViewBuilder private func showColumn(_ d: ShowDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ArtPlate(url: d.backdrop ?? d.poster, height: 290, title: d.title)

                Text(d.title)
                    .font(F.med(54)).foregroundStyle(pal.ink)
                    .lineLimit(2).minimumScaleFactor(0.6)
                    .padding(.top, 22)

                SpecGrid(cells: specCells(d)).padding(.top, 20)

                if let o = d.overview, !o.isEmpty {
                    // Bounded: this column has no focusable content, so tvOS can
                    // never scroll it. Everything here has to fit on one screen.
                    Text(o).font(F.reg(20)).lineSpacing(8).foregroundStyle(pal.ink2)
                        .lineLimit(4)
                        .padding(.top, 20)
                }

                let people = (extra?.cast ?? []).prefix(8).map { ($0.name, $0.character ?? "") }
                if !people.isEmpty {
                    Lab("Cast").padding(.top, 24)
                    CreditsBlock(people: Array(people)).padding(.top, 12)
                }

                if let job = subJobText {
                    Text(job).font(F.med(18)).foregroundStyle(pal.signal).padding(.top, 14)
                }
                Color.clear.frame(height: 40)
            }
        }
    }

    @ViewBuilder private func seasonColumn(_ d: ShowDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Season selection: a row of cells with a signal underline. No picker.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(d.seasons, id: \.season) { s in
                        SeasonCell(title: s.season == 0 ? "Specials" : "Season \(s.season)",
                                   selected: s.season == selectedSeason) {
                            selectedSeason = s.season
                        }
                    }
                }
            }
            .focusSection()
            .overlay(alignment: .bottom) { Rectangle().fill(pal.rule).frame(height: 1) }

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(currentEpisodes) { ep in
                        EpisodeRow(episode: ep,
                                   fallbackArt: seasonPoster(ep.season ?? selectedSeason)) {
                            episodePage = ep
                        }
                        .contextMenu { episodeMenu(ep) }
                    }
                }
            }
            .focusSection()

            if let ep = nextUp {
                Lab(continueLine(ep), small: true).padding(.top, 18)
            }
        }
    }

    private func continueLine(_ ep: Episode) -> String {
        if let p = ep.resumePosition, p > 5, let dur = ep.duration, dur > p {
            return "Continue   \(ep.tag)   ·   \(timecode(dur - p)) remaining"
        }
        return "Next up   \(ep.tag)   ·   \(ep.displayTitle)"
    }

    private func specCells(_ d: ShowDetail) -> [SpecGrid.Cell] {
        var cells: [SpecGrid.Cell] = []
        if let y = d.year { cells.append(.init(key: "Year", value: String(y))) }
        cells.append(.init(key: "Seasons", value: "\(d.seasons.count)"))
        cells.append(.init(key: "Episodes", value: "\(flatEpisodes.count)"))
        let unwatched = flatEpisodes.filter { $0.watched != 1 }.count
        if unwatched > 0 { cells.append(.init(key: "Unwatched", value: "\(unwatched)")) }
        if let r = d.rating, r > 0 { cells.append(.init(key: "Rating", value: String(format: "%.1f", r))) }
        return cells
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

// A season selector cell. Selected is the signal underline; focused is an ink one.
struct SeasonCell: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(F.med(21))
                .foregroundStyle(selected || focused ? pal.ink : pal.ink3)
                .padding(.horizontal, 26).padding(.vertical, 14)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(selected ? pal.signal : (focused ? pal.ink : .clear))
                        .frame(height: 4)
                }
        }
        .buttonStyle(.bare)
        .focused($focused)
        .focusEffectDisabled()
    }
}

// One episode in the season list.
struct EpisodeRow: View {
    let episode: Episode
    var fallbackArt: String? = nil     // season poster when the episode has no still
    let action: () -> Void
    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) {
            HStack(spacing: 22) {
                Text("\(episode.episode ?? 0)")
                    .font(F.monoMed(19)).foregroundStyle(focused ? pal.ink : pal.ink3)
                    .frame(width: 34, alignment: .trailing)

                ArtImage(url: episode.still ?? fallbackArt, aspect: 16.0 / 9.0)
                    .frame(width: 132, height: 74).clipped()
                    .overlay(alignment: .bottom) { ProgressBar(progress: episode.progressFraction) }
                    .overlay(Rectangle().strokeBorder(pal.rule, lineWidth: 1))

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 10) {
                        Text(episode.displayTitle)
                            .font(F.med(21)).foregroundStyle(pal.ink).lineLimit(1)
                        if episode.watched == 1 {
                            Text("✓").font(F.med(19)).foregroundStyle(pal.ink3)
                        }
                    }
                    if let o = episode.overview, !o.isEmpty {
                        Text(o).font(F.reg(16)).foregroundStyle(pal.ink2).lineLimit(1)
                    }
                }
                Spacer(minLength: 12)

                if let d = episode.duration, d > 0 {
                    Text(timecode(d)).font(F.mono(17)).foregroundStyle(pal.ink3)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 15)
            .background(focused ? pal.panel2 : .clear)
            .overlay(alignment: .leading) { Rectangle().fill(pal.signal).frame(width: focused ? 6 : 0) }
            .overlay(alignment: .bottom) { Rectangle().fill(pal.rule2).frame(height: 1) }
        }
        .buttonStyle(.bare)
        .focused($focused)
        .focusEffectDisabled()
    }
}

// Deep-link target for an episode (Continue Watching cards): loads the show,
// finds the episode, and shows its description page.
struct EpisodeRouteView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
    let showId: Int
    let episodeId: Int
    @State private var show: ShowDetail?
    @State private var failed = false

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            if let show, let ep = show.seasons.flatMap({ $0.episodes }).first(where: { $0.id == episodeId }) {
                EpisodeDetailView(showTitle: show.title, episode: ep,
                                  fallbackArt: show.poster ?? show.backdrop)
            } else if failed {
                Text("Couldn't load this episode.").font(F.reg(24)).foregroundStyle(pal.ink2)
            } else {
                ProgressView().scaleEffect(1.6)
            }
        }
        .task {
            show = await store.showDetail(showId)
            failed = show == nil
        }
    }
}

// ============================================================================
// Episode description scene — one episode, laid out like the movie page.
// ============================================================================

struct EpisodeDetailView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
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
    @State private var showVersions = false

    private var art: String? { extra?.still ?? episode.still ?? fallbackArt }

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            content
        }
        .onExitCommand { dismiss() }
        .task {
            watched = episode.watched == 1
            resumeAt = (episode.resumePosition ?? 0) > 5 ? (episode.resumePosition ?? 0) : 0
            extra = await store.episodeExtra(episode.id)
        }
        .fullScreenCover(item: $session) { s in
            PlayerRouter(session: s, store: store).ignoresSafeArea()
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
            VStack(alignment: .leading, spacing: 0) {
                ArtPlate(url: art, height: 348, title: episode.displayTitle)
                    .padding(.horizontal, Theme.gutter).padding(.top, 24)

                HStack(alignment: .top, spacing: 72) {
                    VStack(alignment: .leading, spacing: 0) {
                        Lab("\(showTitle)   ·   \(episode.tag)", small: true)
                        Text(episode.displayTitle)
                            .font(F.med(64)).foregroundStyle(pal.ink)
                            .lineLimit(2).minimumScaleFactor(0.6)
                            .padding(.top, 14)

                        SpecGrid(cells: specCells()).padding(.top, 22)

                        let overview = extra?.overview ?? episode.overview
                        if let o = overview, !o.isEmpty {
                            Text(o).font(F.reg(22)).lineSpacing(9).foregroundStyle(pal.ink2)
                                .frame(maxWidth: 900, alignment: .leading)
                                .padding(.top, 22)
                        }

                        let people = (extra?.people ?? []).prefix(8).map { ($0.name, $0.role ?? "") }
                        if !people.isEmpty {
                            Lab("Cast & crew").padding(.top, 26)
                            CreditsBlock(people: Array(people)).padding(.top, 12)
                        }
                        if let job = subJobText {
                            Text(job).font(F.med(18)).foregroundStyle(pal.signal).padding(.top, 14)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    VStack(alignment: .leading, spacing: 0) {
                        if resumeAt > 0 {
                            MButton(title: "Resume \(timecode(resumeAt))", kind: .primary,
                                    play: true, wide: true, height: 76) { play(at: resumeAt) }
                            MButton(title: "Play from start", wide: true) { play(at: 0) }
                                .padding(.top, 12)
                        } else {
                            MButton(title: "Play", kind: .primary, play: true,
                                    wide: true, height: 76) { play(at: 0) }
                        }

                        VStack(spacing: 0) {
                            if episode.files.count > 1 {
                                ControlRow(name: "Version",
                                           value: (selectedFile ?? episode.bestFile)?.quality ?? "Version") {
                                    showVersions = true
                                }
                            }
                            ControlRow(name: "Watched", value: watched ? "Yes" : "No", on: watched) {
                                watched.toggle()
                                if watched { resumeAt = 0 }
                                Task { await store.setEpisodeWatched(episode.id, watched) }
                            }
                            if let f = selectedFile ?? episode.bestFile {
                                ControlRow(name: "Generate subtitles", value: "Whisper") {
                                    generateAISubs(fileId: f.id)
                                }
                            }
                        }
                        .overlay(alignment: .top) { Rectangle().fill(pal.rule).frame(height: 1) }
                        .padding(.top, 26)
                    }
                    .frame(width: 520)
                    .confirmationDialog("Version", isPresented: $showVersions, titleVisibility: .visible) {
                        ForEach(episode.files) { f in
                            Button(f.quality ?? f.filename ?? "Version") { selectedFile = f }
                        }
                    }
                }
                .padding(.horizontal, Theme.gutter).padding(.top, 30)

                Color.clear.frame(height: 60)
            }
        }
    }

    private func specCells() -> [SpecGrid.Cell] {
        var cells: [SpecGrid.Cell] = []
        if let d = extra?.airDate, !d.isEmpty { cells.append(.init(key: "Aired", value: d)) }
        if let r = extra?.rating, r > 0 { cells.append(.init(key: "Rating", value: String(format: "%.1f", r))) }
        if let rt = extra?.runtime, rt > 0 { cells.append(.init(key: "Runtime", value: "\(rt)m")) }
        else if let d = episode.duration, d > 0 { cells.append(.init(key: "Runtime", value: timecode(d))) }
        if let q = (selectedFile ?? episode.bestFile)?.quality {
            cells.append(.init(key: "Video", value: q, mono: false))
        }
        return cells
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
