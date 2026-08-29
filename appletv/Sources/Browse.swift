import SwiftUI

// ============================================================================
// The Marquee — the featured spotlight the app is named after. A deterministic
// weekly pick of 6, rotating every 9s.
//
// The artwork is a PLATE: framed, never scrimmed, and nothing is set on top of
// it. The title, the facts and the actions sit beside it on the panel. Six ticks
// on a dial say where you are in the rotation.
// ============================================================================

struct HeroItem: Identifiable, Hashable {
    let id: String
    let title: String
    let backdrop: String?
    var poster: String? = nil    // fallback art if the backdrop won't load
    let year: Int?
    let rating: Double?
    let badge: String?
    let overview: String?
    let route: Route
}

struct MarqueeHero: View {
    let items: [HeroItem]
    @Binding var route: [Route]
    @Environment(\.pal) private var pal
    @State private var idx = 0
    private let timer = Timer.publish(every: 9, on: .main, in: .common).autoconnect()

    var body: some View {
        let it = idx < items.count ? items[idx] : items[0]
        HStack(alignment: .top, spacing: 44) {
            ArtPlate(url: it.backdrop ?? it.poster, width: 1074, height: 396, title: it.title)
                .id(it.id)
                .transition(.opacity)

            VStack(alignment: .leading, spacing: 0) {
                Lab("The Marquee — this week", small: true)
                Text(it.title)
                    .font(F.med(54)).foregroundStyle(pal.ink)
                    .lineLimit(2).minimumScaleFactor(0.7)
                    .padding(.top, 18)
                Text(meta(it)).font(F.mono(16)).tracking(1.2).foregroundStyle(pal.ink3)
                    .padding(.top, 18)
                if let o = it.overview, !o.isEmpty {
                    Text(o).font(F.reg(19)).lineSpacing(7).foregroundStyle(pal.ink2)
                        .lineLimit(4).padding(.top, 18)
                }
                HStack(spacing: 14) {
                    MButton(title: "Play", kind: .primary, play: true) { route.append(it.route) }
                    MButton(title: "Details") { route.append(it.route) }
                }
                .padding(.top, 26)
                .focusSection()
                Dial(count: items.count, index: idx).padding(.top, 34)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, Theme.gutter)
        .onReceive(timer) { _ in
            guard items.count > 1 else { return }
            withAnimation(.easeInOut(duration: 0.5)) { idx = (idx + 1) % items.count }
        }
    }

    private func meta(_ it: HeroItem) -> String {
        var parts: [String] = []
        if let y = it.year { parts.append(String(y)) }
        if let b = it.badge { parts.append(b.uppercased()) }
        if let r = it.rating, r > 0 { parts.append(String(format: "%.1f", r)) }
        return parts.joined(separator: "   /   ")
    }
}

// Rotation position as a dial scale, not a row of dots.
struct Dial: View {
    let count: Int
    let index: Int
    @Environment(\.pal) private var pal
    var body: some View {
        HStack(alignment: .bottom, spacing: 9) {
            ForEach(0..<max(count, 1), id: \.self) { i in
                Rectangle()
                    .fill(i == index ? pal.signal : pal.ink3)
                    .frame(width: i == index ? 3 : 2, height: i == index ? 22 : 11)
            }
        }
        .frame(height: 22, alignment: .bottom)
    }
}

// ============================================================================
// Browse rows — the categorized carousels under the hero.
// ============================================================================

struct BrowseCard: Identifiable, Hashable {
    let id: String
    let title: String
    let poster: String?
    let subtitle: String?
    let progress: Double
    let badges: [CardBadge]
    let stream: [String]?      // provider slugs → opens the service instead of a detail
    let route: Route
}

// Streaming providers — names and per-title deep links (web STREAM_PROVIDERS).
// The colours are gone: a provider badge is a label, and only state gets colour.
enum StreamProvider {
    static let table: [String: (name: String, color: UInt, base: String)] = [
        "netflix":   ("Netflix",     0xe50914, "https://www.netflix.com/search?q="),
        "prime":     ("Prime Video", 0x1399ff, "https://www.primevideo.com/search/?phrase="),
        "disney":    ("Disney+",     0x0a63e6, "https://www.disneyplus.com/search?q="),
        "hulu":      ("Hulu",        0x1ce783, "https://www.hulu.com/search?q="),
        "max":       ("Max",         0xa05cff, "https://play.max.com/search?q="),
        "appletv":   ("Apple TV+",   0x7d7d7d, "https://tv.apple.com/search?term="),
        "paramount": ("Paramount+",  0x0064ff, "https://www.paramountplus.com/search/?query="),
        "peacock":   ("Peacock",     0x00b7eb, "https://www.peacocktv.com/search?q=")
    ]
    static func name(_ s: String) -> String { table[s]?.name ?? s.capitalized }
    static func color(_ s: String) -> UInt { table[s]?.color ?? 0x555555 }
    static func label(_ provs: [String]) -> String {
        guard let f = provs.first else { return "Streaming" }
        return name(f) + (provs.count > 1 ? " +\(provs.count - 1)" : "")
    }
    static func url(_ slug: String, _ title: String) -> URL? {
        guard let base = table[slug]?.base else { return nil }
        let q = title.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return URL(string: base + q)
    }
}

struct BrowseRow: Identifiable {
    let id: String
    let title: String
    let cards: [BrowseCard]
}

// A hero + Continue Watching + generated rows. Home/Movies/TV all use this.
struct BrowseScreen: View {
    @EnvironmentObject var store: Store
    @Environment(\.openURL) private var openURL
    @Environment(\.pal) private var pal
    @Binding var route: [Route]
    let heroItems: [HeroItem]
    let rows: [BrowseRow]
    let continueKind: String?     // "movie" | "episode" | nil (both)

