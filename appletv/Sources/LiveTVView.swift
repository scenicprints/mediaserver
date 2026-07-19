import SwiftUI

// ============================================================================
// Live TV — a DirecTV-style guide synthesized from the library. Genre channels
// air movies AND TV episodes on a deterministic wall-clock schedule (seeded by
// LT_EPOCH so every device shows the same thing), with a hero preview and an EPG
// grid. Mirrors the web Live TV view.
// ============================================================================

struct LiveItem: Hashable {
    let kind: String            // "movie" | "episode"
    let title: String
    let sub: String?
    let genres: [String]
    let year: Int?
    let rating: Double?
    let duration: Double        // seconds (already resolved)
    let backdrop: String?
    let poster: String?
    let still: String?
    let overview: String?
    let movieLocalId: Int?
    let showId: Int?
    let epId: Int?
}

struct LiveChannel: Identifiable, Hashable {
    let id: Int
    let number: Int
    let name: String
    let sub: String
    let playlist: [LiveItem]
    let total: Double
}

struct LiveProgram: Identifiable {
    let id = UUID()
    let item: LiveItem
    let start: Double
    let end: Double
}

enum LiveTV {
    static let epoch: Double = 1704067200   // matches web LT_EPOCH

    static func tier(_ g: [String]) -> String {
        let mature = ["Horror", "War"], soft = ["Thriller", "Crime"], family = ["Family", "Kids"]
        if g.contains(where: mature.contains) { return "mature" }
        if g.contains(where: soft.contains) && !g.contains(where: family.contains) { return "mature" }
        if g.contains(where: family.contains) { return "family" }
        if g.contains("Animation") && !g.contains(where: (mature + soft).contains) { return "family" }
        return "general"
    }
    static func audOk(_ it: LiveItem, mature: Bool) -> Bool {
        mature ? tier(it.genres) != "family" : tier(it.genres) != "mature"
    }

    static func pool(movies: [Movie], episodes: [LiveEpisode]) -> [LiveItem] {
        let mv = movies.filter { !$0.isStream && ($0.backdrop != nil || $0.poster != nil) }.map {
            LiveItem(kind: "movie", title: $0.title, sub: nil, genres: $0.genreList,
                     year: $0.year, rating: $0.rating,
                     duration: $0.runtime.map { Double($0) * 60 } ?? $0.duration ?? 6300,
                     backdrop: $0.backdrop, poster: $0.poster, still: nil, overview: $0.overview,
                     movieLocalId: $0.localId, showId: nil, epId: nil)
        }
        let ep = episodes.map { e -> LiveItem in
            let g = Store.parseJSONStrings(e.genres)
            let tag = "S\(e.season ?? 0)·E\(e.episode ?? 0)"
            return LiveItem(kind: "episode", title: e.showTitle ?? "Episode",
                            sub: [tag, e.epTitle].compactMap { $0 }.joined(separator: " · "),
                            genres: g, year: e.year, rating: e.rating, duration: e.duration ?? 1800,
                            backdrop: e.backdrop, poster: e.poster, still: e.still, overview: e.overview,
                            movieLocalId: nil, showId: e.showId, epId: e.epId)
        }
        return mv + ep
    }

