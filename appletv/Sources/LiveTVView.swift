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

// ============================================================================
// The view. The guide is a timetable, which is the thing Braun drew best:
// hairlines only, no coloured blocks. The vertical signal line is NOW, and it is
// the only orange in the grid, so where you are is never ambiguous.
//
// The now-playing strip stays COMPACT on purpose (the earlier full-bleed hero
// pushed the guide off the bottom and you could only see two channels).
// ============================================================================

struct LiveTVView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
    @State private var channels: [LiveChannel] = []
    @State private var episodes: [LiveEpisode] = []
    @State private var loading = true
    @State private var selected = 0
    @State private var tuned: TunedLive?
    @State private var now = Date()
    @FocusState private var focusedChannel: Int?
    private let timer = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    private let ppm: CGFloat = 16          // points per guide-minute
    private let windowMin: Double = 90
    private let labelW: CGFloat = 250

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            if loading {
                ProgressView().scaleEffect(1.5)
            } else if channels.isEmpty {
                Text("Add movies or shows to start broadcasting.")
                    .font(F.reg(24)).foregroundStyle(pal.ink2)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    if channels.indices.contains(selected) { preview(channels[selected]) }
                    guide.padding(.top, 22).frame(maxHeight: .infinity)
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.top, 22)
            }
        }
        .task { await load() }
        .onReceive(timer) { now = $0 }
        .onChange(of: focusedChannel) { if let f = focusedChannel { selected = f } }
        .fullScreenCover(item: $tuned) { t in
            LivePlayer(item: t.item, offset: t.offset)
                .environmentObject(store)
                .environment(\.pal, pal)
                .ignoresSafeArea()
        }
    }

    // Compact now-playing strip: a plate beside the facts, so the guide keeps
    // most of the screen and several channels stay visible.
    @ViewBuilder private func preview(_ ch: LiveChannel) -> some View {
        let on = LiveTV.nowOn(ch, now.timeIntervalSince1970)
        HStack(alignment: .center, spacing: 28) {
            ArtPlate(url: on.item.backdrop ?? on.item.still ?? on.item.poster,
                     width: 340, height: 191, title: on.item.title)

            VStack(alignment: .leading, spacing: 0) {
                Lab("On now   ·   \(ch.name)   ·   Channel \(ch.number)", small: true)
                Text(on.item.title)
                    .font(F.med(38)).foregroundStyle(pal.ink)
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .padding(.top, 10)
                if let s = on.item.sub {
                    Text(s).font(F.reg(18)).foregroundStyle(pal.ink2).lineLimit(1).padding(.top, 6)
                }
                Text(joinLine(on)).font(F.mono(15)).tracking(1.1).foregroundStyle(pal.ink3)
                    .padding(.top, 12)
                // How far in. Orange, because it is where you are.
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(pal.rule)
                        Rectangle().fill(pal.signal)
                            .frame(width: geo.size.width * min(on.offset / max(on.item.duration, 1), 1))
                    }
                }
                .frame(width: 420, height: 5)
                .padding(.top, 14)
            }

            Spacer(minLength: 20)
            MButton(title: "Join", kind: .primary, play: true) {
                tuned = TunedLive(item: on.item, offset: on.offset)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .focusSection()
        .overlay(alignment: .bottom) { Rectangle().fill(pal.rule).frame(height: 1).padding(.top, 18) }
    }

    private func joinLine(_ on: (item: LiveItem, offset: Double, endsIn: Double, idx: Int)) -> String {
        let started = now.timeIntervalSince1970 - on.offset
        return "STARTED \(clock(started))   /   \(Int(on.offset / 60)) MIN IN   /   ENDS \(clock(now.timeIntervalSince1970 + on.endsIn))"
    }

    // The EPG: a shared timeline, programs positioned by their real air time.
    // The window starts on the half hour so the axis reads 8:00 / 8:30.
    private var guide: some View {
        let nowSec = now.timeIntervalSince1970
        let winStart = (nowSec / 1800).rounded(.down) * 1800
        let winEnd = winStart + windowMin * 60
        let nowX = labelW + CGFloat((nowSec - winStart) / 60) * ppm
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Color.clear.frame(width: labelW)
                ForEach(0..<Int(windowMin / 30), id: \.self) { i in
                    Lab(clock(winStart + Double(i) * 30 * 60), small: true)
                        .frame(width: 30 * ppm, alignment: .leading)
                }
                Spacer(minLength: 0)
            }
            .frame(height: 44)
            .overlay(alignment: .bottom) { Rectangle().fill(pal.rule).frame(height: 1) }

            ScrollView(.vertical, showsIndicators: false) {
                ZStack(alignment: .topLeading) {
                    LazyVStack(spacing: 0) {
                        ForEach(channels) { ch in
                            channelRow(ch, winStart: winStart, winEnd: winEnd, nowSec: nowSec)
                        }
                    }
                    // NOW. The only orange in the grid.
                    Rectangle().fill(pal.signal).frame(width: 2)
                        .padding(.leading, nowX)
                        .allowsHitTesting(false)
                }
                .padding(.bottom, 30)
            }
            .focusSection()
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
                HStack(spacing: 12) {
                    Text("\(ch.number)").font(F.mono(15)).foregroundStyle(pal.ink3)
                        .frame(width: 30, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(ch.name.uppercased())
                            .font(F.semi(16)).tracking(2.0)
                            .foregroundStyle(focused ? pal.ink : pal.ink2)
                            .lineLimit(1).minimumScaleFactor(0.7)
                        Text(ch.sub).font(F.mono(12)).foregroundStyle(pal.ink3).lineLimit(1)
                    }
                }
                .padding(.horizontal, 14)
                .frame(width: labelW, height: 84, alignment: .leading)
                .background(pal.panel2)

                ZStack(alignment: .topLeading) {
                    ForEach(progs) { p in
                        let x = CGFloat(max(0, (p.start - winStart) / 60)) * ppm
                        let w = CGFloat((min(p.end, winEnd) - max(p.start, winStart)) / 60) * ppm
                        let isNow = p.start <= nowSec && p.end > nowSec
                        if w > 6 {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(p.item.title)
                                    .font(isNow ? F.med(16) : F.reg(16))
                                    .foregroundStyle(pal.ink).lineLimit(1)
                                Text(metaLine(p.item)).font(F.mono(12))
                                    .foregroundStyle(pal.ink3).lineLimit(1)
                            }
                            .padding(.horizontal, 12)
                            .frame(width: max(1, w - 1), height: 84, alignment: .leading)
                            .background(isNow ? pal.panel2 : Color.clear)
                            .overlay(alignment: .trailing) { Rectangle().fill(pal.rule2).frame(width: 1) }
                            .offset(x: x)
                        }
                    }
                }
                .frame(width: windowMin * ppm, height: 84, alignment: .topLeading)
                .clipped()
            }
            .overlay(alignment: .bottom) { Rectangle().fill(pal.rule2).frame(height: 1) }
            .overlay(alignment: .leading) { Rectangle().fill(pal.signal).frame(width: focused ? 6 : 0) }
            .background(focused ? pal.panel : Color.clear)
        }
        .buttonStyle(.bare)
        .focused($focusedChannel, equals: ch.id)
        .focusEffectDisabled()
    }

    private func metaLine(_ it: LiveItem) -> String {
        var parts: [String] = []
        if let y = it.year { parts.append(String(y)) }
        parts.append(timecode(it.duration))
        return parts.joined(separator: "  ·  ")
    }

    private func clock(_ sec: Double) -> String {
        let f = DateFormatter(); f.dateFormat = "h:mm"
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