    // Streaming cards open the service; everything else pushes a detail page.
    private func tap(_ c: BrowseCard) {
        if let provs = c.stream, let slug = provs.first, let url = StreamProvider.url(slug, c.title) {
            openURL(url)
        } else {
            route.append(c.route)
        }
    }

    private var continueItems: [ContinueItem] {
        guard let k = continueKind else { return store.continueItems }
        return store.continueItems.filter { $0.kind == k }
    }

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            ScrollView {
                // LAZY: Home builds ~20 rows. A plain VStack constructed every
                // one of them, and every card in them, before the first frame.
                LazyVStack(alignment: .leading, spacing: Theme.rowSpacing) {
                    if !heroItems.isEmpty {
                        MarqueeHero(items: heroItems, route: $route)
                            .padding(.top, 26)
                            .focusSection()   // up from any card lands on the hero
                    }

                    if !continueItems.isEmpty {
                        MediaRow(title: "Continue watching", count: "\(continueItems.count)") {
                            ForEach(continueItems) { item in
                                PosterCard(title: item.displayTitle, posterURL: item.poster,
                                           subtitle: item.subtitle,
                                           progress: item.progressFraction,
                                           showPlay: true,
                                           onMarkWatched: { Task { await store.markContinueWatched(item) } },
                                           action: {
                                               // Movies open their page; episodes open the
                                               // EPISODE page (Resume/Mark Watched live there).
                                               if item.kind == "movie" { route.append(.movie(item.id)) }
                                               else if let sid = item.showId { route.append(.episode(sid, item.id)) }
                                           })
                            }
                        }
                        .padding(.top, 12)
                    }

                    ForEach(rows) { row in
                        MediaRow(title: row.title, count: "\(row.cards.count)") {
                            ForEach(row.cards) { c in
                                PosterCard(title: c.title, posterURL: c.poster, subtitle: c.subtitle,
                                           progress: c.progress, badges: c.badges) { tap(c) }
                            }
                        }
                    }
                }
                .padding(.bottom, 60)
            }
        }
        // Keep watch state fresh: Continue Watching appears/updates and
        // marked-watched titles drop out when you come back to a browse page.
        .onAppear { Task { await store.refreshHome() } }
    }
}

