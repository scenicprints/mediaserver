import Foundation

// ---- API models (the same /api/* JSON the web UI consumes) ----
// Posters/backdrops are full https://image.tmdb.org URLs, so AsyncImage loads
// them directly. snake_case -> camelCase via .convertFromSnakeCase.
struct Movie: Identifiable, Decodable, Hashable {
    // Local movies have an Int id; streaming-only titles have a String id like
    // "stream:movie:1234" — so decode either and keep it as a String.
    let id: String
    let title: String
    let year: Int?
    let poster: String?
    let backdrop: String?
    let overview: String?
    let rating: Double?
    let genres: String?          // JSON array string, e.g. ["Action","Sci-Fi"]
    let watched: Int?
    let favorite: Int?
    let resumePosition: Double?
    let duration: Double?
    let runtime: Int?
    let versions: Int?
    let addedAt: Double?
    let qualities: String?
    let source: String?          // "stream" for streaming-only titles
    let providers: [String]?     // streaming provider slugs (stream titles)
    let alsoOn: [String]?        // owned title that's also on these services

    enum CodingKeys: String, CodingKey {
        case id, title, year, poster, backdrop, overview, rating, genres, watched, favorite
        case resumePosition, duration, runtime, versions, addedAt, qualities, source, providers, alsoOn
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        if let i = try? c.decode(Int.self, forKey: .id) { id = String(i) }
        else { id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString }
        title = (try? c.decode(String.self, forKey: .title)) ?? "—"
        year = try? c.decode(Int.self, forKey: .year)
        poster = try? c.decode(String.self, forKey: .poster)
        backdrop = try? c.decode(String.self, forKey: .backdrop)
        overview = try? c.decode(String.self, forKey: .overview)
        rating = try? c.decode(Double.self, forKey: .rating)
        genres = try? c.decode(String.self, forKey: .genres)
        watched = try? c.decode(Int.self, forKey: .watched)
        favorite = try? c.decode(Int.self, forKey: .favorite)
        resumePosition = try? c.decode(Double.self, forKey: .resumePosition)
        duration = try? c.decode(Double.self, forKey: .duration)
        runtime = try? c.decode(Int.self, forKey: .runtime)
        versions = try? c.decode(Int.self, forKey: .versions)
        addedAt = try? c.decode(Double.self, forKey: .addedAt)
        qualities = try? c.decode(String.self, forKey: .qualities)
        source = try? c.decode(String.self, forKey: .source)
        providers = try? c.decode([String].self, forKey: .providers)
        alsoOn = try? c.decode([String].self, forKey: .alsoOn)
    }

    var localId: Int? { Int(id) }
    var isStream: Bool { source == "stream" }
    var progressFraction: Double {
        guard let d = duration, d > 0, let p = resumePosition else { return 0 }
        return min(max(p / d, 0), 1)
    }
    var genreList: [String] { Store.parseJSONStrings(genres) }
    var isNew: Bool { Store.isRecent(addedAt) }
    var is4K: Bool { (qualities ?? "").localizedCaseInsensitiveContains("4K") }
    var bestQuality: String? {
        (qualities ?? "").split(separator: ",").map(String.init).sorted().last
    }
}

// A row from /api/continue — either a movie or a show episode.
struct ContinueItem: Identifiable, Decodable, Hashable {
    let kind: String
    let id: Int
    let title: String
    let showTitle: String?       // the show's name (episode rows)
    let poster: String?
    let resumePosition: Double?
    let duration: Double?
    let lastPlayedAt: Double?
    let showId: Int?
    let season: Int?
    let episode: Int?

    // movie ids and episode ids can collide, so key on kind+id.
    var uid: String { "\(kind)-\(id)" }
    var progressFraction: Double {
        guard let d = duration, d > 0, let p = resumePosition else { return 0 }
        return min(max(p / d, 0), 1)
    }
    // Card title/sub match the web continueCards(): the SHOW's name headlines an
    // episode; the sub carries S1·E01 (or "Movie").
    var displayTitle: String { kind == "episode" ? (showTitle ?? title) : title }
    var subtitle: String? {
        guard kind == "episode", let s = season, let e = episode else { return "Movie" }
        return String(format: "S%d·E%02d", s, e)
    }
}

struct Show: Identifiable, Decodable, Hashable {
    let id: String
    let title: String
    let year: Int?
    let poster: String?
    let backdrop: String?
    let overview: String?
    let rating: Double?
    let episodes: Int?
    let unwatched: Int?
    let genres: String?
    let addedAt: Double?
    let source: String?
    let providers: [String]?
    let alsoOn: [String]?