    struct Def { let name: String; let sub: String; let mature: Bool; let pick: (LiveItem) -> Bool; let sort: ((LiveItem, LiveItem) -> Bool)? }
    static func defs() -> [Def] {
        func has(_ it: LiveItem, _ g: String) -> Bool { it.genres.contains(g) }
        func hasAny(_ it: LiveItem, _ gs: [String]) -> Bool { it.genres.contains(where: gs.contains) }
        let byRating: (LiveItem, LiveItem) -> Bool = { ($0.rating ?? 0) > ($1.rating ?? 0) }
        let byYear: (LiveItem, LiveItem) -> Bool = { ($0.year ?? 0) > ($1.year ?? 0) }
        func decade(_ it: LiveItem, _ d: Int) -> Bool { let y = it.year ?? 0; return y >= d && y < d + 10 }
        return [
            Def(name: "PRIME", sub: "Feature Films", mature: false, pick: { $0.kind == "movie" }, sort: byRating),
            Def(name: "BINGE TV", sub: "Series Marathon", mature: false, pick: { $0.kind == "episode" }, sort: nil),
            Def(name: "ADRENALINE", sub: "Action", mature: false, pick: { has($0, "Action") }, sort: byRating),
            Def(name: "THE LAUGH TRACK", sub: "Comedy", mature: false, pick: { has($0, "Comedy") }, sort: nil),
            Def(name: "NIGHTMARE", sub: "Horror", mature: true, pick: { has($0, "Horror") }, sort: nil),
            Def(name: "PRESTIGE", sub: "Drama", mature: false, pick: { has($0, "Drama") }, sort: byRating),
            Def(name: "FAMILY ROOM", sub: "Family & Kids", mature: false, pick: { tier($0.genres) == "family" }, sort: nil),
            Def(name: "NEBULA", sub: "Science Fiction", mature: false, pick: { has($0, "Science Fiction") }, sort: nil),
            Def(name: "PRECINCT", sub: "Crime", mature: true, pick: { has($0, "Crime") }, sort: nil),
            Def(name: "MYTHOS", sub: "Fantasy", mature: false, pick: { has($0, "Fantasy") }, sort: nil),
            Def(name: "PULSE", sub: "Thrillers", mature: true, pick: { has($0, "Thriller") }, sort: nil),
            Def(name: "TRAILBLAZER", sub: "Adventure", mature: false, pick: { has($0, "Adventure") }, sort: nil),
            Def(name: "HEARTLINE", sub: "Romance", mature: false, pick: { has($0, "Romance") }, sort: nil),
            Def(name: "TOP SHELF", sub: "Top Rated", mature: false, pick: { ($0.rating ?? 0) >= 7.5 }, sort: byRating),
            Def(name: "TOON CITY", sub: "Animation", mature: false, pick: { has($0, "Animation") }, sort: nil),
            Def(name: "AFTER DARK", sub: "Late Night", mature: true, pick: { hasAny($0, ["Horror", "Thriller", "Crime"]) }, sort: byRating),
            Def(name: "FRESH", sub: "New Releases", mature: false, pick: { ($0.year ?? 0) >= 2020 }, sort: byYear),
            Def(name: "REWIND 90s", sub: "1990s", mature: false, pick: { decade($0, 1990) }, sort: nil),
            Def(name: "FLASHBACK 00s", sub: "2000s", mature: false, pick: { decade($0, 2000) }, sort: nil),
            Def(name: "SITCOM CENTRAL", sub: "TV Comedies", mature: false, pick: { $0.kind == "episode" && has($0, "Comedy") }, sort: nil),
            Def(name: "THE SERIAL", sub: "TV Dramas", mature: false, pick: { $0.kind == "episode" && has($0, "Drama") }, sort: byRating),
        ]
    }

    static func build(movies: [Movie], episodes: [LiveEpisode]) -> [LiveChannel] {
        let all = pool(movies: movies, episodes: episodes)
        guard !all.isEmpty else { return [] }
        var out: [LiveChannel] = []
        for d in defs() {
            if out.count >= 25 { break }
            var items = all.filter { d.pick($0) && audOk($0, mature: d.mature) }
            if items.count < 3 { continue }
            if let s = d.sort { items.sort(by: s) }
            let playlist = seededShuffle(items, seed: fnv(d.name))
            let total = playlist.reduce(0) { $0 + $1.duration }
            out.append(LiveChannel(id: out.count, number: out.count + 2, name: d.name, sub: d.sub,
                                   playlist: playlist, total: total))
        }
        return out
    }

    static func nowOn(_ ch: LiveChannel, _ atSec: Double) -> (item: LiveItem, offset: Double, endsIn: Double, idx: Int) {
        guard ch.total > 0 else { return (ch.playlist[0], 0, ch.playlist[0].duration, 0) }
        var pos = (atSec - epoch).truncatingRemainder(dividingBy: ch.total)
        if pos < 0 { pos += ch.total }
        for (i, it) in ch.playlist.enumerated() {
            if pos < it.duration { return (it, pos, it.duration - pos, i) }
            pos -= it.duration
        }
        return (ch.playlist[0], 0, ch.playlist[0].duration, 0)
    }

