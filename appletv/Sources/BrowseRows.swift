import Foundation

// ============================================================================
//  Browse rows — the tvOS mirror of public/app.js
// ============================================================================
//  Rows are DRAWN FROM A POOL rather than all emitted at once. A few pinned rows
//  stay put (Continue Watching lives in BrowsePage, then whatever is in season,
//  then Recently Added) and the rest of the page is a random selection out of
//  every candidate below that has enough titles to be worth drawing.
//
//  The pick is seeded per launch, so it holds still while you move between tabs
//  and deals a new hand next time the app opens — or after four hours, for an
//  Apple TV that never gets quit.
//
//  Keep this in step with `candidateRows` / `seasonalCalendar` in public/app.js.
//
//  ---- A NOTE ON COST, because the first cut of this froze the app ----
//
//  `Browse.rows` is called from a SwiftUI `body`, and body runs again on every
//  state change AND every focus move. The first version read `Movie.genreList`
//  inside each row's filter — and that property parses the genres JSON on every
//  access — and matched moods with `range(of:options:.regularExpression)`, which
//  compiles a fresh NSRegularExpression per call. Against a real library (1636
//  films, 334 shows) one call came to 86,358 JSON parses and 8,004 regex
//  compiles: about a second of main-thread work per render on Apple TV silicon.
//  The shell drew, the rows never arrived, and the remote did nothing.
//
//  So: every per-item cost is paid ONCE, in BrowseItem's initialiser (genres
//  parsed once, search text built once, the keyword moods decided once against
//  cached regexes), and the finished rows are memoised behind a stamp that
//  tracks the data they were built from. Rows are cheap predicate filters over
//  a class — a reference, so filtering doesn't copy a Movie's ten strings.
//  Adding a row that parses or compiles anything per item would undo all of it.
// ============================================================================

enum BrowseTab: Hashable { case home, movies, tv }

// Compiled once per pattern and kept. Everything here runs on the main thread
// (SwiftUI body), so a plain static dictionary is the right amount of machinery.
enum Rx {
    private static var cache: [String: NSRegularExpression] = [:]
    static func test(_ pattern: String, _ text: String) -> Bool {
        guard !text.isEmpty else { return false }
        let re: NSRegularExpression
        if let hit = cache[pattern] {
            re = hit
        } else {
            guard let made = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return false }
            cache[pattern] = made
            re = made
        }
        return re.firstMatch(in: text, options: [], range: NSRange(text.startIndex..., in: text)) != nil
    }
}

// Keyword moods. Decided once per title, in the initialiser below — never in a
// row's filter.
private enum MoodRx {
    static let trueStory = #"based on (a |the )?(true|real)|a true story|true events|real events|inspired by (a |the )?true"#
    static let space = #"\bspace\b|astronauts?\b|\borbit\b|\bmars\b|\bnasa\b|spaceship|space station|\bgalaxy\b|interstellar|moon landing|cosmonaut"#
    static let heist = #"\bheist\b|\brobbery\b|con (man|artist)|\bthieves\b|bank job|\bgrifter|\bswindle|\bcaper\b"#
    static let creature = #"\bmonsters?\b|\bcreature\b|\bsharks?\b|dinosaur|\bkaiju\b|\baliens?\b|\bbeast\b"#
}

// A row item is a movie OR a show, so one Home row can hold both — the tvOS
// stand-in for the web app's {x, kind} pairs. A CLASS, so the ~70 candidate rows
// filter references rather than copying a struct full of strings each time.
final class BrowseItem {
    let isMovie: Bool
    let key: String
    let title: String
    let year: Int
    let rating: Double
    let genres: Set<String>          // parsed once
    let searchText: String           // title + overview, built once
    let addedAt: Double
    let lastPlayedAt: Double
    let watched: Bool
    let favorite: Bool
    let is4K: Bool
    let unwatched: Int
    let localId: Int?
    let runtimeMinutes: Int
    let card: BrowseCard             // built once

    // The keyword moods, decided once rather than per render.
    let isTrueStory: Bool
    let isSpace: Bool
    let isHeist: Bool
    let isCreature: Bool