    enum CodingKeys: String, CodingKey {
        case id, title, year, poster, backdrop, overview, rating, episodes, unwatched
        case genres, addedAt, source, providers, alsoOn
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        if let i = try? c.decode(Int.self, forKey: .id) { id = String(i) }
        else { id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString }
        title = (try? c.decode(String.self, forKey: .title)) ?? "—"
        year = try? c.decode(Int.self, forKey: .year)
        poster = try? c.decode(String.self, forKey: .poster)
        backdrop = try? c.decode(String.self, forKey: .backdrop)
        overview = try? c.decode(String.self, forKey: .overview)
        rating = try? c.decode(Double.self, forKey: .rating)
        episodes = try? c.decode(Int.self, forKey: .episodes)
        unwatched = try? c.decode(Int.self, forKey: .unwatched)
        genres = try? c.decode(String.self, forKey: .genres)
        addedAt = try? c.decode(Double.self, forKey: .addedAt)
        source = try? c.decode(String.self, forKey: .source)
        providers = try? c.decode([String].self, forKey: .providers)
        alsoOn = try? c.decode([String].self, forKey: .alsoOn)
    }

    var localId: Int? { Int(id) }
    var isStream: Bool { source == "stream" }
    var genreList: [String] { Store.parseJSONStrings(genres) }
    var isNew: Bool { Store.isRecent(addedAt) }
}

struct Collection: Identifiable, Decodable, Hashable {
    // TMDB collections have numeric ids; curated meta collections use string ids
    // like "meta:mcu" — decode either (a plain `String` decoder rejects the
    // numeric ones and silently empties the whole Collections tab).
    let id: String
    let name: String
    let count: Int?
    let poster: String?
    let backdrop: String?

    enum CodingKeys: String, CodingKey { case id, name, count, poster, backdrop }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        if let i = try? c.decode(Int.self, forKey: .id) { id = String(i) }
        else { id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString }
        name = (try? c.decode(String.self, forKey: .name)) ?? "Collection"
        count = try? c.decode(Int.self, forKey: .count)
        poster = try? c.decode(String.self, forKey: .poster)
        backdrop = try? c.decode(String.self, forKey: .backdrop)
    }
}

// ---- Playback: /api/movies/:id returns the logical movie + its files ----
struct MovieFile: Identifiable, Decodable, Hashable {
    let id: Int
    let quality: String?
    let filename: String?
    let size: Double?

    // Human-readable size for the version picker (e.g. "18.4 GB", "720 MB").
    var sizeText: String? {
        guard let b = size, b > 0 else { return nil }
        let gb = b / 1_000_000_000
        if gb >= 1 { return String(format: "%.1f GB", gb) }
        let mb = b / 1_000_000
        return String(format: "%.0f MB", mb)
    }
}
struct MovieDetail: Decodable {
    let id: Int
    let title: String
    let year: Int?
    let poster: String?
    let backdrop: String?
    let overview: String?
    let rating: Double?
    let runtime: Int?
    let duration: Double?
    let genres: String?
    let watched: Int?
    let favorite: Int?
    let resumePosition: Double?
    let files: [MovieFile]

    var genreList: [String] { Store.parseJSONStrings(genres) }
    var bestFile: MovieFile? { files.first }   // server sorts highest quality first
}

// ---- TV: /api/shows/:id returns the show + seasons -> episodes -> files ----
struct Episode: Identifiable, Decodable, Hashable {
    let id: Int
    let season: Int?
    let episode: Int?
    let title: String?
    let overview: String?
    let still: String?
    let duration: Double?
    let resumePosition: Double?
    let watched: Int?
    let files: [MovieFile]

    var bestFile: MovieFile? { files.first }
    var displayTitle: String { title ?? "Episode \(episode ?? 0)" }
    var tag: String { "S\(season ?? 0) · E\(episode ?? 0)" }
    var progressFraction: Double {
        guard let d = duration, d > 0, let p = resumePosition else { return 0 }
        return min(max(p / d, 0), 1)
    }
}
struct Season: Decodable, Hashable {
    let season: Int
    let episodes: [Episode]
}
struct ShowDetail: Decodable {
    let id: Int
    let title: String
    let year: Int?
    let poster: String?
    let backdrop: String?
    let overview: String?
    let rating: Double?
    let genres: String?
    let seasons: [Season]

    var genreList: [String] { Store.parseJSONStrings(genres) }
}

// ---- /api/shows/:id/extra : season posters + cast ----
struct SeasonMeta: Decodable, Hashable { let season: Int; let poster: String? }
struct ShowExtra: Decodable { let seasons: [SeasonMeta]?; let cast: [CastMember]? }

// ---- /api/episodes/:id/extra : rich single-episode detail (matches web) ----
struct EpisodePerson: Decodable, Hashable { let name: String; let role: String?; let profile: String? }
struct EpisodeExtra: Decodable {
    let still: String?
    let overview: String?
    let airDate: String?
    let rating: Double?
    let runtime: Int?
    let people: [EpisodePerson]?
}

// ---- /api/collections/:id : the collection's owned movies, in order ----
struct CollectionDetail: Decodable {
    let name: String?
    let poster: String?
    let backdrop: String?
    let items: [Movie]
}