    static func window(_ ch: LiveChannel, from: Double, to: Double) -> [LiveProgram] {
        let first = nowOn(ch, from)
        var start = from - first.offset
        var idx = first.idx
        var out: [LiveProgram] = []
        var guardN = 0
        while start < to && guardN < 40 {
            let it = ch.playlist[idx % ch.playlist.count]
            out.append(LiveProgram(item: it, start: start, end: start + it.duration))
            start += it.duration; idx += 1; guardN += 1
        }
        return out
    }

    private static func fnv(_ s: String) -> UInt32 {
        var h: UInt32 = 2166136261
        for b in s.utf8 { h ^= UInt32(b); h = h &* 16777619 }
        return h
    }
    private static func seededShuffle(_ arr: [LiveItem], seed: UInt32) -> [LiveItem] {
        var a = arr, s = seed == 0 ? 1 : seed
        func rnd() -> Double { s = s &* 1103515245 &+ 12345; return Double(s & 0x7fffffff) / Double(0x7fffffff) }
        for i in stride(from: a.count - 1, to: 0, by: -1) { a.swapAt(i, Int(rnd() * Double(i + 1))) }
        return a
    }
}

// ---- The view ----
struct LiveTVView: View {
    @EnvironmentObject var store: Store
    @State private var channels: [LiveChannel] = []
    @State private var episodes: [LiveEpisode] = []
    @State private var loading = true
    @State private var selected = 0
    @State private var tuned: TunedLive?
    @State private var now = Date()
    @FocusState private var focusedChannel: Int?
    private let timer = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    private let ppm: CGFloat = 12          // points per guide-minute
    private let windowMin: Double = 90
    private let labelW: CGFloat = 310      // room for full channel names

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if loading {
                ProgressView("Tuning in…").scaleEffect(1.4)
            } else if channels.isEmpty {
                VStack(spacing: 14) {
                    Image(systemName: "dot.radiowaves.left.and.right").font(.system(size: 60)).foregroundStyle(Theme.accent)
                    Text("Add movies or shows to start broadcasting.").foregroundStyle(.secondary)
                }
            } else {
                // The marquee preview is PINNED — it carries what you're looking
                // at while only the guide rows scroll underneath it. Kept COMPACT
                // (small wordmark, short hero) so the guide shows several
                // channels at once instead of ~1.5.
                VStack(alignment: .leading, spacing: 10) {
                    if channels.indices.contains(selected) { preview(channels[selected]) }
                    guide
                        .frame(maxHeight: .infinity)
                }
                .ignoresSafeArea()
            }
        }
        .task { await load() }
        .onReceive(timer) { now = $0 }
        .onChange(of: focusedChannel) { if let f = focusedChannel { selected = f } }
        .fullScreenCover(item: $tuned) { t in
            LivePlayer(item: t.item, offset: t.offset).environmentObject(store).ignoresSafeArea()
        }
    }

    // Full-bleed hero for the focused channel's current program.
    @ViewBuilder private func preview(_ ch: LiveChannel) -> some View {
        let on = LiveTV.nowOn(ch, now.timeIntervalSince1970)
        ZStack(alignment: .topLeading) {
            previewArt(ch, on: on)
            MarqueeWordmark(size: 20)
                .padding(.leading, Theme.gutter).padding(.top, 24)
        }
    }

    @ViewBuilder private func previewArt(_ ch: LiveChannel, on: (item: LiveItem, offset: Double, endsIn: Double, idx: Int)) -> some View {
        ZStack(alignment: .bottomLeading) {
            ArtImage(url: on.item.backdrop ?? on.item.still ?? on.item.poster, aspect: 16.0 / 9.0)
                .frame(height: 300).frame(maxWidth: .infinity).clipped()
                .overlay {
                    LinearGradient(stops: [
                        .init(color: Theme.bg, location: 0.0),
                        .init(color: Theme.bg.opacity(0.55), location: 0.28),
                        .init(color: .clear, location: 0.62),
                        .init(color: .clear, location: 0.82),
                        .init(color: Theme.bg.opacity(0.5), location: 1.0)
                    ], startPoint: .bottom, endPoint: .top)
                }
                .overlay {
                    LinearGradient(stops: [
                        .init(color: Theme.bg.opacity(0.9), location: 0.0),
                        .init(color: .clear, location: 0.55)
                    ], startPoint: .leading, endPoint: .trailing)
                }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    Text("\(ch.number)").font(.subheadline).fontWeight(.heavy)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Theme.accent, in: RoundedRectangle(cornerRadius: 7))
                    Text(ch.name).font(.callout).fontWeight(.heavy).kerning(2)
                    HStack(spacing: 6) { Circle().fill(.red).frame(width: 10, height: 10); Text("LIVE").font(.caption2).fontWeight(.bold) }
                }
                HStack(spacing: 14) {
                    Text(on.item.title).font(.system(size: 30, weight: .bold)).shadow(radius: 10).lineLimit(1)
                    if let y = on.item.year { Chip(String(y)) }
                    if let r = on.item.rating, r > 0 { Chip(String(format: "★ %.1f", r)) }
                    if let s = on.item.sub { Chip(s) }
                }
                HStack(spacing: 14) {
                    ProgressView(value: min(on.offset / on.item.duration, 1))
                        .tint(Theme.accent).frame(maxWidth: 340)
                    Text("\(Int(on.offset / 60)) min in · Up next \(clock(now.timeIntervalSince1970 + on.endsIn))")
                        .font(.caption).foregroundStyle(.secondary)
                    Button { tuned = TunedLive(item: on.item, offset: on.offset) } label: {
                        Label("Tune In", systemImage: "play.fill").font(.subheadline).padding(.horizontal, 12)
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.accent)
                }
            }
            .padding(.horizontal, Theme.gutter).padding(.bottom, 18)
        }
    }

    // The EPG grid: a shared timeline, programs positioned by their real air
    // time (so different lengths start at different points), with a live red
    // playhead marking "now". The window starts on the half hour (web drawEpg
    // floors to :00/:30) so the time axis reads 3:00 / 3:30 — not 2:53.
    private var guide: some View {
        let nowSec = now.timeIntervalSince1970
        let winStart = (nowSec / 1800).rounded(.down) * 1800   // floor to :00/:30
        let winEnd = winStart + windowMin * 60
        let nowX = Theme.gutter + labelW + CGFloat((nowSec - winStart) / 60) * ppm
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 14) {
                Circle().fill(.red).frame(width: 14, height: 14)
                Text("GUIDE").font(.title3).fontWeight(.heavy).kerning(2)
            }
            .padding(.horizontal, Theme.gutter)

            // Time axis (every 30 min across the window).
            HStack(spacing: 0) {
                Color.clear.frame(width: labelW)
                ForEach(0..<Int(windowMin / 30), id: \.self) { i in
                    Text(clock(winStart + Double(i) * 30 * 60))
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(width: 30 * ppm, alignment: .leading)
                }
            }
            .padding(.leading, Theme.gutter)

            // Channel rows scroll under the pinned marquee + time axis; the red
            // "now" line rides inside the scroll content, spanning all rows.
            // tvOS auto-scrolls to keep the focused channel visible.
            ScrollView(.vertical, showsIndicators: false) {
                ZStack(alignment: .topLeading) {
                    VStack(spacing: 8) {
                        ForEach(channels) { ch in
                            channelRow(ch, winStart: winStart, winEnd: winEnd, nowSec: nowSec)
                        }
                    }
                    Rectangle().fill(.red).frame(width: 3)
                        .overlay(alignment: .top) { Circle().fill(.red).frame(width: 14, height: 14).offset(y: -6) }
                        .padding(.leading, nowX)
                        .allowsHitTesting(false)
                }
                .padding(.bottom, Theme.gutter)
            }
        }
    }

    private func channelRow(_ ch: LiveChannel, winStart: Double, winEnd: Double, nowSec: Double) -> some View {
        let progs = LiveTV.window(ch, from: winStart, to: winEnd)
        let focused = focusedChannel == ch.id
        return Button {
            let on = LiveTV.nowOn(ch, now.timeIntervalSince1970)
            tuned = TunedLive(item: on.item, offset: on.offset)
        } label: {
            HStack(spacing: 0) {
                HStack(spacing: 10) {
                    Text("\(ch.number)")
                        .font(.callout).fontWeight(.heavy)
                        .foregroundStyle(focused ? .white : Theme.muted)
                        .frame(width: 44, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ch.name)
                            .font(.callout).fontWeight(.bold).lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .foregroundStyle(focused ? Theme.accent2 : .white)
                        Text(ch.sub).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .padding(.trailing, 10)
                .frame(width: labelW, alignment: .leading)

                ZStack(alignment: .topLeading) {
                    ForEach(progs) { p in
                        let x = CGFloat(max(0, (p.start - winStart) / 60)) * ppm
                        let w = CGFloat((min(p.end, winEnd) - max(p.start, winStart)) / 60) * ppm
                        let isNow = p.start <= nowSec && p.end > nowSec
                        if w > 4 {
                            Text(p.item.title)
                                .font(.callout).fontWeight(isNow ? .semibold : .regular).lineLimit(1)
                                .padding(.horizontal, 12)
                                .frame(width: max(1, w - 4), height: 66, alignment: .leading)
                                .background(isNow ? Theme.accent.opacity(0.30) : Color.white.opacity(0.06))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(isNow ? Theme.accent : Color.white.opacity(0.12), lineWidth: isNow ? 2 : 1))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                                .offset(x: x)
                        }
                    }
                }
                .frame(width: windowMin * ppm, height: 66, alignment: .topLeading)
                .clipped()
            }
            .padding(.vertical, 6)
            .padding(.leading, Theme.gutter)
            // Focus cue: a soft row tint + accent channel name — NOT the stock
            // white platter, which read as a giant white bar across the guide.
            .background(focused ? Color.white.opacity(0.07) : .clear,
                        in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(GuideRowButtonStyle())
        .focused($focusedChannel, equals: ch.id)
    }

    private func clock(_ sec: Double) -> String {
        let f = DateFormatter(); f.dateFormat = "h:mm a"
        return f.string(from: Date(timeIntervalSince1970: sec))
    }

    private func load() async {
        loading = true
        if store.movies.isEmpty { await store.loadHome() }
        episodes = await store.loadLiveEpisodes()
        channels = LiveTV.build(movies: store.movies, episodes: episodes)
        loading = false
    }
}

// A no-chrome button style for guide rows: keeps tvOS focusability but draws
// none of the stock focus platter (the row renders its own focus cue).
struct GuideRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
    }
}

