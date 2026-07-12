import Foundation

// ---- API models (GET /api/movies etc., snake_case -> camelCase) ----
// Posters/backdrops are full https://image.tmdb.org URLs, so AsyncImage loads
// them directly.
struct Movie: Identifiable, Decodable {
    let id: Int
    let title: String
    let year: Int?
    let poster: String?
    let backdrop: String?
    let overview: String?
    let rating: Double?
    let resumePosition: Double?
    let duration: Double?
    let versions: Int?
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
    @Published var movies: [Movie] = []
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

    // The server accepts the session token as an Authorization: Bearer header
    // (as well as a cookie), so a native client just attaches it here.
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
            await loadMovies()
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
            await loadMovies()
        } catch { /* offline — keep the stored token, retry later */ }
    }

    func logout() {
        let old = token
        token = nil; user = nil; movies = []
        if old != nil { Task { _ = try? await request("api/logout", method: "POST") } }
    }

    func loadMovies() async {
        loading = true; error = nil
        defer { loading = false }
        do {
            let (data, http) = try await request("api/movies")
            if http.statusCode == 401 { token = nil; user = nil; return }
            guard (200..<300).contains(http.statusCode) else { error = "Server error (\(http.statusCode))."; return }
            movies = try decoder().decode([Movie].self, from: data)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func serverError(_ data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data)).flatMap { ($0 as? [String: Any])?["error"] as? String }
    }
}
