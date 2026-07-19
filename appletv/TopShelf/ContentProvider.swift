import TVServices

// Top Shelf — the Apple TV home-screen row shown when Marquee is in the top
// app bar: the user's Continue Watching, straight from the server. Runs as a
// tiny app extension; it can't share the app's process, so it reads the server
// URL + session token from the shared app-group defaults (mirrored there by
// Store) and hits /api/continue itself. Poster URLs are absolute (TMDB), so
// tvOS fetches the artwork directly.
//
// Every step breadcrumbs to POST /api/clientlog ("shelf: …"), so a silent
// shelf can be diagnosed from the server (GET /api/clientlog as admin).
final class ContentProvider: TVTopShelfContentProvider {

    private var creds: (server: String, token: String)? {
        let shared = UserDefaults(suiteName: "group.com.scenicprints.marqueetv")
        guard var s = shared?.string(forKey: "serverURL"),
              let t = shared?.string(forKey: "authToken"), !t.isEmpty else { return nil }
        s = s.trimmingCharacters(in: .whitespaces)
        if s.hasSuffix("/") { s = String(s.dropLast()) }
        return (s, t)
    }

    private func crumb(_ step: String) {
        // Best-effort telemetry; extension lifetime is short, so keep it simple.
        guard let c = creds, let url = URL(string: "\(c.server)/api/clientlog") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("Bearer \(c.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["step": step])
        URLSession.shared.dataTask(with: req).resume()
    }

    override func loadTopShelfContent(completionHandler: @escaping (TVTopShelfContent?) -> Void) {
        guard let c = creds else {
            // No creds → nothing to show AND no way to breadcrumb. (The app
            // mirrors serverURL+token into the app group on init/login.)
            completionHandler(nil); return
        }
        crumb("shelf: invoked, creds ok")
        guard let url = URL(string: "\(c.server)/api/continue") else { completionHandler(nil); return }

        var req = URLRequest(url: url)
        req.timeoutInterval = 8   // the system gives extensions only a few seconds
        req.setValue("Bearer \(c.token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            let http = (resp as? HTTPURLResponse)?.statusCode ?? -1
            struct Row: Decodable {
                let kind: String; let id: Int; let title: String
                let showTitle: String?; let poster: String?
            }
            let dec = JSONDecoder(); dec.keyDecodingStrategy = .convertFromSnakeCase
            let rows = (try? dec.decode([Row].self, from: data ?? Data())) ?? []
            self?.crumb("shelf: fetch http=\(http) err=\(err.map { String(describing: $0) } ?? "none") rows=\(rows.count)")
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
            guard !items.isEmpty else { self?.crumb("shelf: no items — returning nil"); completionHandler(nil); return }
            let section = TVTopShelfItemCollection(items: Array(items))
            section.title = "Continue Watching"
            self?.crumb("shelf: returning \(items.count) items")
            completionHandler(TVTopShelfSectionedContent(sections: [section]))
        }.resume()
    }
}