struct TunedLive: Identifiable, Hashable {
    let item: LiveItem; let offset: Double
    var id: String { "\(item.kind)-\(item.movieLocalId ?? item.epId ?? 0)" }
}

// Resolves a Live TV item's playable file (movie or episode) and plays at the
// live offset.
struct LivePlayer: View {
    @EnvironmentObject var store: Store
    let item: LiveItem
    let offset: Double
    @State private var url: URL?
    @State private var ref: Store.PlayRef?
    @State private var dur: Double?
    @State private var failed = false

    @State private var fileId: Int?

    var body: some View {
        Group {
            if let url, let ref {
                PlayerView(url: url, startAt: offset, ref: ref, duration: dur, store: store,
                           title: item.title, subtitle: item.sub, fileId: fileId, live: true)
            } else if failed {
                ZStack { Color.black; Text("Can't play this right now.").foregroundStyle(.white) }
            } else {
                ZStack { Color.black; ProgressView().tint(.white) }
            }
        }
        .task { await resolve() }
    }

    private func resolve() async {
        if let mid = item.movieLocalId, let d = await store.movieDetail(mid), let f = d.bestFile {
            url = store.playbackURL(kind: "movie", file: f); ref = .movie(mid); dur = d.duration; fileId = f.id
        } else if let sid = item.showId, let epId = item.epId, let d = await store.showDetail(sid) {
            let ep = d.seasons.flatMap { $0.episodes }.first { $0.id == epId }
            if let ep, let f = ep.bestFile {
                url = store.playbackURL(kind: "episode", file: f); ref = .episode(epId); dur = ep.duration; fileId = f.id
            }
        }
        if url == nil { failed = true }
    }
}
