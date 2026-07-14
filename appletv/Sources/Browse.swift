import SwiftUI

// ============================================================================
// The Marquee — an auto-rotating featured spotlight (the app's namesake).
// Mirrors the web hero: a deterministic weekly pick of 6, rotating every 9s,
// with dots, a Play and a More Info action.
// ============================================================================

struct HeroItem: Identifiable, Hashable {
    let id: String
    let title: String
    let backdrop: String?
    let year: Int?
    let rating: Double?
    let badge: String?
    let overview: String?
    let route: Route
}

struct MarqueeHero: View {
    let items: [HeroItem]
    @Binding var route: [Route]
    @State private var idx = 0
    private let timer = Timer.publish(every: 9, on: .main, in: .common).autoconnect()

    var body: some View {
        let it = idx < items.count ? items[idx] : items[0]
        ZStack(alignment: .bottomLeading) {
            ArtImage(url: it.backdrop, aspect: 16.0 / 9.0)
                .frame(height: 840).frame(maxWidth: .infinity).clipped()
                // Vertical fade — melt into the page at the bottom AND soften the
                // top so there's no hard edge under the tab bar.
                .overlay {
                    LinearGradient(stops: [
                        .init(color: Theme.bg, location: 0.0),
                        .init(color: Theme.bg.opacity(0.55), location: 0.26),
                        .init(color: .clear, location: 0.58),
                        .init(color: .clear, location: 0.82),
                        .init(color: Theme.bg.opacity(0.5), location: 1.0)
                    ], startPoint: .bottom, endPoint: .top)
                }
                // Horizontal scrim so the title reads over bright art (web 90deg).
                .overlay {
                    LinearGradient(stops: [
                        .init(color: Theme.bg.opacity(0.95), location: 0.0),
                        .init(color: Theme.bg.opacity(0.55), location: 0.32),
                        .init(color: .clear, location: 0.62)
                    ], startPoint: .leading, endPoint: .trailing)
                }
                .id(it.id)                       // cross-fade on change
                .transition(.opacity)

            VStack(alignment: .leading, spacing: 18) {
                Text(it.title).font(.system(size: 68, weight: .bold)).shadow(radius: 12)
                    .lineLimit(2)
                HStack(spacing: 16) {
                    if let y = it.year { Chip(String(y)) }
                    if let r = it.rating, r > 0 { Chip(String(format: "★ %.1f", r)) }
                    if let b = it.badge { Chip(b) }
                }
                if let o = it.overview {
                    Text(o).font(.title3).foregroundStyle(.white.opacity(0.85))
                        .lineLimit(3).frame(maxWidth: 1100, alignment: .leading)
                }
                HStack(spacing: 24) {
                    Button { route.append(it.route) } label: {
                        Label("Play", systemImage: "play.fill").font(.headline).padding(.horizontal, 16)
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.accent)
                    Button { route.append(it.route) } label: {
                        Label("More Info", systemImage: "info.circle").font(.headline).padding(.horizontal, 12)
                    }
                    .buttonStyle(.bordered)
                }
                .padding(.top, 6)

                // Rotation dots.
                HStack(spacing: 12) {
                    ForEach(items.indices, id: \.self) { i in
                        Capsule()
                            .fill(i == idx ? Theme.accent : Color.white.opacity(0.35))
                            .frame(width: i == idx ? 34 : 14, height: 8)
                    }
                }
                .padding(.top, 10)
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.bottom, 56)
        }
        .onReceive(timer) { _ in
            guard items.count > 1 else { return }
            withAnimation(.easeInOut(duration: 0.6)) { idx = (idx + 1) % items.count }
        }
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

// Streaming providers — names, brand colors, and per-title deep links (web STREAM_PROVIDERS).
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
            Theme.bg.ignoresSafeArea()   // page bg == the hero's fade target, so no seam
            scroll
        }
    }

    private var scroll: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                // The wordmark rides at the top of the PAGE (over the hero art)
                // and scrolls away with it — it must not shadow the whole app.
                if !heroItems.isEmpty {
                    MarqueeHero(items: heroItems, route: $route)
                        .overlay(alignment: .topLeading) {
                            MarqueeWordmark()
                                .padding(.leading, Theme.gutter).padding(.top, 46)
                        }
                } else {
                    MarqueeWordmark()
                        .padding(.leading, Theme.gutter).padding(.top, 46)
                }

                if !continueItems.isEmpty {
                    MediaRow(title: "Continue Watching") {
                        ForEach(continueItems) { item in
                            ContinueCard(title: item.displayTitle, subtitle: item.subtitle,
                                         posterURL: item.poster, progress: item.progressFraction,
                                         action: {
                                             if item.kind == "movie" { route.append(.movie(item.id)) }
                                             else if let sid = item.showId { route.append(.show(sid)) }
                                         },
                                         onMarkWatched: {
                                             Task { await store.markContinueWatched(item) }
                                         })
                        }
                    }
                }

                ForEach(rows) { row in
                    MediaRow(title: row.title) {
                        ForEach(row.cards) { c in
                            PosterCard(title: c.title, posterURL: c.poster, subtitle: c.subtitle,
                                       progress: c.progress, badges: c.badges) { tap(c) }
                        }
                    }
                }
            }
            .padding(.bottom, Theme.gutter)
        }
        // Full-bleed: the hero art reaches every screen edge (no safe-area box);
        // row content keeps its gutter padding so posters aren't clipped.
        .ignoresSafeArea()
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