// ---- Requests: /api/requests/search results (Radarr/Sonarr) ----
struct RequestResult: Identifiable, Decodable, Hashable {
    let type: String        // "movie" | "tv"
    let tmdbId: Int?
    let tvdbId: Int?
    let title: String
    let year: Int?
    let overview: String?
    let poster: String?
    var id: String { "\(type)-\(tmdbId ?? tvdbId ?? title.hashValue)" }
}
struct ArrProfile: Decodable, Hashable { let id: Int; let name: String? }
// /api/requests/profiles returns { radarr: { profiles, default }, sonarr: {…} }
// (NOT bare arrays — decoding it as an array silently yielded no profiles, so
// the quality picker never appeared).
struct ArrProfiles: Decodable, Hashable { let profiles: [ArrProfile]?; let `default`: Int? }
struct ProfilesResponse: Decodable { let radarr: ArrProfiles?; let sonarr: ArrProfiles? }

// ---- /api/movies/:id/extra : rich TMDB metadata ----
struct CastMember: Decodable, Hashable { let name: String; let character: String?; let profile: String? }
struct RecItem: Decodable, Hashable { let title: String; let year: Int?; let poster: String?; let localId: Int? }
struct Trailer: Decodable, Hashable { let key: String; let name: String? }
struct MovieExtra: Decodable {
    let runtime: Int?
    let tagline: String?
    let genres: [String]?
    let cast: [CastMember]?
    let directors: [String]?
    let recommendations: [RecItem]?
    let trailer: Trailer?
}

// ---- Settings models ----
struct UserRow: Identifiable, Decodable, Hashable { let id: Int; let username: String; let role: String }
struct Provider: Decodable, Hashable, Identifiable { let id: String; let name: String; let color: String? }
struct ProvidersResponse: Decodable { let providers: [Provider]; let enabled: [String]; let local: Bool }
struct EngineStatus: Decodable { let ready: Bool?; let installing: Bool?; let installed: Bool?; let version: String? }
struct AdminSession: Identifiable, Decodable, Hashable {
    let sessionId: String?
    let username: String?
    let title: String?
    let subtitle: String?
    let mode: String?
    let position: Double?
    let duration: Double?
    let paused: Bool?
    var id: String { sessionId ?? "\(username ?? "")-\(title ?? "")" }
}
struct SessionsResponse: Decodable { let sessions: [AdminSession] }

// One playable episode for Live TV (/api/livetv/episodes).
struct LiveEpisode: Decodable, Hashable {
    let epId: Int
    let showId: Int
    let season: Int?
    let episode: Int?
    let epTitle: String?
    let still: String?
    let duration: Double?
    let showTitle: String?
    let poster: String?
    let backdrop: String?
    let overview: String?
    let genres: String?
    let year: Int?
    let rating: Double?
}

struct User: Decodable { let username: String; let role: String }
private struct LoginResponse: Decodable { let token: String; let user: User }
private struct MeResponse: Decodable { let user: User }

@MainActor
final class Store: ObservableObject {
    // The server's public HTTPS address (via Caddy/DuckDNS). Overridable in Settings.
    static let defaultServer = "https://marqu33.duckdns.org"

    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    @Published var token: String? {
        didSet {
            if let t = token { UserDefaults.standard.set(t, forKey: "authToken") }
            else { UserDefaults.standard.removeObject(forKey: "authToken") }
        }
    }
    @Published var user: User?

    // Home-screen data (built from several endpoints, like the web home view).
    @Published var movies: [Movie] = []
    @Published var continueItems: [ContinueItem] = []
    @Published var shows: [Show] = []
    @Published var collections: [Collection] = []

    @Published var error: String?
    @Published var loading = false

    // Per-device audio prefs (depend on THIS TV's speakers — like the web app's
    // localStorage). Appended to stream URLs so the server mixes accordingly.
    @Published var audioMode: String { didSet { UserDefaults.standard.set(audioMode, forKey: "audioMode") } }
    @Published var dboost: String { didSet { UserDefaults.standard.set(dboost, forKey: "dboost") } }
    @Published var night: Bool { didSet { UserDefaults.standard.set(night, forKey: "night") } }
    @Published var norm: Bool { didSet { UserDefaults.standard.set(norm, forKey: "norm") } }

