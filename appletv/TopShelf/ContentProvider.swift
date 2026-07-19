import TVServices

// Top Shelf — the Apple TV home-screen row shown when Marquee is in the top
// app bar: the user's Continue Watching, straight from the server. Runs as a
// tiny app extension; it can't share the app's process, so it reads the server
// URL + session token from the shared app-group defaults (mirrored there by
// Store) and hits /api/continue itself. Poster URLs are absolute (TMDB), so
// tvOS fetches the artwork directly.
final class ContentProvider: TVTopShelfContentProvider {

    override func loadTopShelfContent(completionHandler: @escaping (TVTopShelfContent?) -> Void) {
        let shared = UserDefaults(suiteName: "group.com.scenicprints.marqueetv")
        guard var server = shared?.string(forKey: "serverURL"),
              let token = shared?.string(forKey: "authToken"), !token.isEmpty
        else { completionHandler(nil); return }
        server = server.trimmingCharacters(in: .whitespaces)
        if server.hasSuffix("/") { server = String(server.dropLast()) }
        guard let url = URL(string: "\(server)/api/continue") else { completionHandler(nil); return }

        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: req) { data, _, _ in
            struct Row: Decodable {
                let kind: String; let id: Int; let title: String
                let showTitle: String?; let poster: String?
            }
            let dec = JSONDecoder(); dec.keyDecodingStrategy = .convertFromSnakeCase
            let rows = (try? dec.decode([Row].self, from: data ?? Data())) ?? []
            let items = rows.prefix(10).map { r -> TVTopShelfSectionedItem in
                let item = TVTopShelfSectionedItem(identifier: "\(r.kind)-\(r.id)")
                // Episodes show as "Show — S2·E06 · Title"; movies as their title.
                item.title = r.showTitle.map { "\($0) — \(r.title)" } ?? r.title
                item.imageShape = .poster
                if let p = r.poster, let u = URL(string: p) {
                    item.setImageURL(u, for: [.screenScale1x, .screenScale2x])
                }
                return item
            }
            guard !items.isEmpty else { completionHandler(nil); return }
            let section = TVTopShelfItemCollection(items: Array(items))
            section.title = "Continue Watching"
            completionHandler(TVTopShelfSectionedContent(sections: [section]))
        }.resume()
    }
}
