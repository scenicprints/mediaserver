import Foundation

// ---- API models (the same /api/* JSON the web UI consumes) ----
// Posters/backdrops are full https://image.tmdb.org URLs, so AsyncImage loads
// them directly. snake_case -> camelCase via .convertFromSnakeCase.
struct Movie: Identifiable, Decodable, Hashable {
    let id: Int
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

    var progressFraction: Double {
        guard let d = duration, d > 0, let p = resumePosition else { return 0 }
        return min(max(p / d, 0), 1)
    }
    var genreList: [String] { Store.parseJSONStrings(genres) }
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
    var subtitle: String? {
        guard kind == "episode", let s = season, let e = episode else { return nil }
        return String(format: "S%d · E%d", s, e)
    }
}

struct Show: Identifiable, Decodable, Hashable {
    let id: Int
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

    var genreList: [String] { Store.parseJSONStrings(genres) }
}

struct Collection: Identifiable, Decodable, Hashable {
    let id: String
    let name: String
    let count: Int?
    let poster: String?
    let backdrop: String?
}

// ---- Playback: /api/movies/:id returns the logical movie + its files ----
struct MovieFile: Identifiable, Decodable, Hashable {
    let id: Int
    let quality: String?
    let filename: String?
    let size: Double?
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
struct ProfilesResponse: Decodable { let radarr: [ArrProfile]?; let sonarr: [ArrProfile]? }

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

    var isLoggedIn: Bool { token != nil }
    var isAdmin: Bool { user?.role == "admin" }

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? Store.defaultServer
        token = UserDefaults.standard.string(forKey: "authToken")
        audioMode = UserDefaults.standard.string(forKey: "audioMode") ?? "stereo"
        dboost = UserDefaults.standard.string(forKey: "dboost") ?? "normal"
        night = UserDefaults.standard.bool(forKey: "night")
        norm = UserDefaults.standard.bool(forKey: "norm")
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
    func loadHome() async {
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
        await get("api/shows/\(id)", as: ShowDetail.self)
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

    // Pick the right URL for a file: AVPlayer plays mp4/m4v/mov containers
    // directly (range streaming); anything else (mkv/avi/…) goes through the
    // server's HLS transcode endpoint so it plays on the Apple TV.
    func playbackURL(kind: String, file: MovieFile) -> URL? {
        guard let t = token else { return nil }
        let ext = (file.filename as NSString?)?.pathExtension.lowercased() ?? ""
        let native: Set<String> = ["mp4", "m4v", "mov"]
        if native.contains(ext) {
            return kind == "episode" ? episodeStreamURL(fileId: file.id) : streamURL(fileId: file.id)
        }
        return URL(string: "\(cleanBase)/api/hls/\(kind)/\(file.id)/index.m3u8?token=\(t)&\(audioQuery())")
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

    private func qualityProfileId(for type: String) async -> Int? {
        guard let p = await get("api/requests/profiles", as: ProfilesResponse.self) else { return nil }
        return (type == "movie" ? p.radarr : p.sonarr)?.first?.id
    }

    func requestAdd(_ r: RequestResult) async -> String {
        var body: [String: Any] = ["type": r.type]
        if let t = r.tmdbId { body["tmdbId"] = t }
        if let t = r.tvdbId { body["tvdbId"] = t }
        if let pid = await qualityProfileId(for: r.type) { body["qualityProfileId"] = pid }
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
