import SwiftUI

// Live TV: synthesize genre "channels" from the library and air them on a
// wall-clock schedule, like the web app — tune in and you join whatever is
// "currently playing" partway through. Built from loaded movies (which carry
// durations and are directly playable).
struct LiveChannel: Identifiable, Hashable {
    let id: Int
    let name: String
    let sub: String
    let movies: [Movie]
}

struct LiveTVView: View {
    @EnvironmentObject var store: Store
    @State private var tuned: TunedItem?
    // Re-render the "now airing" line every 30s so the guide stays current.
    @State private var tick = Date()
    private let timer = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    private var channels: [LiveChannel] { Self.build(from: store.movies) }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if channels.isEmpty {
                VStack(spacing: 14) {
                    Image(systemName: "dot.radiowaves.left.and.right").font(.system(size: 60)).foregroundStyle(Theme.accent)
                    Text("Add some movies to start broadcasting.").foregroundStyle(.secondary)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 14) {
                            Circle().fill(.red).frame(width: 18, height: 18)
                            Text("LIVE GUIDE").font(.title).fontWeight(.heavy).kerning(2)
                        }
                        .padding(.horizontal, Theme.gutter).padding(.top, 40).padding(.bottom, 12)

                        LazyVStack(spacing: 20) {
                            ForEach(channels) { ch in
                                if let (movie, offset) = nowAiring(ch) {
                                    ChannelRow(channel: ch, movie: movie,
                                               progress: progress(movie, offset)) {
                                        tuned = TunedItem(movie: movie, offset: offset)
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, Theme.gutter).padding(.bottom, Theme.gutter)
                    }
                }
                .onReceive(timer) { tick = $0 }
            }
        }
        .task { if store.movies.isEmpty { await store.loadHome() } }
        .fullScreenCover(item: $tuned) { item in
            PlayerFor(movie: item.movie, offset: item.offset)
                .environmentObject(store)
                .ignoresSafeArea()
        }
    }

    // The item + in-item offset "airing now" on a channel, from wall-clock time.
    private func nowAiring(_ ch: LiveChannel) -> (Movie, Double)? {
        _ = tick
        let durs = ch.movies.map { runtimeSeconds($0) }
        let total = durs.reduce(0, +)
        guard total > 0 else { return nil }
        // Offset each channel's timeline so they're not all in sync.
        var t = Int(Date().timeIntervalSince1970 + Double(ch.id) * 1234).quotientAndRemainder(dividingBy: Int(total)).remainder
        for (i, d) in durs.enumerated() {
            if Double(t) < d { return (ch.movies[i], Double(t)) }
            t -= Int(d)
        }
        return (ch.movies[0], 0)
    }
    private func progress(_ m: Movie, _ offset: Double) -> Double {
        let d = runtimeSeconds(m); return d > 0 ? min(offset / d, 1) : 0
    }
    private func runtimeSeconds(_ m: Movie) -> Double {
        if let d = m.duration, d > 0 { return d }
        if let r = m.runtime, r > 0 { return Double(r) * 60 }
        return 6000
    }

    // Channel definitions mirroring the web app's live line-up (movie-applicable).
    static func build(from movies: [Movie]) -> [LiveChannel] {
        func has(_ m: Movie, _ g: String) -> Bool { m.genreList.contains(g) }
        let defs: [(String, String, (Movie) -> Bool)] = [
            ("PRIME", "Feature Films", { _ in true }),
            ("ADRENALINE", "Action", { has($0, "Action") }),
            ("THE LAUGH TRACK", "Comedy", { has($0, "Comedy") }),
            ("NIGHTMARE", "Horror", { has($0, "Horror") }),
            ("PRESTIGE", "Drama", { has($0, "Drama") }),
            ("NEBULA", "Science Fiction", { has($0, "Science Fiction") }),
            ("MYTHOS", "Fantasy", { has($0, "Fantasy") }),
            ("TRAILBLAZER", "Adventure", { has($0, "Adventure") }),
            ("HEARTLINE", "Romance", { has($0, "Romance") }),
            ("TOON CITY", "Animation", { has($0, "Animation") }),
            ("TOP SHELF", "Top Rated", { ($0.rating ?? 0) >= 7.5 }),
            ("FRESH", "New Releases", { ($0.year ?? 0) >= 2020 }),
        ]
        var out: [LiveChannel] = []
        for (i, def) in defs.enumerated() {
            let items = movies.filter(def.2)
            if items.count >= 3 { out.append(LiveChannel(id: i, name: def.0, sub: def.1, movies: items)) }
        }
        return out
    }
}

// Identifiable wrapper so fullScreenCover(item:) can drive playback.
private struct TunedItem: Identifiable, Hashable {
    let movie: Movie; let offset: Double
    var id: Int { movie.id }
}

// Resolves the movie's best file and plays it at the live offset.
private struct PlayerFor: View {
    @EnvironmentObject var store: Store
    let movie: Movie
    let offset: Double
    @State private var detail: MovieDetail?

    var body: some View {
        Group {
            if let d = detail, let f = d.bestFile, let url = store.streamURL(fileId: f.id) {
                PlayerView(url: url, startAt: offset, ref: .movie(d.id), duration: d.duration, store: store)
            } else {
                ZStack { Color.black; ProgressView().tint(.white) }
            }
        }
        .task { detail = await store.movieDetail(movie.id) }
    }
}

struct ChannelRow: View {
    let channel: LiveChannel
    let movie: Movie
    let progress: Double
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 28) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(channel.name).font(.title3).fontWeight(.heavy).kerning(1)
                    Text(channel.sub).font(.caption).foregroundStyle(.secondary)
                }
                .frame(width: 260, alignment: .leading)

                ArtImage(url: movie.backdrop ?? movie.poster, aspect: 16.0 / 9.0)
                    .frame(width: 300, height: 169)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.posterRadius))
                    .overlay(alignment: .bottom) { ProgressBar(progress: progress) }

                VStack(alignment: .leading, spacing: 8) {
                    Text("NOW AIRING").font(.caption2).fontWeight(.bold)
                        .foregroundStyle(Theme.accentSoft).kerning(1.5)
                    Text(movie.title).font(.title3).fontWeight(.semibold).lineLimit(1)
                    if let o = movie.overview {
                        Text(o).font(.body).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer()
                Image(systemName: "play.circle.fill").font(.system(size: 44)).foregroundStyle(.white.opacity(0.85))
            }
            .padding(20)
        }
        .buttonStyle(.card)
    }
}