// ---- Row/hero builders (mirror the web app's view() row set) ----
enum Browse {
    static func movieCard(_ m: Movie) -> BrowseCard {
        if m.isStream {
            let provs = m.providers ?? []
            return BrowseCard(id: "m\(m.id)", title: m.title, poster: m.poster,
                              subtitle: m.year.map(String.init), progress: 0,
                              badges: [.stream(StreamProvider.label(provs), StreamProvider.color(provs.first ?? ""))],
                              stream: provs, route: .movie(0))
        }
        var badges: [CardBadge] = []
        if m.isNew { badges.append(.new) }
        else if (m.versions ?? 0) > 1, let q = m.bestQuality { badges.append(.quality(q)) }
        if let also = m.alsoOn, let f = also.first {
            badges.append(.alsoOn(StreamProvider.label(also), StreamProvider.color(f)))
        }
        return BrowseCard(id: "m\(m.id)", title: m.title, poster: m.poster,
                          subtitle: m.year.map(String.init), progress: m.progressFraction,
                          badges: badges, stream: nil, route: .movie(m.localId ?? 0))
    }
    static func showCard(_ s: Show) -> BrowseCard {
        if s.isStream {
            let provs = s.providers ?? []
            return BrowseCard(id: "s\(s.id)", title: s.title, poster: s.poster,
                              subtitle: s.year.map(String.init), progress: 0,
                              badges: [.stream(StreamProvider.label(provs), StreamProvider.color(provs.first ?? ""))],
                              stream: provs, route: .show(0))
        }
        var badges: [CardBadge] = []
        if let u = s.unwatched, u > 0 { badges.append(.newCount(u)) }
        else if s.isNew { badges.append(.new) }
        if let also = s.alsoOn, let f = also.first {
            badges.append(.alsoOn(StreamProvider.label(also), StreamProvider.color(f)))
        }
        return BrowseCard(id: "s\(s.id)", title: s.title, poster: s.poster,
                          subtitle: s.year.map(String.init), progress: 0,
                          badges: badges, stream: nil, route: .show(s.localId ?? 0))
    }

    static func heroFromMovies(_ movies: [Movie]) -> [HeroItem] {
        weeklyPick(movies.filter { $0.backdrop != nil && !$0.isStream }, 6).map {
            HeroItem(id: "m\($0.id)", title: $0.title, backdrop: $0.backdrop, year: $0.year,
                     rating: $0.rating, badge: $0.bestQuality, overview: $0.overview, route: .movie($0.localId ?? 0))
        }
    }
    static func heroFromShows(_ shows: [Show]) -> [HeroItem] {
        weeklyPick(shows.filter { $0.backdrop != nil && !$0.isStream }, 6).map {
            HeroItem(id: "s\($0.id)", title: $0.title, backdrop: $0.backdrop, year: $0.year,
                     rating: $0.rating, badge: $0.episodes.map { "\($0) episodes" }, overview: $0.overview, route: .show($0.localId ?? 0))
        }
    }
    static func heroMixed(_ movies: [Movie], _ shows: [Show]) -> [HeroItem] {
        let m = movies.filter { $0.backdrop != nil && !$0.isStream }.map { HeroItem(id: "m\($0.id)", title: $0.title, backdrop: $0.backdrop, year: $0.year, rating: $0.rating, badge: $0.bestQuality, overview: $0.overview, route: .movie($0.localId ?? 0)) }
        let s = shows.filter { $0.backdrop != nil && !$0.isStream }.map { HeroItem(id: "s\($0.id)", title: $0.title, backdrop: $0.backdrop, year: $0.year, rating: $0.rating, badge: $0.episodes.map { "\($0) eps" }, overview: $0.overview, route: .show($0.localId ?? 0)) }
        return weeklyPick((m + s).sorted { ($0.rating ?? 0) > ($1.rating ?? 0) }, 6)
    }

