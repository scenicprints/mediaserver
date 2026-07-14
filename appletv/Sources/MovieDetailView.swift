import SwiftUI

// Cinematic movie detail — matches the web detail view: backdrop, metadata,
// Play/Resume, Favorite/Watched, version picker, cast, and "More Like This".
struct MovieDetailView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]
    let movieId: Int

    @State private var detail: MovieDetail?
    @State private var extra: MovieExtra?
    @State private var loading = true
    @State private var playing = false
    @State private var resumeFrom: Double = 0
    @State private var selectedFile: MovieFile?
    @State private var favorite = false
    @State private var watched = false
    @State private var preroll: URL?

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if let d = detail { content(d) }
            else if loading { ProgressView().scaleEffect(1.6) }
            else { Text("Couldn't load this title.").foregroundStyle(.secondary) }
        }
        .toolbar(.hidden, for: .tabBar)
        .task { await load() }
        .fullScreenCover(isPresented: $playing) {
            if let f = selectedFile ?? detail?.bestFile, let url = store.playbackURL(kind: "movie", file: f) {
                PlayerView(url: url, startAt: resumeFrom,
                           ref: .movie(movieId), duration: detail?.duration, store: store,
                           prerollURL: preroll)
                    .ignoresSafeArea()
            }
        }
    }

    @ViewBuilder
    private func content(_ d: MovieDetail) -> some View {
        ScrollView {
            ZStack(alignment: .bottomLeading) {
                ArtImage(url: d.backdrop ?? d.poster, aspect: 16.0 / 9.0)
                    .frame(height: 760).frame(maxWidth: .infinity).clipped()
                    .overlay {
                        LinearGradient(colors: [.clear, Theme.bg.opacity(0.6), Theme.bg],
                                       startPoint: .top, endPoint: .bottom)
                    }

                VStack(alignment: .leading, spacing: 20) {
                    Text(d.title).font(.system(size: 64, weight: .bold)).shadow(radius: 10)

                    HStack(spacing: 16) {
                        if let y = d.year { Chip(String(y)) }
                        if let r = d.rating, r > 0 { Chip(String(format: "★ %.1f", r)) }
                        if let rt = (extra?.runtime ?? d.runtime), rt > 0 { Chip(runtimeText(rt)) }
                        if let q = (selectedFile ?? d.bestFile)?.quality { Chip(q) }
                        ForEach((extra?.genres ?? d.genreList).prefix(3), id: \.self) { Chip($0) }
                    }

                    HStack(spacing: 20) {
                        if let p = d.resumePosition, p > 5 {
                            Button { resumeFrom = p; playing = true } label: {
                                Label("Resume · \(timecode(p))", systemImage: "play.fill").font(.headline).padding(.horizontal, 16)
                            }.buttonStyle(.borderedProminent).tint(Theme.accent)
                            Button { resumeFrom = 0; playing = true } label: {
                                Label("From Beginning", systemImage: "gobackward").font(.headline).padding(.horizontal, 12)
                            }.buttonStyle(.bordered)
                        } else {
                            Button { resumeFrom = 0; playing = true } label: {
                                Label("Play", systemImage: "play.fill").font(.headline).padding(.horizontal, 16)
                            }.buttonStyle(.borderedProminent).tint(Theme.accent)
                        }

                        Button { Task { favorite = await store.toggleFavorite(movieId) ?? favorite } } label: {
                            Label(favorite ? "Favorited" : "Favorite", systemImage: favorite ? "star.fill" : "star")
                        }.buttonStyle(.bordered)

                        Button {
                            watched.toggle(); Task { await store.setWatched(movieId, watched) }
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
                    }
                    .padding(.top, 6)

                    if let tag = extra?.tagline, !tag.isEmpty {
                        Text(tag).font(.title3).italic().foregroundStyle(Theme.accentSoft)
                    }
                    if let o = d.overview {
                        Text(o).font(.title3).foregroundStyle(.white.opacity(0.86))
                            .frame(maxWidth: 1200, alignment: .leading)
                    }
                }
                .padding(.horizontal, Theme.gutter).padding(.bottom, 60)
            }

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
    private func castRow(directors: [String], cast: [CastMember]) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Cast & Crew").font(.title2).fontWeight(.semibold).padding(.leading, Theme.gutter)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 36) {
                    ForEach(directors, id: \.self) { d in personTile(name: d, role: "Director", profile: nil) }
                    ForEach(Array(cast.enumerated()), id: \.offset) { _, c in
                        personTile(name: c.name, role: c.character, profile: c.profile)
                    }
                }
                .padding(.horizontal, Theme.gutter).padding(.vertical, 8)
            }
        }
        .padding(.top, 20)
    }

    private func personTile(name: String, role: String?, profile: String?) -> some View {
        VStack(spacing: 10) {
            Group {
                if let p = profile {
                    AsyncImage(url: URL(string: p)) { img in
                        img.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: { Circle().fill(Theme.card) }
                } else {
                    ZStack { Circle().fill(Theme.card); Text(String(name.prefix(1))).font(.title) }
                }
            }
            .frame(width: 150, height: 150).clipShape(Circle())
            Text(name).font(.callout).lineLimit(1).frame(width: 160)
            if let role { Text(role).font(.caption).foregroundStyle(.secondary).lineLimit(1).frame(width: 160) }
        }
    }

    private func runtimeText(_ min: Int) -> String {
        min >= 60 ? "\(min / 60)h \(min % 60)m" : "\(min)m"
    }
    private func versionLabel(_ f: MovieFile) -> String {
        f.quality ?? f.filename ?? "Version"
    }

    private func load() async {
        loading = true
        detail = await store.movieDetail(movieId)
        favorite = detail?.favorite == 1
        watched = detail?.watched == 1
        loading = false
        extra = await store.movieExtra(movieId)   // enrich after the core loads
        preroll = await store.prerollURL()
    }
}