    init(movie m: Movie) {
        isMovie = true
        key = "m\(m.id)"
        title = m.title
        year = m.year ?? 0
        rating = m.rating ?? 0
        genres = Set(m.genreList)
        searchText = m.title + " " + (m.overview ?? "")
        addedAt = m.addedAt ?? 0
        lastPlayedAt = m.lastPlayedAt ?? 0
        watched = (m.watched ?? 0) == 1
        favorite = (m.favorite ?? 0) == 1
        is4K = m.is4K
        unwatched = 0
        localId = m.localId
        if let r = m.runtime, r > 0 { runtimeMinutes = r }
        else if let d = m.duration, d > 0 { runtimeMinutes = Int(d / 60) }
        else { runtimeMinutes = 0 }
        card = Browse.movieCard(m)
        isTrueStory = Rx.test(MoodRx.trueStory, searchText)
        isSpace = Rx.test(MoodRx.space, searchText)
        isHeist = Rx.test(MoodRx.heist, searchText)
        isCreature = genres.contains("Horror") && Rx.test(MoodRx.creature, searchText)
    }

    init(show s: Show) {
        isMovie = false
        key = "s\(s.id)"
        title = s.title
        year = s.year ?? 0
        rating = s.rating ?? 0
        genres = Set(s.genreList)
        searchText = s.title + " " + (s.overview ?? "")
        addedAt = s.addedAt ?? 0
        lastPlayedAt = s.lastPlayedAt ?? 0
        watched = false
        favorite = false
        is4K = false
        unwatched = s.unwatched ?? 0
        localId = s.localId
        runtimeMinutes = 0
        card = Browse.showCard(s)
        isTrueStory = Rx.test(MoodRx.trueStory, searchText)
        isSpace = Rx.test(MoodRx.space, searchText)
        isHeist = Rx.test(MoodRx.heist, searchText)
        isCreature = genres.contains("Horror") && Rx.test(MoodRx.creature, searchText)
    }

    func hasGenre(_ g: String) -> Bool { genres.contains(g) }
    func anyGenre(_ gs: [String]) -> Bool { gs.contains { genres.contains($0) } }
}

// ---------------------------------------------------------------------------
//  Rotation
// ---------------------------------------------------------------------------

struct SeededRNG {
    private var s: UInt32
    init(_ seed: UInt32) { s = seed == 0 ? 1 : seed }
    mutating func next() -> Double { s = s &* 1664525 &+ 1013904223; return Double(s) / 4294967296.0 }
}

enum RowRotation {
    /// Fixed for the life of the launch, so tabbing around doesn't reshuffle the
    /// page; XORed with a four-hour bucket so an app left running still moves on.
    private static let launch = UInt32.random(in: 0...UInt32.max)
    static var bucket: Int { Int(Date().timeIntervalSince1970 / 14400) }
    static func seed(_ tab: BrowseTab) -> UInt32 {
        let salt: UInt32 = tab == .home ? 0x9E3779B9 : (tab == .movies ? 0x85EBCA6B : 0xC2B2AE35)
        return launch ^ UInt32(truncatingIfNeeded: bucket) ^ salt
    }
}

func seededShuffle<T>(_ arr: [T], _ rng: inout SeededRNG) -> [T] {
    var a = arr
    guard a.count > 1 else { return a }
    for i in stride(from: a.count - 1, to: 0, by: -1) {
        let j = Int(rng.next() * Double(i + 1))
        a.swapAt(i, min(j, i))
    }
    return a
}

// ---------------------------------------------------------------------------
//  The seasonal calendar
// ---------------------------------------------------------------------------
//  Dated windows, not "it's month 9, here's some drama". A holiday row matches on
//  the title and the overview, so the week of the Fourth turns up Independence Day
//  and The Patriot; if the library hasn't got enough that genuinely fit, the row
//  doesn't run at all rather than padding itself out with a genre.
//
//  `on` is the day the occasion falls; `win` is how long the row runs for. Nobody
//  sits down to a holiday film ON the holiday, so every window opens a good week
//  or two ahead and closes the day after. When two overlap, the one whose day is
//  NEARER wins the slot (`rank` only breaks an exact tie).

struct SeasonalTheme {
    let id: String
    let rank: Int
    let on: (m: Int, d: Int)
    let name: String
    let win: (from: Int, to: Int)
    let min: Int
    var titleRe: String? = nil
    var textRe: String? = nil
    var genres: [String]? = nil
    var minRating: Double? = nil
    var pick: ((BrowseItem) -> Bool)? = nil

