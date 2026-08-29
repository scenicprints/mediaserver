import SwiftUI

// ============================================================================
// Movie detail.
//
// The art is a plate across the top with nothing written on it. Everything else
// is a two-column body: the words on the left, and on the right a LABELLED
// COLUMN of controls. That column replaces the old horizontal action strip,
// where half the buttons scrolled off the side of the screen — now every control
// is visible at once and one press of Down apart.
// ============================================================================

struct MovieDetailView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
    @Binding var route: [Route]
    let movieId: Int

    @State private var detail: MovieDetail?
    @State private var extra: MovieExtra?
    @State private var loading = true
    @State private var session: PlaySession?
    @State private var selectedFile: MovieFile?
    @State private var favorite = false
    @State private var watched = false
    @State private var preroll: URL?
    @State private var subJobText: String?     // AI subtitle job progress line
    @State private var showVersions = false
    @State private var info: Store.MediaInfo?  // probed facts for the spec grid

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            if let d = detail { content(d) }
            else if loading { ProgressView().scaleEffect(1.6) }
            else { Text("Couldn't load this title.").font(F.reg(24)).foregroundStyle(pal.ink2) }
        }
        .task { await load() }
        .fullScreenCover(item: $session, onDismiss: {
            // Refresh so Resume/Continue Watching reflect where playback stopped.
            Task { await load(); await store.loadHome() }
        }) { s in
            PlayerRouter(session: s, store: store).ignoresSafeArea()
        }
    }

    private func play(at position: Double) {
        guard let d = detail, let f = selectedFile ?? d.bestFile else { return }
        Task {
            guard let url = await store.resolvePlaybackURL(kind: "movie", file: f) else { return }
            // Pre-roll plays ONLY when starting from the beginning (matches the
            // web). On a Resume the pre-roll queue also swallowed the seek and
            // restarted from 0 — dropping it fixes both.
            session = PlaySession(url: url, ref: .movie(movieId), duration: d.duration,
                                  startAt: position, title: d.title,
                                  fileId: f.id, preroll: position <= 1 ? preroll : nil)
        }
    }

    @ViewBuilder
    private func content(_ d: MovieDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ArtPlate(url: d.backdrop ?? d.poster, height: 348, title: d.title)
                    .padding(.horizontal, Theme.gutter)
                    .padding(.top, 24)

                HStack(alignment: .top, spacing: 72) {
                    left(d)
                    right(d).frame(width: 520)
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.top, 30)
                .focusSection()

                if let recs = extra?.recommendations?.filter({ $0.poster != nil }), !recs.isEmpty {
                    MediaRow(title: "More like this", count: "\(recs.count)") {
                        ForEach(recs, id: \.self) { r in
                            PosterCard(title: r.title, posterURL: r.poster,
                                       subtitle: r.year.map(String.init)) {
                                if let lid = r.localId { route.append(.movie(lid)) }
                            }
                        }
                    }
                    .padding(.top, 44)
                }

                Color.clear.frame(height: 60)
            }
        }
    }

    // ---- Left column: title, the facts, the words ----
    @ViewBuilder private func left(_ d: MovieDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(d.title)
                .font(F.med(64)).foregroundStyle(pal.ink)
                .lineLimit(2).minimumScaleFactor(0.6)

            SpecGrid(cells: specCells(d)).padding(.top, 24)

            let genres = extra?.genres ?? d.genreList
            if !genres.isEmpty {
                HStack(spacing: 10) {
                    ForEach(genres.prefix(4), id: \.self) { Chip($0) }
                }
                .padding(.top, 22)
            }

            if let tag = extra?.tagline, !tag.isEmpty {
                Text(tag).font(F.med(21)).foregroundStyle(pal.ink3).padding(.top, 22)
            }
            if let o = d.overview, !o.isEmpty {
                Text(o).font(F.reg(21)).lineSpacing(8).foregroundStyle(pal.ink2)
                    .lineLimit(4)
                    .frame(maxWidth: 900, alignment: .leading)
                    .padding(.top, 20)
            }

            let people = creditList()
            if !people.isEmpty {
                Lab("Cast").padding(.top, 26)
                CreditsBlock(people: people).padding(.top, 12)
            }

            if let name = (selectedFile ?? d.bestFile)?.filename {
                Text(name).font(F.mono(16)).foregroundStyle(pal.ink3)
                    .lineLimit(1).truncationMode(.middle)
                    .padding(.top, 22)
            }
            if let job = subJobText {
                Text(job).font(F.med(18)).foregroundStyle(pal.signal).padding(.top, 12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // ---- Right column: every control, visible at once ----
    @ViewBuilder private func right(_ d: MovieDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let p = d.resumePosition, p > 5 {
                MButton(title: "Resume \(timecode(p))", kind: .primary, play: true,
                        wide: true, height: 76) { play(at: p) }
                MButton(title: "Play from start", wide: true) { play(at: 0) }
                    .padding(.top, 12)
            } else {
                MButton(title: "Play", kind: .primary, play: true, wide: true, height: 76) { play(at: 0) }
            }

            VStack(spacing: 0) {
                if d.files.count > 1 {
                    ControlRow(name: "Version", value: versionLabel(selectedFile ?? d.bestFile)) {
                        showVersions = true
                    }
                }
                ControlRow(name: "Favourite", value: favorite ? "On" : "Off", on: favorite) {
                    Task { favorite = await store.toggleFavorite(movieId) ?? favorite }
                }
                ControlRow(name: "Watched", value: watched ? "Yes" : "No", on: watched) {
                    watched.toggle()
                    Task { await store.setWatched(movieId, watched); await store.loadHome() }
                }
                if let f = selectedFile ?? d.bestFile {
                    ControlRow(name: "Generate subtitles", value: "Whisper") {
                        generateAISubs(fileId: f.id)
                    }
                }
            }
            .overlay(alignment: .top) { Rectangle().fill(pal.rule).frame(height: 1) }
            .padding(.top, 26)
        }
        .focusSection()
        .confirmationDialog("Version", isPresented: $showVersions, titleVisibility: .visible) {
            ForEach(d.files) { f in
                Button(versionLabel(f)) { selectedFile = f }
            }
        }
    }

    // The facts you actually decide on. Once /api/mediainfo answers, the video
    // and audio cells switch from the filename guess to what was really probed.
    private func specCells(_ d: MovieDetail) -> [SpecGrid.Cell] {
        let file = selectedFile ?? d.bestFile
        var cells: [SpecGrid.Cell] = []
        if let y = d.year { cells.append(.init(key: "Year", value: String(y))) }
        if let r = d.rating, r > 0 { cells.append(.init(key: "Rating", value: String(format: "%.1f", r))) }
        if let rt = (extra?.runtime ?? d.runtime), rt > 0 {
            cells.append(.init(key: "Runtime", value: runtimeText(rt)))
        }
        if let i = info {
            let hdr = i.hdrText.map { " \($0)" } ?? ""
            cells.append(.init(key: "Video", value: i.resolutionText + hdr, mono: false))
            if let ch = i.channelLayout ?? i.channels.map({ "\($0)ch" }) {
                cells.append(.init(key: "Audio", value: [i.acodec?.uppercased(), ch].compactMap { $0 }.joined(separator: " "), mono: false))
            }
        } else if let q = file?.quality {
            cells.append(.init(key: "Video", value: q, mono: false))
        }
        if let s = file?.sizeText { cells.append(.init(key: "Size", value: s)) }
        if d.files.count > 1 { cells.append(.init(key: "Versions", value: "\(d.files.count)")) }
        return cells
    }

    // Director first, then the billed cast — the order a poster credits them in.
    private func creditList() -> [(String, String)] {
        var out: [(String, String)] = (extra?.directors ?? []).map { ($0, "Director") }
        out += (extra?.cast ?? []).prefix(8).map { ($0.name, $0.character ?? "") }
        return Array(out.prefix(10))
    }

    // Kick off (or resume polling) a Whisper subtitle job for this file. When it
    // finishes, the track appears in the player's native CC menu on next play.
    private func generateAISubs(fileId: Int) {
        subJobText = "AI subtitles: starting…"
        Task {
            var job = await store.generateSubtitles(kind: "movie", fileId: fileId)
            while let j = job, j.status == "running" {
                subJobText = "AI subtitles: \(j.phase ?? "working")… \(j.pct ?? 0)%"
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                job = await store.subtitleJobStatus(kind: "movie", fileId: fileId)
            }
            if let j = job, j.status == "done" {
                subJobText = "AI subtitles ready — pick them from the player's subtitle menu."
            } else {
                subJobText = job?.error ?? "AI subtitles failed."
            }
        }
    }

    private func runtimeText(_ min: Int) -> String {
        min >= 60 ? "\(min / 60)h \(min % 60)m" : "\(min)m"
    }
    private func versionLabel(_ f: MovieFile?) -> String {
        let base = f?.quality ?? f?.filename ?? "Version"
        if let s = f?.sizeText { return "\(base) · \(s)" }
        return base
    }

    private func load() async {
        loading = detail == nil
        // Fetch the detail and the pre-roll in parallel so the pre-roll URL is
        // ready by the time the Play button appears (else tapping Play early
        // skipped it).
        async let d = store.movieDetail(movieId)
        async let pr = store.prerollURL()
        detail = await d
        preroll = await pr
        favorite = detail?.favorite == 1
        watched = detail?.watched == 1
        loading = false
        extra = await store.movieExtra(movieId)   // enrich after the core loads
        if let f = selectedFile ?? detail?.bestFile {
            info = await store.mediaInfo(kind: "movie", fileId: f.id)
        }
    }
}
