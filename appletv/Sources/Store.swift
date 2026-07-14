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

    var progressFraction: Double {
        guard let d = duration, d > 0, let p = resumePosition else { return 0 }
        return min(max(p / d, 0), 1)
    }
    var genreList: [String] { Store.parseJSONStrings(genres) }
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

    var isLoggedIn: Bool { token != nil }

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? Store.defaultServer
        token = UserDefaults.standard.string(forKey: "authToken")
    }

    private func decoder() -> JSONDecoder {
        let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase; return d
    }

    static func parseJSONStrings(_ s: String?) -> [String] {
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

    // ---- Playback ----
    // AVPlayer can't set an Authorization header, so it streams via ?token= on
    // the URL (the server accepts that). Highest-quality file is files.first.
    func streamURL(fileId: Int) -> URL? {
        guard let t = token else { return nil }
        let base = serverURL.trimmingCharacters(in: .whitespaces).hasSuffix("/")
            ? String(serverURL.dropLast()) : serverURL
        return URL(string: "\(base)/api/stream/\(fileId)?token=\(t)")
    }

    func saveProgress(movieId: Int, position: Double, duration: Double?, watched: Bool? = nil) async {
        var body: [String: Any] = ["position": position]
        if let duration { body["duration"] = duration }
        if let watched { body["watched"] = watched }
        _ = try? await request("api/movies/\(movieId)/progress", method: "POST", body: body)
    }

    private func serverError(_ data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data)).flatMap { ($0 as? [String: Any])?["error"] as? String }
    }
}