    // At most a couple of themes are ever live, and Rx keeps the compiled
    // pattern, so this is a plain scan rather than a compile per title.
    func matches(_ p: BrowseItem) -> Bool {
        if let pick { return pick(p) }
        if let minRating, p.rating < minRating { return false }
        if let genres, !p.anyGenre(genres) { return false }
        if titleRe != nil || textRe != nil {
            let hit = (titleRe.map { Rx.test($0, p.title) } ?? false)
                || (textRe.map { Rx.test($0, p.searchText) } ?? false)
            if !hit { return false }
        }
        return true
    }
}

enum Seasonal {
    static let cal: Calendar = Calendar(identifier: .gregorian)
    static func date(_ y: Int, _ m: Int, _ d: Int) -> Date {
        cal.date(from: DateComponents(year: y, month: m, day: d)) ?? Date()
    }
    static func dayKey(_ m: Int, _ d: Int) -> Int { m * 100 + d }
    static func dayKey(_ date: Date) -> Int {
        dayKey(cal.component(.month, from: date), cal.component(.day, from: date))
    }
    /// Day-of-month of the nth <dow> of a month (dow: 0 = Sunday).
    static func nthDow(_ y: Int, _ m: Int, _ dow: Int, _ n: Int) -> Int {
        let first = cal.component(.weekday, from: date(y, m, 1)) - 1
        return 1 + ((dow - first + 7) % 7) + (n - 1) * 7
    }
    static func lastDow(_ y: Int, _ m: Int, _ dow: Int) -> Int {
        let days = cal.range(of: .day, in: .month, for: date(y, m, 1))?.count ?? 28
        let w = cal.component(.weekday, from: date(y, m, days)) - 1
        return days - ((w - dow + 7) % 7)
    }
    /// Easter Sunday (anonymous Gregorian computus).
    static func easter(_ y: Int) -> (m: Int, d: Int) {
        let a = y % 19, b = y / 100, c = y % 100
        let d = b / 4, e = b % 4, f = (b + 8) / 25
        let g = (b - f + 1) / 3, h = (19 * a + b - d - g + 15) % 30
        let i = c / 4, k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
        let mm = (a + 11 * h + 22 * l) / 451
        return ((h + l - 7 * mm + 114) / 31, ((h + l - 7 * mm + 114) % 31) + 1)
    }
    /// A window opening `before` days ahead of a date and closing `after` days past it.
    static func span(_ y: Int, _ md: (m: Int, d: Int), _ before: Int, _ after: Int) -> (from: Int, to: Int) {
        let anchor = date(y, md.m, md.d)
        let a = cal.date(byAdding: .day, value: -before, to: anchor) ?? anchor
        let b = cal.date(byAdding: .day, value: after, to: anchor) ?? anchor
        return (dayKey(a), dayKey(b))
    }
    static func inWindow(_ from: Int, _ to: Int, _ k: Int) -> Bool {
        from <= to ? (k >= from && k <= to) : (k >= from || k <= to)
    }
    /// Whole days to a [month, day], the short way round the year, so Dec 28 is
    /// four days from New Year's rather than three hundred and sixty-one.
    static func daysUntil(_ md: (m: Int, d: Int), _ now: Date) -> Int {
        let today = cal.startOfDay(for: now)
        let y = cal.component(.year, from: now)
        return [y - 1, y, y + 1]
            .map { abs(cal.dateComponents([.day], from: today, to: date($0, md.m, md.d)).day ?? 9999) }
            .min() ?? 9999
    }

