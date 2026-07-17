import SwiftUI

// Cinematic movie detail — mirrors the web detail page (dp-splash/dp-body):
// the backdrop splash carries the poster, title, meta chips, genre pills and
// action row at its BOTTOM edge; the tagline, overview and filename sit BELOW
// the splash on the page background so nothing buries the artwork.
struct MovieDetailView: View {
    @EnvironmentObject var store: Store
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

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if let d = detail { content(d) }
            else if loading { ProgressView().scaleEffect(1.6) }
            else { Text("Couldn't load this title.").foregroundStyle(.secondary) }
        }
        .toolbar(.hidden, for: .tabBar)
        .task { await load() }
        .fullScreenCover(item: $session, onDismiss: {
            // Refresh so Resume/Continue Watching reflect where playback stopped.
            Task { await load(); await store.loadHome() }
        }) { s in
            PlayerView(session: s, store: store).ignoresSafeArea()
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
            // ---- Splash: backdrop with the hero block pinned to its bottom ----
            ZStack(alignment: .bottomLeading) {
                ArtImage(url: d.backdrop ?? d.poster, aspect: 16.0 / 9.0)
                    .frame(height: 780).frame(maxWidth: .infinity).clipped()
                    .overlay {
                        // Web dp-splash::after — a left scrim + a bottom fade into the page.
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
                            if let rt = (extra?.runtime ?? d.runtime), rt > 0 { Chip(runtimeText(rt)) }
                            if let q = (selectedFile ?? d.bestFile)?.quality { Chip(q) }
                        }

                        let genres = extra?.genres ?? d.genreList
                        if !genres.isEmpty {
                            HStack(spacing: 10) {
                                ForEach(genres.prefix(4), id: \.self) { genrePill($0) }
                            }
                        }

                        actions(d)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Theme.gutter).padding(.bottom, 48)
            }

            // ---- Body: the words live BELOW the splash, like the web dp-body ----
            VStack(alignment: .leading, spacing: 14) {
                if let tag = extra?.tagline, !tag.isEmpty {
                    Text(tag).font(.title3).italic().foregroundStyle(Theme.accentSoft)
                }
                if let o = d.overview, !o.isEmpty {
                    Text(o).font(.title3).foregroundStyle(Color(hex: 0xd7dbe6))
                        .frame(maxWidth: 1250, alignment: .leading)
                }
                if let name = (selectedFile ?? d.bestFile)?.filename {
                    Text(name).font(.caption).foregroundStyle(Theme.muted)
                }
                if let job = subJobText {
                    Text(job).font(.callout).foregroundStyle(Theme.accent2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.gutter).padding(.top, 8)

            // Cast & Crew
            if let cast = extra?.cast, !cast.isEmpty {
                castRow(directors: extra?.directors ?? [], cast: cast)
            }
            // More Like This (owned recommendations are playable)
            if let recs = extra?.recommendations?.filter({ $0.poster != nil }), !recs.isEmpty {
                MediaRow(title: "More Like This") {
                    ForEach(recs, id: \.self) { r in
                        PosterCard(title: r.title, posterURL: r.poster, subtitle: r.year.map(String.init)) {
                            if let lid = r.localId { route.append(.movie(lid)) }
                        }
                    }
                }
                .padding(.top, 10)
            }
            Color.clear.frame(height: Theme.gutter)
        }
        .ignoresSafeArea(edges: .top)
    }

    @ViewBuilder
    private func actions(_ d: MovieDetail) -> some View {
        ActionRow {
            if let p = d.resumePosition, p > 5 {
                Button { play(at: p) } label: {
                    Label("Resume · \(timecode(p))", systemImage: "play.fill").font(.headline).padding(.horizontal, 14)
                }.buttonStyle(.borderedProminent).tint(Theme.accent)
                Button { play(at: 0) } label: {
                    Label("From Beginning", systemImage: "gobackward").font(.headline).padding(.horizontal, 10)
                }.buttonStyle(.bordered)
            } else {
                Button { play(at: 0) } label: {
                    Label("Play", systemImage: "play.fill").font(.headline).padding(.horizontal, 14)
                }.buttonStyle(.borderedProminent).tint(Theme.accent)
            }

            Button { Task { favorite = await store.toggleFavorite(movieId) ?? favorite } } label: {
                Label(favorite ? "Favorited" : "Favorite", systemImage: favorite ? "star.fill" : "star")
            }.buttonStyle(.bordered)

            Button {
                watched.toggle(); Task { await store.setWatched(movieId, watched); await store.loadHome() }
            } label: {
                Label(watched ? "Watched" : "Mark Watched", systemImage: watched ? "checkmark.circle.fill" : "checkmark.circle")
            }.buttonStyle(.bordered)

            if d.files.count > 1 {
                Menu {
                    ForEach(d.files) { f in
                        Button(versionLabel(f)) { selectedFile = f }
                    }
                } label: {
                    Label(selectedFile.map(versionLabel) ?? "Version", systemImage: "rectangle.stack")
                }.buttonStyle(.bordered)
            }

            if let f = selectedFile ?? d.bestFile {
                Button { generateAISubs(fileId: f.id) } label: {
                    Label("AI Subtitles", systemImage: "captions.bubble")
                }.buttonStyle(.bordered)
            }
        }
        .padding(.top, 6)
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

    @ViewBuilder
    private func castRow(directors: [String], cast: [CastMember]) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Cast & Crew").font(.title2).fontWeight(.semibold).padding(.leading, Theme.gutter)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 36) {
                    ForEach(directors, id: \.self) { d in CastTile(name: d, role: "Director", profile: nil) }
                    ForEach(Array(cast.enumerated()), id: \.offset) { _, c in
                        CastTile(name: c.name, role: c.character, profile: c.profile)
                    }
                }
                .padding(.horizontal, Theme.gutter).padding(.vertical, 8)
            }
            .focusSection()
        }
        .padding(.top, 26)
    }

    private func genrePill(_ g: String) -> some View {
        Text(g)
            .font(.caption).fontWeight(.medium).foregroundStyle(Color(hex: 0xcfd4e2))
            .padding(.horizontal, 14).padding(.vertical, 6)
            .overlay(Capsule().strokeBorder(.white.opacity(0.2), lineWidth: 1))
    }

    private func runtimeText(_ min: Int) -> String {
        min >= 60 ? "\(min / 60)h \(min % 60)m" : "\(min)m"
    }
    private func versionLabel(_ f: MovieFile) -> String {
        let base = f.quality ?? f.filename ?? "Version"
        if let s = f.sizeText { return "\(base) · \(s)" }
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
    }
}