    static func movieRows(_ movies: [Movie]) -> [BrowseRow] {
        var rows: [BrowseRow] = []
        func add(_ id: String, _ t: String, _ list: [Movie]) {
            if !list.isEmpty { rows.append(BrowseRow(id: id, title: t, cards: list.prefix(24).map(movieCard))) }
        }
        add("recent", "Recently Added", movies.sorted { ($0.addedAt ?? 0) > ($1.addedAt ?? 0) })
        add("released", "Recently Released", movies.sorted { ($0.year ?? 0) > ($1.year ?? 0) })
        add("rec", "Recommended", movies.filter { ($0.watched ?? 0) == 0 }.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        add("top", "Top Rated", movies.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        add("acclaim", "Critically Acclaimed", movies.filter { ($0.rating ?? 0) >= 8 }.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        add("unwatched", "Unwatched", movies.filter { ($0.watched ?? 0) == 0 })
        add("again", "Watch Again", movies.filter { ($0.watched ?? 0) == 1 })
        add("fav", "Favorites", movies.filter { ($0.favorite ?? 0) == 1 })
        add("4k", "4K", movies.filter { $0.is4K })
        for g in topGenres(movies.map { $0.genreList }) {
            add("g-\(g)", g, movies.filter { $0.genreList.contains(g) }.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        }
        for d in decades(movies.map { $0.year }) {
            add("d-\(d)", "\(d)s", movies.filter { ($0.year ?? 0) >= d && ($0.year ?? 0) < d + 10 }.sorted { ($0.year ?? 0) > ($1.year ?? 0) })
        }
        return rows
    }

    static func showRows(_ shows: [Show]) -> [BrowseRow] {
        var rows: [BrowseRow] = []
        func add(_ id: String, _ t: String, _ list: [Show]) {
            if !list.isEmpty { rows.append(BrowseRow(id: id, title: t, cards: list.prefix(24).map(showCard))) }
        }
        add("recent", "Recently Added", shows.sorted { ($0.addedAt ?? 0) > ($1.addedAt ?? 0) })
        add("released", "Recently Released", shows.sorted { ($0.year ?? 0) > ($1.year ?? 0) })
        add("new", "New Episodes", shows.filter { ($0.unwatched ?? 0) > 0 })
        add("top", "Top Rated", shows.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        add("acclaim", "Critically Acclaimed", shows.filter { ($0.rating ?? 0) >= 8 }.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        for g in topGenres(shows.map { $0.genreList }) {
            add("g-\(g)", g, shows.filter { $0.genreList.contains(g) }.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        }
        return rows
    }

    // Home's Recently Added mixes movies AND shows by added date (web mixedRecent).
    static func mixedRecentCards(_ movies: [Movie], _ shows: [Show]) -> [BrowseCard] {
        let m = movies.map { (at: $0.addedAt ?? 0, card: movieCard($0)) }
        let s = shows.map { (at: $0.addedAt ?? 0, card: showCard($0)) }
        return (m + s).sorted { $0.at > $1.at }.prefix(24).map { $0.card }
    }

    static func homeRows(_ movies: [Movie], _ shows: [Show]) -> [BrowseRow] {
        var rows: [BrowseRow] = []
        func addM(_ id: String, _ t: String, _ list: [Movie]) {
            if !list.isEmpty { rows.append(BrowseRow(id: id, title: t, cards: list.prefix(24).map(movieCard))) }
        }
        func addS(_ id: String, _ t: String, _ list: [Show]) {
            if !list.isEmpty { rows.append(BrowseRow(id: id, title: t, cards: list.prefix(24).map(showCard))) }
        }
        let recent = mixedRecentCards(movies, shows)
        if !recent.isEmpty { rows.append(BrowseRow(id: "recent", title: "Recently Added", cards: recent)) }
        addM("released", "Recently Released", movies.sorted { ($0.year ?? 0) > ($1.year ?? 0) })
        addM("rec", "Recommended", movies.filter { ($0.watched ?? 0) == 0 }.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        addM("movies", "Movies", movies.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        addS("tv", "TV Shows", shows.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        addM("acclaim", "Critically Acclaimed", movies.filter { ($0.rating ?? 0) >= 8 }.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        addM("unwatched", "Unwatched Movies", movies.filter { ($0.watched ?? 0) == 0 })
        addM("fav", "Favorites", movies.filter { ($0.favorite ?? 0) == 1 })
        for g in topGenres(movies.map { $0.genreList }) {
            addM("g-\(g)", g, movies.filter { $0.genreList.contains(g) }.sorted { ($0.rating ?? 0) > ($1.rating ?? 0) })
        }
        return rows
    }

    // Genres present, ordered by how many titles carry them (most first).
    static func topGenres(_ lists: [[String]]) -> [String] {
        var counts: [String: Int] = [:]
        for l in lists { for g in l { counts[g, default: 0] += 1 } }
        return counts.filter { $0.value >= 3 }.sorted { $0.value > $1.value }.map { $0.key }
    }
    static func decades(_ years: [Int?]) -> [Int] {
        let ds = Set(years.compactMap { $0 }.filter { $0 > 1900 }.map { ($0 / 10) * 10 })
        return ds.sorted(by: >)
    }
}

// Deterministic weekly shuffle → featured set is stable all week (seeded by the
// week number), matching the web app so every device sees the same spotlight.
func weeklyPick<T>(_ items: [T], _ n: Int) -> [T] {
    var pool = items
    if pool.count <= n { return pool }
    var s = UInt32(truncatingIfNeeded: Int(Date().timeIntervalSince1970 / 604800)) &* 2654435761
    func rand() -> Double { s = s &* 1664525 &+ 1013904223; return Double(s) / 4294967296.0 }
    for i in stride(from: pool.count - 1, to: 0, by: -1) {
        let j = Int(rand() * Double(i + 1))
        pool.swapAt(i, j)
    }
    return Array(pool.prefix(n))
}
