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
        let it = items[safe: idx] ?? items[0]
        ZStack(alignment: .bottomLeading) {
            ArtImage(url: it.backdrop, aspect: 16.0 / 9.0)
                .frame(height: 760).frame(maxWidth: .infinity).clipped()
                .overlay {
                    LinearGradient(colors: [.clear, Theme.bg.opacity(0.5), Theme.bg],
                                   startPoint: .top, endPoint: .bottom)
                }
                .overlay {
                    LinearGradient(colors: [Theme.bg.opacity(0.7), .clear],
                                   startPoint: .leading, endPoint: .trailing)
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
    let route: Route
}
struct BrowseRow: Identifiable {
    let id: String
    let title: String
    let cards: [BrowseCard]
}

// A hero + Continue Watching + generated rows. Home/Movies/TV all use this.
struct BrowseScreen: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]
    let heroItems: [HeroItem]
    let rows: [BrowseRow]
    let continueKind: String?     // "movie" | "episode" | nil (both)

    private var continueItems: [ContinueItem] {
        guard let k = continueKind else { return store.continueItems }
        return store.continueItems.filter { $0.kind == k }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                if !heroItems.isEmpty { MarqueeHero(items: heroItems, route: $route) }

                if !continueItems.isEmpty {
                    MediaRow(title: "Continue Watching") {
                        ForEach(continueItems) { item in
                            ContinueCard(title: item.title, subtitle: item.subtitle,
                                         posterURL: item.poster, progress: item.progressFraction) {
                                if item.kind == "movie" { route.append(.movie(item.id)) }
                                else if let sid = item.showId { route.append(.show(sid)) }
                            }
                        }
                    }
                }

                ForEach(rows) { row in
                    MediaRow(title: row.title) {
                        ForEach(row.cards) { c in
                            PosterCard(title: c.title, posterURL: c.poster, subtitle: c.subtitle,
                                       progress: c.progress) { route.append(c.route) }
                        }
                    }
                }
            }
            .padding(.bottom, Theme.gutter)
        }
        .ignoresSafeArea(edges: .top)
    }
}

// ---- Row/hero builders (mirror the web app's view() row set) ----
enum Browse {
    static func movieCard(_ m: Movie) -> BrowseCard {
        BrowseCard(id: "m\(m.id)", title: m.title, poster: m.poster,
                   subtitle: m.year.map(String.init), progress: m.progressFraction, route: .movie(m.id))
    }
    static func showCard(_ s: Show) -> BrowseCard {
        BrowseCard(id: "s\(s.id)", title: s.title, poster: s.poster,
                   subtitle: s.year.map(String.init), progress: 0, route: .show(s.id))
    }

    static func heroFromMovies(_ movies: [Movie]) -> [HeroItem] {
        weeklyPick(movies.filter { $0.backdrop != nil }, 6).map {
            HeroItem(id: "m\($0.id)", title: $0.title, backdrop: $0.backdrop, year: $0.year,
                     rating: $0.rating, badge: $0.bestQuality, overview: $0.overview, route: .movie($0.id))
        }
    }
    static func heroFromShows(_ shows: [Show]) -> [HeroItem] {
        weeklyPick(shows.filter { $0.backdrop != nil }, 6).map {
            HeroItem(id: "s\($0.id)", title: $0.title, backdrop: $0.backdrop, year: $0.year,
                     rating: $0.rating, badge: $0.episodes.map { "\($0) episodes" }, overview: $0.overview, route: .show($0.id))
        }
    }
    static func heroMixed(_ movies: [Movie], _ shows: [Show]) -> [HeroItem] {
        let m = movies.filter { $0.backdrop != nil }.map { HeroItem(id: "m\($0.id)", title: $0.title, backdrop: $0.backdrop, year: $0.year, rating: $0.rating, badge: $0.bestQuality, overview: $0.overview, route: .movie($0.id)) }
        let s = shows.filter { $0.backdrop != nil }.map { HeroItem(id: "s\($0.id)", title: $0.title, backdrop: $0.backdrop, year: $0.year, rating: $0.rating, badge: $0.episodes.map { "\($0) eps" }, overview: $0.overview, route: .show($0.id)) }
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

    static func homeRows(_ movies: [Movie], _ shows: [Show]) -> [BrowseRow] {
        var rows: [BrowseRow] = []
        func addM(_ id: String, _ t: String, _ list: [Movie]) {
            if !list.isEmpty { rows.append(BrowseRow(id: id, title: t, cards: list.prefix(24).map(movieCard))) }
        }
        func addS(_ id: String, _ t: String, _ list: [Show]) {
            if !list.isEmpty { rows.append(BrowseRow(id: id, title: t, cards: list.prefix(24).map(showCard))) }
        }
        addM("recent", "Recently Added", movies.sorted { ($0.addedAt ?? 0) > ($1.addedAt ?? 0) })
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

extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