    static func calendar(_ y: Int) -> [SeasonalTheme] {
        let superBowl = (m: 2, d: nthDow(y, 2, 0, 2))    // 2nd Sunday in February
        let presidents = (m: 2, d: nthDow(y, 2, 1, 3))   // 3rd Monday in February
        let east = easter(y)
        let mothers = (m: 5, d: nthDow(y, 5, 0, 2))      // 2nd Sunday in May
        let memorial = (m: 5, d: lastDow(y, 5, 1))       // last Monday in May
        let fathers = (m: 6, d: nthDow(y, 6, 0, 3))      // 3rd Sunday in June
        let thanks = (m: 11, d: nthDow(y, 11, 4, 4))     // 4th Thursday in November
        func win(_ m1: Int, _ d1: Int, _ m2: Int, _ d2: Int) -> (from: Int, to: Int) {
            (dayKey(m1, d1), dayKey(m2, d2))
        }

        return [
            SeasonalTheme(id: "newyear", rank: 10, on: (1, 1), name: "🥂 Ring in the New Year",
                          win: win(12, 22, 1, 3), min: 3,
                          textRe: #"\bnew year'?s?\b|times square|hogmanay|auld lang syne|midnight kiss"#),

            SeasonalTheme(id: "superbowl", rank: 15, on: superBowl, name: "🏈 Big Game Weekend",
                          win: span(y, superBowl, 13, 1), min: 3,
                          textRe: #"\bfootball\b|quarterback|gridiron|touchdown|super bowl|friday night lights|\bnfl\b|linebacker|the blind side|remember the titans|\brudy\b|any given sunday|draft day|jerry maguire|the longest yard"#),

            SeasonalTheme(id: "valentine", rank: 10, on: (2, 14), name: "💘 Valentine's Night In",
                          win: win(2, 1, 2, 15), min: 4, genres: ["Romance"], minRating: 6),

            SeasonalTheme(id: "presidents", rank: 10, on: presidents, name: "🎩 Presidents Day",
                          win: span(y, presidents, 9, 1), min: 3,
                          textRe: #"\bpresident(ial)?\b|the white house|oval office|\blincoln\b|george washington|\bnixon\b|\bjfk\b|air force one|\bthe west wing\b|primary colors|all the president's men"#),

            SeasonalTheme(id: "stpat", rank: 10, on: (3, 17), name: "☘️ Luck of the Irish",
                          win: win(3, 4, 3, 18), min: 3,
                          textRe: #"\birish\b|\bireland\b|\bdublin\b|belfast|leprechaun|shamrock|\bceltic\b|boondock saints|the commitments|waking ned"#),

            SeasonalTheme(id: "easter", rank: 10, on: east, name: "🐣 Easter Weekend",
                          win: span(y, east, 14, 1), min: 3,
                          textRe: #"\beaster\b|resurrection|the passion of the christ|ten commandments|prince of egypt|\bben-?hur\b|\brisen\b|jesus christ|\bmoses\b|easter bunny|peter rabbit|\bpassover\b"#),

            SeasonalTheme(id: "earthday", rank: 20, on: (4, 22), name: "🌎 Earth Day",
                          win: win(4, 12, 4, 23), min: 3,
                          textRe: #"\bwildlife\b|rainforest|\bsafari\b|national park|conservation|endangered|\bclimate\b|the natural world|\bpenguins?\b|\bwhales?\b|planet earth|our planet"#),

            SeasonalTheme(id: "starwars", rank: 5, on: (5, 4), name: "🌌 May the Fourth",
                          win: win(4, 24, 5, 5), min: 3,
                          titleRe: #"star wars|\bjedi\b|\bsith\b|skywalker|rogue one|the mandalorian|\bandor\b|ahsoka|clone wars|empire strikes back|phantom menace|attack of the clones|revenge of the sith|force awakens|the last jedi|book of boba"#),

            SeasonalTheme(id: "cinco", rank: 20, on: (5, 5), name: "🌮 Cinco de Mayo",
                          win: win(4, 27, 5, 6), min: 3,
                          textRe: #"\bmexico\b|\bmexican\b|\boaxaca\b|guadalajara|day of the dead|dia de los muertos|luchador|mariachi|\bcartel\b|tijuana|\bcoco\b"#),

            SeasonalTheme(id: "mothers", rank: 10, on: mothers, name: "💐 Mother's Day",
                          win: span(y, mothers, 12, 1), min: 3,
                          textRe: #"\bmother(s|hood)?\b|\bmom\b|\bmoms\b|\bmama\b|\bmommy\b|\bmum\b"#),

            SeasonalTheme(id: "memorial", rank: 10, on: memorial, name: "🇺🇸 Memorial Day",
                          win: span(y, memorial, 12, 1), min: 4, genres: ["War"]),

            SeasonalTheme(id: "fathers", rank: 10, on: fathers, name: "🧢 Father's Day",
                          win: span(y, fathers, 12, 1), min: 3,
                          textRe: #"\bfather(s|hood)?\b|\bdad\b|\bdads\b|\bpapa\b|\bdaddy\b"#),

            SeasonalTheme(id: "july4", rank: 5, on: (7, 4), name: "🎆 Fourth of July",
                          win: win(6, 21, 7, 5), min: 3,
                          titleRe: #"independence day|the patriot\b|captain america|national treasure|born on the fourth of july|top gun|apollo 13|hidden figures|first man\b|saving private ryan|air force one|remember the titans|forrest gump|the sandlot|\bjaws\b|\bglory\b|rocky iv|the right stuff|\b1776\b|yankee doodle"#,
                          textRe: #"independence day|fourth of july|american revolution|founding fathers|declaration of independence|revolutionary war"#),

            SeasonalTheme(id: "school", rank: 20, on: (9, 1), name: "🎒 Back to School",
                          win: win(8, 15, 9, 20), min: 4,
                          textRe: #"high school|\bcollege\b|university|\bcampus\b|\bteacher\b|\bstudents?\b|\bprincipal\b|graduation|\bdorm\b|freshman|senior year|classroom|\bprom\b|boarding school|\bdetention\b|valedictorian"#),

            SeasonalTheme(id: "halloween", rank: 5, on: (10, 31), name: "🎃 Halloween Frights",
                          win: win(9, 21, 10, 31), min: 5, genres: ["Horror"]),

            SeasonalTheme(id: "notsospooky", rank: 12, on: (10, 31), name: "👻 Not-So-Spooky",
                          win: win(10, 1, 10, 31), min: 3,
                          pick: { p in
                              p.anyGenre(["Family", "Animation", "Fantasy", "Comedy"])
                                  && Rx.test(#"\bhalloween\b|\bghosts?\b|\bghostly\b|\bmonsters?\b|\bwitch(es)?\b|\bvampire|\bpumpkin|haunted|\bspooky\b|\bzombie|goosebumps|hocus pocus|addams|\bghouls?\b|coraline|\bcasper\b|trick or treat"#, p.searchText)
                          }),

            SeasonalTheme(id: "veterans", rank: 10, on: (11, 11), name: "🎖️ Veterans Day",
                          win: win(11, 1, 11, 12), min: 4, genres: ["War"]),

            SeasonalTheme(id: "thanksgiving", rank: 5, on: thanks, name: "🦃 Thanksgiving",
                          win: span(y, thanks, 13, 1), min: 3,
                          textRe: #"thanksgiving|\bturkey day\b|planes,? trains|home for the holidays|\bpilgrims?\b|\bplymouth\b|free birds|friendsgiving"#),

            SeasonalTheme(id: "christmas", rank: 5, on: (12, 25), name: "🎄 Christmas Movies",
                          win: win(11, 24, 12, 26), min: 3,
                          textRe: #"\bchristmas\b|\bxmas\b|santa claus|\bsanta\b|\bst\.? nick\b|father christmas|\belf\b|\bgrinch\b|scrooge|\bnoel\b|reindeer|\bnativity\b|north pole|home alone|die hard|it'?s a wonderful life|miracle on 34th|\bjingle\b|nutcracker|\byuletide\b|mistletoe|krampus|\bklaus\b|polar express|a christmas carol|a christmas story|\bgremlins\b|love actually"#)
        ]
    }

    /// What's in season today: at most two rows, nearest occasion first, and only
    /// the ones with enough real matches to fill a row. Most of the year: none.
    static func rows(_ pool: [BrowseItem], now: Date = Date()) -> [RowDef] {
        let k = dayKey(now)
        let live = calendar(cal.component(.year, from: now))
            .filter { inWindow($0.win.from, $0.win.to, k) }
            .sorted {
                let a = daysUntil($0.on, now), b = daysUntil($1.on, now)
                return a == b ? $0.rank < $1.rank : a < b
            }
        var out: [RowDef] = []
        for t in live {
            let items = pool.filter { t.matches($0) }
            if items.count < t.min { continue }
            out.append(RowDef(group: .seasonal, name: t.name, items: items, sort: RowSort.rating))
            if out.count == 2 { break }
        }
        return out
    }
}

// ---------------------------------------------------------------------------
//  The candidate pool
// ---------------------------------------------------------------------------

enum RowGroup: String { case seasonal, core, mood, discovery, genre, decade }

enum RowSort {
    static let rating: (BrowseItem, BrowseItem) -> Bool = { $0.rating > $1.rating }
    static let year: (BrowseItem, BrowseItem) -> Bool = { $0.year > $1.year }
    static let yearUp: (BrowseItem, BrowseItem) -> Bool = { $0.year < $1.year }
    static let added: (BrowseItem, BrowseItem) -> Bool = { $0.addedAt > $1.addedAt }
    static let played: (BrowseItem, BrowseItem) -> Bool = { $0.lastPlayedAt > $1.lastPlayedAt }
}

struct RowDef {
    let group: RowGroup
    let name: String
    let items: [BrowseItem]
    var sort: ((BrowseItem, BrowseItem) -> Bool)? = nil
    /// The genre this row leans on. A claimed genre blocks the plain genre row for
    /// it, so "Documentary" and "🎬 Documentaries" can never end up stacked.
    var topic: String? = nil

    var row: BrowseRow {
        let ordered = sort.map { items.sorted(by: $0) } ?? items
        return BrowseRow(id: group.rawValue + ":" + name, title: name,
                         cards: ordered.prefix(24).map { $0.card })
    }
}

extension Browse {
    static func items(_ tab: BrowseTab, _ movies: [Movie], _ shows: [Show]) -> [BrowseItem] {
        switch tab {
        case .movies: return movies.map { BrowseItem(movie: $0) }
        case .tv: return shows.map { BrowseItem(show: $0) }
        case .home: return movies.map { BrowseItem(movie: $0) } + shows.map { BrowseItem(show: $0) }
        }
    }

    /// How many of each kind make the page.
    static let quota: [(RowGroup, Int)] = [(.core, 4), (.mood, 5), (.discovery, 3), (.genre, 5), (.decade, 2)]

    static func candidates(_ tab: BrowseTab, _ pool: [BrowseItem], _ collections: [Collection],
                           _ rng: inout SeededRNG) -> [RowDef] {
        var rows: [RowDef] = []
        func add(_ group: RowGroup, _ name: String, _ items: [BrowseItem],
                 _ sort: ((BrowseItem, BrowseItem) -> Bool)? = nil, min: Int = 4, topic: String? = nil) {
            if items.count >= min { rows.append(RowDef(group: group, name: name, items: items, sort: sort, topic: topic)) }
        }
        let movieP = pool.filter { $0.isMovie }
        let showP = pool.filter { !$0.isMovie }
        let thisYear = Seasonal.cal.component(.year, from: Date())
        let weekAgo = Date().timeIntervalSince1970 * 1000 - 7 * 86_400_000

        // --- core: the staples ---
        add(.core, "Recommended", pool.filter { !$0.watched && $0.rating >= 7 }, RowSort.rating)
        add(.core, "Recently Released", pool, RowSort.year)
        add(.core, "Top Rated", pool, RowSort.rating)
        add(.core, "Critically Acclaimed", pool.filter { $0.rating >= 8 }, RowSort.rating)
        add(.core, "Fresh This Week", pool.filter { $0.addedAt > weekAgo }, RowSort.added, min: 3)
        add(.core, "Favorites", movieP.filter { $0.favorite }, RowSort.rating, min: 3)
        add(.core, tab == .home ? "Unwatched Movies" : "Unwatched", movieP.filter { !$0.watched }, RowSort.rating)
        add(.core, "Watch Again", movieP.filter { $0.watched }, RowSort.played, min: 3)
        add(.core, tab == .home ? "4K Movies" : "4K", movieP.filter { $0.is4K }, RowSort.rating, min: 3)
        add(.core, "New Episodes", showP.filter { $0.unwatched > 0 }, RowSort.added)
        add(.core, "Finish What You Started", showP.filter { $0.unwatched > 0 && $0.lastPlayedAt > 0 }, RowSort.played, min: 3)
        if tab == .home {
            add(.core, "Movies", movieP, RowSort.rating)
            add(.core, "TV Shows", showP, RowSort.rating)
        }

        // --- mood: cuts a genre name alone doesn't get you. Every predicate here
        // reads a precomputed field; none of them parse or compile anything.
        let moods: [(String, (BrowseItem) -> Bool, String?)] = [
            ("😄 Feel-Good Comedies", { $0.hasGenre("Comedy") && $0.rating >= 6.5 }, "Comedy"),
            ("😱 Edge of Your Seat", { $0.anyGenre(["Thriller", "Mystery"]) && $0.rating >= 6 }, "Thriller"),
            ("💞 Rom-Coms", { $0.hasGenre("Romance") && $0.hasGenre("Comedy") }, nil),
            ("🏡 Family Movie Night", { $0.hasGenre("Family") && $0.rating >= 6 }, "Family"),
            ("🎨 Animated", { $0.hasGenre("Animation") }, "Animation"),
            ("📖 Based on a True Story", { $0.isTrueStory }, nil),
            ("🚀 Into the Unknown", { $0.hasGenre("Science Fiction") && $0.rating >= 6 }, "Science Fiction"),
            ("🐉 Swords and Sorcery", { $0.hasGenre("Fantasy") }, "Fantasy"),
            ("🕵️ Crime and Capers", { $0.hasGenre("Crime") }, "Crime"),
            ("🎖️ War Stories", { $0.hasGenre("War") }, "War"),
            ("🤠 Westerns", { $0.hasGenre("Western") }, "Western"),
            ("🎬 Documentaries", { $0.hasGenre("Documentary") }, "Documentary"),
            ("🎵 Music and Musicals", { $0.hasGenre("Music") }, "Music"),
            ("💥 Big and Loud", { $0.anyGenre(["Action", "Adventure"]) && $0.rating >= 6.5 }, "Action"),
            ("🌌 Out in Space", { $0.isSpace }, nil),
            ("💰 Heists and Cons", { $0.isHeist }, nil),
            ("👹 Creature Features", { $0.isCreature }, nil),
            ("🧠 Slow Burns", { $0.hasGenre("Drama") && $0.runtimeMinutes >= 130 }, nil)
        ]
        for (name, test, topic) in moods { add(.mood, name, pool.filter(test), RowSort.rating, topic: topic) }

        // --- discovery: rows that only exist because of what's actually in here ---
        add(.discovery, "💎 Hidden Gems",
            pool.filter { $0.rating >= 7 && !$0.watched && $0.lastPlayedAt == 0 && $0.year > 0 && $0.year <= thisYear - 5 },
            RowSort.rating)
        add(.discovery, "⏱️ Short and Sweet", movieP.filter { $0.runtimeMinutes >= 40 && $0.runtimeMinutes <= 100 }, RowSort.rating)
        add(.discovery, "🍿 Settle In", movieP.filter { $0.runtimeMinutes >= 150 }, RowSort.rating)
        add(.discovery, "📼 From the Vault", pool.filter { $0.year > 0 && $0.year < 1980 }, RowSort.rating)
        add(.discovery, "⏪ Watched Lately", pool.filter { $0.lastPlayedAt > 0 }, RowSort.played, min: 3)
        add(.discovery, "🎲 Roll the Dice", Array(seededShuffle(pool, &rng).prefix(60)))

        // Because you watched — off one of the last few things actually played, so
        // it isn't the same suggestion every single time.
        let played = pool.filter { $0.lastPlayedAt > 0 }.sorted(by: RowSort.played).prefix(5)
        if let seed = seededShuffle(Array(played), &rng).first, !seed.genres.isEmpty {
            let gs = seed.genres
            add(.discovery, "Because you watched \(seed.title)",
                pool.filter { $0 !== seed && !$0.watched && !$0.genres.isDisjoint(with: gs) }, RowSort.rating)
        }

        // A year the library happens to be deep on.
        var byYear: [Int: [BrowseItem]] = [:]
        for p in pool where p.year > 0 { byYear[p.year, default: []].append(p) }
        if let year = seededShuffle(byYear.keys.filter { (byYear[$0]?.count ?? 0) >= 6 }.sorted(), &rng).first {
            add(.discovery, "The Year \(year)", byYear[year] ?? [], RowSort.rating)
        }

        // Franchises, straight off the same grouping the Collections tab uses.
        if tab != .tv {
            for c in seededShuffle(collections.filter { ($0.ids ?? []).count >= 3 }, &rng).prefix(3) {
                let ids = Set(c.ids ?? [])
                let name = c.name.hasSuffix(" Collection") ? String(c.name.dropLast(11)) : c.name
                add(.discovery, "🎞️ " + name,
                    movieP.filter { item in item.localId.map { ids.contains($0) } ?? false }, RowSort.yearUp, min: 3)
            }
        }

        // --- genres and decades: the long tail, sampled rather than dumped ---
        var genreCounts: [String: Int] = [:]
        for p in pool { for g in p.genres { genreCounts[g, default: 0] += 1 } }
        for (g, n) in genreCounts.sorted(by: { $0.key < $1.key }) where n >= 4 {
            add(.genre, g, pool.filter { $0.hasGenre(g) }, RowSort.rating, topic: g)
        }
        var decadeSet = Set<Int>()
        for p in pool where p.year > 0 { decadeSet.insert((p.year / 10) * 10) }
        for d in decadeSet.sorted(by: >) {
            add(.decade, "\(d)s", pool.filter { $0.year >= d && $0.year < d + 10 }, RowSort.year)
        }
        return rows
    }

    /// One pass over the shuffled pool. Filling the quotas this way rather than
    /// group by group means a row skipped for claiming a shelf that's already taken
    /// gets topped up by the next candidate, instead of costing the page a row.
    static func chooseRows(_ tab: BrowseTab, _ pool: [BrowseItem], _ collections: [Collection],
                           _ rng: inout SeededRNG) -> [RowDef] {
        var need = Dictionary(uniqueKeysWithValues: quota.map { ($0.0, $0.1) })
        var claimed = Set<String>()
        var out: [RowDef] = []
        let all = candidates(tab, pool, collections, &rng)
        for r in seededShuffle(all, &rng) {
            guard let left = need[r.group], left > 0 else { continue }
            if let t = r.topic, claimed.contains(t) { continue }
            if let t = r.topic { claimed.insert(t) }
            need[r.group] = left - 1
            out.append(r)
        }
        // One staple opens the block so the page doesn't start on "1970s". It's a
        // straight shuffle from there.
        if let lead = out.first(where: { $0.group == .core }) {
            return [lead] + out.filter { $0.name != lead.name }
        }
        return out
    }

    // ---- The memo ----
    // body calls rows() on every state change AND every focus move, so the page
    // is built once per (tab, data, rotation) and handed back after that. The
    // stamp walks the library once reading four cheap fields, which is the part
    // that has to stay honest: it must change whenever anything a row sorts or
    // filters on changes, or the page goes stale after you mark something watched.
    private static var cache: [BrowseTab: (stamp: String, rows: [BrowseRow])] = [:]

    static func stamp(_ tab: BrowseTab, _ movies: [Movie], _ shows: [Show], _ collections: [Collection]) -> String {
        var watched = 0, favorite = 0, unwatched = 0
        var played = 0.0, added = 0.0
        for m in movies {
            watched &+= (m.watched ?? 0); favorite &+= (m.favorite ?? 0)
            played += m.lastPlayedAt ?? 0; added += m.addedAt ?? 0
        }
        for s in shows {
            unwatched &+= (s.unwatched ?? 0)
            played += s.lastPlayedAt ?? 0; added += s.addedAt ?? 0
        }
        return "\(tab)|\(movies.count)|\(shows.count)|\(collections.count)|\(watched)|\(favorite)|\(unwatched)|\(played)|\(added)|\(RowRotation.bucket)"
    }

    /// The whole page for a tab: what's in season, what just landed, then the hand.
    static func rows(_ tab: BrowseTab, movies: [Movie], shows: [Show], collections: [Collection]) -> [BrowseRow] {
        let key = stamp(tab, movies, shows, collections)
        if let hit = cache[tab], hit.stamp == key { return hit.rows }

        let pool = items(tab, movies, shows)
        guard !pool.isEmpty else { return [] }
        var rng = SeededRNG(RowRotation.seed(tab))
        let pinned = Seasonal.rows(pool)
            + [RowDef(group: .core, name: "Recently Added", items: pool, sort: RowSort.added)]
        var seen = Set<String>()
        var out: [BrowseRow] = []
        for r in pinned + chooseRows(tab, pool, collections, &rng) {
            let name = r.name.lowercased().filter { $0.isLetter || $0.isNumber }
            if seen.contains(name) { continue }
            seen.insert(name)
            out.append(r.row)
        }
        cache[tab] = (key, out)
        return out
    }
}