    var previewMode = false   // CI screenshot mode: keep the session alive
    var isLoggedIn: Bool { previewMode || token != nil }
    var isAdmin: Bool { user?.role == "admin" }

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? Store.defaultServer
        token = UserDefaults.standard.string(forKey: "authToken")
        audioMode = UserDefaults.standard.string(forKey: "audioMode") ?? "stereo"
        dboost = UserDefaults.standard.string(forKey: "dboost") ?? "normal"
        night = UserDefaults.standard.bool(forKey: "night")
        norm = UserDefaults.standard.bool(forKey: "norm")
    }

    // ---- CI preview: populate sample data straight from TMDB (public CDN), so
    // the screenshot workflow can render real screens even when the media server
    // is offline/unreachable. Preview-only; never used in normal operation. ----
    private static let tmdbGenres: [Int: String] = [
        28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
        99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
        27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Science Fiction",
        53: "Thriller", 10752: "War", 37: "Western", 10759: "Action", 10762: "Kids",
        10765: "Science Fiction", 10768: "War"
    ]
    func loadPreviewMock(tmdbKey: String) async {
        previewMode = true
        token = "preview"
        user = User(username: "kevin", role: "admin")
        func names(_ ids: [Int]) -> String {
            let g = ids.compactMap { Store.tmdbGenres[$0] }
            return (try? String(data: JSONSerialization.data(withJSONObject: g), encoding: .utf8) ?? "[]") ?? "[]"
        }
        func img(_ path: Any?, _ size: String) -> String? {
            guard let p = path as? String else { return nil }
            return "https://image.tmdb.org/t/p/\(size)\(p)"
        }
        func fetch(_ url: String) async -> [[String: Any]] {
            guard let u = URL(string: url), let (d, _) = try? await URLSession.shared.data(from: u),
                  let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let r = j["results"] as? [[String: Any]] else { return [] }
            return r
        }
        let now = Date().timeIntervalSince1970 * 1000
        // Movies
        var mDicts: [[String: Any]] = []
        for (i, m) in (await fetch("https://api.themoviedb.org/3/movie/popular?api_key=\(tmdbKey)&page=1")).enumerated() {
            let year = (m["release_date"] as? String)?.prefix(4)
            mDicts.append([
                "id": m["id"] as? Int ?? i, "title": m["title"] as? String ?? "—",
                "year": year.flatMap { Int($0) } as Any, "poster": img(m["poster_path"], "w500") as Any,
                "backdrop": img(m["backdrop_path"], "w1280") as Any, "overview": m["overview"] as? String as Any,
                "rating": m["vote_average"] as? Double as Any, "genres": names(m["genre_ids"] as? [Int] ?? []),
                "added_at": (i < 6 ? now : now - 40 * 24 * 3600 * 1000), "versions": (i % 3 == 0 ? 2 : 1),
                "qualities": (i % 4 == 0 ? "4K,1080p" : "1080p"), "watched": 0, "favorite": (i % 5 == 0 ? 1 : 0),
                "resume_position": (i == 1 ? 1800 : 0), "duration": 6600, "runtime": 110
            ])
        }
        // Shows
        var sDicts: [[String: Any]] = []
        for (i, s) in (await fetch("https://api.themoviedb.org/3/tv/popular?api_key=\(tmdbKey)&page=1")).enumerated() {
            let year = (s["first_air_date"] as? String)?.prefix(4)
            sDicts.append([
                "id": s["id"] as? Int ?? i, "title": s["name"] as? String ?? "—",
                "year": year.flatMap { Int($0) } as Any, "poster": img(s["poster_path"], "w500") as Any,
                "backdrop": img(s["backdrop_path"], "w1280") as Any, "overview": s["overview"] as? String as Any,
                "rating": s["vote_average"] as? Double as Any, "genres": names(s["genre_ids"] as? [Int] ?? []),
                "added_at": (i < 5 ? now : now - 40 * 24 * 3600 * 1000), "episodes": 10 + i, "unwatched": (i % 3)
            ])
        }
        let dec = decoder()
        if let d = try? JSONSerialization.data(withJSONObject: mDicts) { movies = (try? dec.decode([Movie].self, from: d)) ?? [] }
        if let d = try? JSONSerialization.data(withJSONObject: sDicts) { shows = (try? dec.decode([Show].self, from: d)) ?? [] }
    }

    // Query string the server uses to mix audio for this device.
    func audioQuery() -> String {
        var q = "audio=\(audioMode == "surround" ? "surround" : "stereo")"
        if dboost != "normal" { q += "&dboost=\(dboost)" }
        if night { q += "&night=1" }
        if norm { q += "&norm=1" }
        return q
    }

    private func decoder() -> JSONDecoder {
        let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase; return d
    }

    // Crash forensics: fire-and-forget a one-line breadcrumb to the server
    // (POST /api/clientlog). Used around risky sequences (the HDR display-mode
    // switch) so if the app dies, the server's log shows the exact last step.
    func crumb(_ step: String) {
        Task { _ = try? await request("api/clientlog", method: "POST", body: ["step": step]) }
    }
    // Awaited variant for crash forensics around a risky statement: the POST is
    // on the server BEFORE the caller's next line runs, so if that line kills
    // the app, the log's last entry names it unambiguously. (~10ms on LAN.)
    func crumbSync(_ step: String) async {
        _ = try? await request("api/clientlog", method: "POST", body: ["step": step])
    }

    // Added within the last 14 days → "NEW" (web isNew). addedAt is ms epoch.
    nonisolated static func isRecent(_ addedAt: Double?) -> Bool {
        guard let a = addedAt else { return false }
        return Date().timeIntervalSince1970 * 1000 - a < 14 * 24 * 3600 * 1000
    }

    nonisolated static func parseJSONStrings(_ s: String?) -> [String] {
        guard let s, let data = s.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [String] else { return [] }
        return arr
    }

    // The server accepts the session token as an Authorization: Bearer header
    // (also as a cookie or ?token=), so a native client just attaches it here.
    private func request(_ path: String, method: String = "GET",
                         body: [String: Any]? = nil, auth: Bool = true) async throws -> (Data, HTTPURLResponse) {
        guard let base = URL(string: serverURL.trimmingCharacters(in: .whitespaces)),
              let url = URL(string: path, relativeTo: base) else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let body = body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        if auth, let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }

    private func get<T: Decodable>(_ path: String, as: T.Type) async -> T? {
        do {
            let (data, http) = try await request(path)
            if http.statusCode == 401 { token = nil; user = nil; return nil }
            guard (200..<300).contains(http.statusCode) else { return nil }
            return try decoder().decode(T.self, from: data)
        } catch { return nil }
    }

    // ---- Auth ----
    func login(username: String, password: String) async {
        await authenticate(path: "api/login", body: ["username": username, "password": password])
    }
    func register(username: String, password: String, code: String) async {
        await authenticate(path: "api/register", body: ["username": username, "password": password, "code": code])
    }
    private func authenticate(path: String, body: [String: Any]) async {
        loading = true; error = nil
        defer { loading = false }
        do {
            let (data, http) = try await request(path, method: "POST", body: body, auth: false)
            guard (200..<300).contains(http.statusCode) else {
                error = serverError(data) ?? "Couldn't sign in (\(http.statusCode))."
                return
            }
            let res = try decoder().decode(LoginResponse.self, from: data)
            token = res.token
            user = res.user
            await loadHome()
        } catch {
            self.error = "Couldn't reach the server. Check the address in Settings."
        }
    }
    func checkSession() async {
        guard token != nil else { return }
        do {
            let (data, http) = try await request("api/me")
            if http.statusCode == 401 { token = nil; user = nil; return }
            user = try decoder().decode(MeResponse.self, from: data).user
            await loadHome()
        } catch { /* offline — keep the stored token, retry later */ }
    }
    func logout() {
        let old = token
        token = nil; user = nil
        movies = []; continueItems = []; shows = []; collections = []
        if old != nil { Task { _ = try? await request("api/logout", method: "POST") } }
    }

    // ---- Data loading ----
    // Screens call this on appear so watch state stays fresh (Continue Watching
    // updates, watched titles drop out) without hammering the server.
    private var lastHomeLoad = Date.distantPast
    func refreshHome() async {
        guard !previewMode else { return }   // never clobber the CI mock data
        guard Date().timeIntervalSince(lastHomeLoad) > 15 else { return }
        await loadHome()
    }

    func loadHome() async {
        lastHomeLoad = Date()
        loading = true; error = nil
        defer { loading = false }
        async let m: [Movie]? = get("api/movies", as: [Movie].self)
        async let c: [ContinueItem]? = get("api/continue", as: [ContinueItem].self)
        async let s: [Show]? = get("api/shows", as: [Show].self)
        async let col: [Collection]? = get("api/collections", as: [Collection].self)
        let (mv, cont, sh, cols) = await (m, c, s, col)
        if let mv { movies = mv }
        if let cont { continueItems = cont }
        if let sh { shows = sh }
        if let cols { collections = cols }
        if mv == nil && movies.isEmpty { error = "Couldn't reach the server. Check the address in Settings." }
    }

    func loadMovies() async {
        if let mv = await get("api/movies", as: [Movie].self) { movies = mv }
    }

    func movieDetail(_ id: Int) async -> MovieDetail? {
        await get("api/movies/\(id)", as: MovieDetail.self)
    }
    func showDetail(_ id: Int) async -> ShowDetail? {
        if previewMode { return previewShowDetail(id) }
        return await get("api/shows/\(id)", as: ShowDetail.self)
    }
    // A mock show detail (3 seasons) so the CI preview can screenshot the
    // seasons/episodes layout with the server offline.
    private func previewShowDetail(_ id: Int) -> ShowDetail? {
        guard let s = shows.first(where: { $0.localId == id }) ?? shows.first else { return nil }
        var seasons: [Season] = []
        for sn in 1...3 {
            let eps = (1...8).map { e in
                Episode(id: sn * 100 + e, season: sn, episode: e,
                        title: "Episode \(e)", overview: "A sample episode synopsis used in the preview build.",
                        still: s.backdrop, duration: 1500,
                        resumePosition: (sn == 1 && e == 1) ? 600 : 0,
                        watched: (sn == 1 && e <= 2) ? 1 : 0,
                        files: [MovieFile(id: sn * 100 + e, quality: "1080p", filename: "episode.mkv", size: nil)])
            }
            seasons.append(Season(season: sn, episodes: eps))
        }
        return ShowDetail(id: id, title: s.title, year: s.year, poster: s.poster, backdrop: s.backdrop,
                          overview: s.overview, rating: s.rating, genres: s.genres, seasons: seasons)
    }
    func showExtra(_ id: Int) async -> ShowExtra? {
        await get("api/shows/\(id)/extra", as: ShowExtra.self)
    }
    func episodeExtra(_ id: Int) async -> EpisodeExtra? {
        if previewMode { return nil }
        return await get("api/episodes/\(id)/extra", as: EpisodeExtra.self)
    }
    func setEpisodeWatched(_ id: Int, _ watched: Bool) async {
        _ = try? await request("api/episodes/\(id)/watched", method: "POST", body: ["watched": watched])
    }
    func collectionDetail(_ id: String) async -> CollectionDetail? {
        let enc = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return await get("api/collections/\(enc)", as: CollectionDetail.self)
    }

    // ---- Playback ----
    // A movie or a TV episode — they stream and save progress at different paths.
    enum PlayRef: Hashable { case movie(Int), episode(Int) }

    private var cleanBase: String {
        let s = serverURL.trimmingCharacters(in: .whitespaces)
        return s.hasSuffix("/") ? String(s.dropLast()) : s
    }

    // AVPlayer can't set an Authorization header, so it streams via ?token= on
    // the URL (the server accepts that). Pass the best file's id.
    func streamURL(fileId: Int) -> URL? {
        guard let t = token else { return nil }
        return URL(string: "\(cleanBase)/api/stream/\(fileId)?token=\(t)")
    }
    func episodeStreamURL(fileId: Int) -> URL? {
        guard let t = token else { return nil }
        return URL(string: "\(cleanBase)/api/stream/episode/\(fileId)?token=\(t)")
    }

    // The player is now VLCKit (libVLC), which direct-plays every container and
    // codec (mkv, hev1-tagged HEVC, E-AC-3, …). So we ALWAYS stream the raw file
    // with byte-range seeking (/api/stream) and never route through the server's
    // HLS remux. (hlsURL is kept for any legacy/fallback caller.)
    func playbackURL(kind: String, file: MovieFile) -> URL? {
        return kind == "episode" ? episodeStreamURL(fileId: file.id) : streamURL(fileId: file.id)
    }
    // Kick the server's HLS remux for this file WITHOUT waiting — called while
    // the HDR display switch is settling (~3s), so ffmpeg has segments ready by
    // the time AVPlayer asks (cold-start races were failing first plays).
    func warmHLS(kind: String, fileId: Int) {
        Task { _ = try? await request("api/hls/\(kind)/\(fileId)/index.m3u8?\(audioQuery())") }
    }

    func hlsURL(kind: String, fileId: Int, mvar: Int = 1) -> URL? {
        guard let t = token else { return nil }
        let x = mvar > 1 ? "&mvar=\(mvar)" : ""
        return URL(string: "\(cleanBase)/api/hls/\(kind)/\(fileId)/master.m3u8?token=\(t)&\(audioQuery())\(x)")
    }
    // VLCKit plays anything, so there's no direct-vs-remux decision to make —
    // just hand back the raw byte-range stream. Kept async so call sites are
    // unchanged.
    func resolvePlaybackURL(kind: String, file: MovieFile) async -> URL? {
        return kind == "episode" ? episodeStreamURL(fileId: file.id) : streamURL(fileId: file.id)
    }

    struct SubtitleTrack: Decodable, Hashable { let label: String; let idx: Int }
    func subtitleTracks(kind: String, fileId: Int) async -> [SubtitleTrack] {
        if previewMode { return [] }
        return await get("api/subtitles/list/\(kind)/\(fileId)", as: [SubtitleTrack].self) ?? []
    }
    // A single subtitle track as WebVTT (server converts SRT/ASS/embedded on the
    // fly). Loaded into VLCKit via addPlaybackSlave. `idx` is from subtitleTracks.
    func subtitleURL(kind: String, fileId: Int, idx: Int) -> URL? {
        guard let t = token else { return nil }
        let base = kind == "episode" ? "api/subtitle/episode/\(fileId)" : "api/subtitle/\(fileId)"
        return URL(string: "\(cleanBase)/\(base)?idx=\(idx)&token=\(t)")
    }

    // Real probed stream properties for the player's HDR/frame-rate display match
    // + the "now playing" info overlay.
    struct MediaInfo: Decodable {
        let width: Int?; let height: Int?; let fps: Double?
        let hdr: String?               // "sdr" | "hdr10" | "hlg" | "dolbyvision"
        let bitDepth: Int?
        let vcodec: String?; let acodec: String?; let channels: Int?; let channelLayout: String?
        let size: Double?; let videoKbps: Int?
        var resolutionText: String { guard let h = height else { return "—" }; return h >= 2000 ? "4K" : "\(h)p" }
        var hdrText: String? {
            switch hdr { case "hdr10": return "HDR10"; case "hlg": return "HLG"
                         case "dolbyvision": return "Dolby Vision"; default: return nil }
        }
        var isHDR: Bool { hdr != nil && hdr != "sdr" }
    }
    func mediaInfo(kind: String, fileId: Int) async -> MediaInfo? {
        if previewMode { return nil }
        return await get("api/mediainfo/\(kind)/\(fileId)", as: MediaInfo.self)
    }

    // libVLC media options re-creating the old server-side audio filters on the
    // direct-play path (night = dynamic-range compression, norm = volume
    // normalization, dialogue boost = gain). Applied to the VLCMedia before play.
    func audioFilterOptions() -> [String] {
        var opts: [String] = []
        var mods: [String] = []
        if night { mods.append("compressor") }
        if norm { mods.append("normvol") }
        if !mods.isEmpty { opts.append(":audio-filter=\(mods.joined(separator: ","))") }
        if dboost == "strong" { opts.append(":gain=4") }
        else if dboost == "normal" { opts.append(":gain=2") }
        return opts
    }

    // ---- /api/play: the server's playback decision + Skip Intro/chapter data ----
    struct IntroRange: Decodable, Hashable { let start: Double; let end: Double }
    struct PlayChapter: Decodable, Hashable { let start: Double; let end: Double; let title: String? }
    struct PlayMeta: Decodable {
        let mode: String?
        let duration: Double?
        let intro: IntroRange?
        let chapters: [PlayChapter]?
    }
    // Also primes the server's playDecisions cache so the admin Now Playing
    // monitor reports the authoritative direct/transcode engine for us.
    func playMeta(kind: String, fileId: Int) async -> PlayMeta? {
        if previewMode { return nil }
        return await get("api/play/\(kind)/\(fileId)?\(audioQuery())", as: PlayMeta.self)
    }

    // ---- Session heartbeat (feeds the admin "Now Playing" monitor) ----
    func sessionHeartbeat(sessionId: String, kind: String, fileId: Int?, title: String,
                          subtitle: String?, mode: String, position: Double, duration: Double?,
                          paused: Bool, live: Bool, bufferedAhead: Double = 0) async {
        if previewMode { return }
        var body: [String: Any] = [
            "sessionId": sessionId, "kind": kind, "title": title, "mode": mode,
            "position": position, "paused": paused, "live": live, "tv": true,
            "bufferedAhead": bufferedAhead,
            "audioMode": audioMode == "surround" ? "surround" : "stereo"
        ]
        if let fileId { body["fileId"] = fileId }
        if let subtitle, !subtitle.isEmpty { body["subtitle"] = subtitle }
        if let duration, duration.isFinite, duration > 0 { body["duration"] = duration }
        _ = try? await request("api/session/heartbeat", method: "POST", body: body)
    }
    func sessionEnd(sessionId: String) async {
        if previewMode { return }
        _ = try? await request("api/session/end", method: "POST", body: ["sessionId": sessionId])
    }

    // ---- AI (Whisper) subtitle generation — background job + poll ----
    struct SubJob: Decodable { let status: String; let pct: Int?; let phase: String?; let error: String? }
    func generateSubtitles(kind: String, fileId: Int) async -> SubJob? {
        do {
            let (data, http) = try await request("api/subtitles/generate", method: "POST",
                                                 body: ["kind": kind, "fileId": fileId, "target": "orig"])
            guard (200..<300).contains(http.statusCode) else {
                return SubJob(status: "error", pct: nil, phase: nil, error: serverError(data) ?? "Couldn't start.")
            }
            return try? decoder().decode(SubJob.self, from: data)
        } catch { return SubJob(status: "error", pct: nil, phase: nil, error: "Couldn't reach the server.") }
    }
    func subtitleJobStatus(kind: String, fileId: Int) async -> SubJob? {
        await get("api/subtitles/generate?kind=\(kind)&fileId=\(fileId)&target=orig", as: SubJob.self)
    }

    // Mark a Continue Watching entry watched (the web card's ✓) and drop it.
    func markContinueWatched(_ item: ContinueItem) async {
        let path = item.kind == "movie" ? "api/movies/\(item.id)/watched" : "api/episodes/\(item.id)/watched"
        _ = try? await request(path, method: "POST", body: ["watched": true])
        continueItems.removeAll { $0.kind == item.kind && $0.id == item.id }
    }

    // Pre-roll clip URL (plays before a movie), or nil if none configured.
    func prerollURL() async -> URL? {
        struct R: Decodable { let available: Bool; let url: String?; let mode: String? }
        guard let r = await get("api/preroll", as: R.self), r.available, let u = r.url, let t = token else { return nil }
        var s = "\(cleanBase)\(u)?token=\(t)"
        if r.mode == "transcode" { s += "&start=0&\(audioQuery())" }
        return URL(string: s)
    }

    func saveProgress(_ ref: PlayRef, position: Double, duration: Double?, watched: Bool? = nil) async {
        var body: [String: Any] = ["position": position]
        if let duration { body["duration"] = duration }
        if let watched { body["watched"] = watched }
        let path: String
        switch ref {
        case .movie(let id):   path = "api/movies/\(id)/progress"
        case .episode(let id): path = "api/episodes/\(id)/progress"
        }
        _ = try? await request(path, method: "POST", body: body)
    }

    // ---- Detail extras + favorite/watched ----
    func movieExtra(_ id: Int) async -> MovieExtra? {
        await get("api/movies/\(id)/extra", as: MovieExtra.self)
    }
    func toggleFavorite(_ id: Int) async -> Bool? {
        struct R: Decodable { let favorite: Int }
        do {
            let (data, _) = try await request("api/movies/\(id)/favorite", method: "POST")
            return (try? decoder().decode(R.self, from: data))?.favorite == 1
        } catch { return nil }
    }
    func setWatched(_ id: Int, _ watched: Bool) async {
        _ = try? await request("api/movies/\(id)/watched", method: "POST", body: ["watched": watched])
    }

    // ---- Settings: streaming sources ----
    func loadProviders() async -> ProvidersResponse? { await get("api/providers", as: ProvidersResponse.self) }
    func saveProviders(enabled: [String], local: Bool) async {
        _ = try? await request("api/providers", method: "POST", body: ["enabled": enabled, "local": local])
    }

    // ---- Settings: accounts (admin) ----
    func loadUsers() async -> [UserRow] { await get("api/users", as: [UserRow].self) ?? [] }
    func addUser(username: String, password: String, role: String = "user") async -> String {
        do {
            let (data, http) = try await request("api/users", method: "POST",
                body: ["username": username, "password": password, "role": role])
            if (200..<300).contains(http.statusCode) { return "Added \(username)." }
            return serverError(data) ?? "Couldn't add user (\(http.statusCode))."
        } catch { return "Couldn't reach the server." }
    }
    func deleteUser(_ id: Int) async {
        _ = try? await request("api/users/\(id)", method: "DELETE")
    }

    // ---- Settings: Radarr/Sonarr, pre-roll, subtitles (admin) ----
    func saveArr(radarrURL: String, radarrKey: String, sonarrURL: String, sonarrKey: String) async -> String {
        var body: [String: Any] = [:]
        if !radarrURL.isEmpty { body["radarr"] = ["url": radarrURL, "apiKey": radarrKey] }
        if !sonarrURL.isEmpty { body["sonarr"] = ["url": sonarrURL, "apiKey": sonarrKey] }
        do {
            let (data, http) = try await request("api/settings/arr", method: "POST", body: body)
            return (200..<300).contains(http.statusCode) ? "Saved & tested." : (serverError(data) ?? "Save failed.")
        } catch { return "Couldn't reach the server." }
    }
    func prerollAvailable() async -> Bool {
        struct R: Decodable { let available: Bool }
        return (await get("api/preroll", as: R.self))?.available ?? false
    }
    func savePreroll(path: String) async -> String {
        do {
            let (data, http) = try await request("api/settings/preroll", method: "POST", body: ["path": path])
            return (200..<300).contains(http.statusCode) ? "Pre-roll saved." : (serverError(data) ?? "Save failed.")
        } catch { return "Couldn't reach the server." }
    }
    func saveOpenSubtitles(apiKey: String, username: String, password: String) async -> String {
        do {
            let (_, http) = try await request("api/settings/opensubtitles", method: "POST",
                body: ["apiKey": apiKey, "username": username, "password": password])
            return (200..<300).contains(http.statusCode) ? "Subtitle account saved." : "Save failed."
        } catch { return "Couldn't reach the server." }
    }

    // ---- Settings: engines (admin) ----
    func engineStatus(_ path: String) async -> EngineStatus? { await get("api/\(path)", as: EngineStatus.self) }
    func installEngine(_ path: String) async { _ = try? await request("api/\(path)/install", method: "POST") }
    func runIntroDetect() async { _ = try? await request("api/intro/run", method: "POST") }
    func loadSessions() async -> [AdminSession] {
        (await get("api/admin/sessions", as: SessionsResponse.self))?.sessions ?? []
    }

    // Flat playable-episode list for Live TV channels.
    func loadLiveEpisodes() async -> [LiveEpisode] {
        await get("api/livetv/episodes", as: [LiveEpisode].self) ?? []
    }
    func serverVersion() async -> String? {
        struct R: Decodable { let version: String?; let commit: String? }
        let r = await get("api/version", as: R.self)
        return r?.version ?? r?.commit
    }

    // ---- Requests (Radarr/Sonarr) ----
    func requestsSearch(_ q: String) async -> (results: [RequestResult], error: String?) {
        let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        do {
            let (data, http) = try await request("api/requests/search?q=\(enc)")
            if http.statusCode == 400 { return ([], serverError(data) ?? "Requests aren't set up. Add Radarr/Sonarr on the web app.") }
            guard (200..<300).contains(http.statusCode) else { return ([], "Search failed (\(http.statusCode)).") }
            return ((try? decoder().decode([RequestResult].self, from: data)) ?? [], nil)
        } catch { return ([], "Couldn't reach the server.") }
    }

    // Quality profiles for the request picker (Radarr = movies, Sonarr = TV).
    func requestProfiles(for type: String) async -> [ArrProfile] {
        guard let p = await get("api/requests/profiles", as: ProfilesResponse.self) else { return [] }
        return (type == "movie" ? p.radarr : p.sonarr)?.profiles ?? []
    }

    func requestAdd(_ r: RequestResult, profileId: Int? = nil) async -> String {
        var body: [String: Any] = ["type": r.type]
        if let t = r.tmdbId { body["tmdbId"] = t }
        if let t = r.tvdbId { body["tvdbId"] = t }
        var pid = profileId
        if pid == nil { pid = (await requestProfiles(for: r.type)).first?.id }
        if let pid { body["qualityProfileId"] = pid }
        do {
            let (data, http) = try await request("api/requests/add", method: "POST", body: body)
            if (200..<300).contains(http.statusCode) { return "Requested “\(r.title)”." }
            return serverError(data) ?? "Couldn't add (\(http.statusCode))."
        } catch { return "Couldn't reach the server." }
    }

    private func serverError(_ data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data)).flatMap { ($0 as? [String: Any])?["error"] as? String }
    }
}
