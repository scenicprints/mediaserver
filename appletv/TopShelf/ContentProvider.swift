import TVServices

// Top Shelf — the Apple TV home-screen row shown when Marquee is in the top
// app bar: the user's Continue Watching, straight from the server. Runs as a
// tiny app extension; it can't share the app's process, so it reads the server
// URL + session token from the shared app-group defaults (mirrored there by
// Store) and hits /api/continue itself. Poster URLs are absolute (TMDB), so
// tvOS fetches the artwork directly.
//
// Two addresses, in order: `activeURL`, the one the app last used (the
// server's LAN address when it is at home, which it only switches to after the
// server proved who it is), then `serverURL`, the configured one. So the shelf
// still fills on the home network when the internet is down.
//
// Every step breadcrumbs to POST /api/clientlog ("shelf: …"), so a silent
// shelf can be diagnosed from the server (GET /api/clientlog as admin).
final class ContentProvider: TVTopShelfContentProvider {

    private var creds: (bases: [String], token: String)? {
        let shared = UserDefaults(suiteName: "group.com.scenicprints.marqueetv")
        guard let t = shared?.string(forKey: "authToken"), !t.isEmpty else { return nil }
        var bases: [String] = []
        for k in ["activeURL", "serverURL"] {
            guard var s = shared?.string(forKey: k)?.trimmingCharacters(in: .whitespaces),
                  !s.isEmpty else { continue }
            if s.hasSuffix("/") { s = String(s.dropLast()) }
            if !bases.contains(s) { bases.append(s) }
        }
        return bases.isEmpty ? nil : (bases, t)
    }

    private func crumb(_ step: String, base: String, token: String) {
        // Best-effort telemetry; extension lifetime is short, so keep it simple.
        guard let url = URL(string: "\(base)/api/clientlog") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.timeoutInterval = 4
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
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
        crumb("shelf: invoked, creds ok", base: c.bases[0], token: c.token)
        fetch(c.bases[...], token: c.token, completionHandler)
    }

    // Try each address in turn; move on only when one gives no answer at all.
    // Short timeouts, because the system gives extensions only a few seconds.
    private func fetch(_ bases: ArraySlice<String>, token: String,
                       _ done: @escaping (TVTopShelfContent?) -> Void) {
        guard let base = bases.first else { done(nil); return }
        guard let url = URL(string: "\(base)/api/continue") else {
            fetch(bases.dropFirst(), token: token, done); return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = bases.count > 1 ? 4 : 6
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // Holds self for the one callback; the task doesn't outlive it.
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if resp == nil && bases.count > 1 {
                self.fetch(bases.dropFirst(), token: token, done); return
            }
            let http = (resp as? HTTPURLResponse)?.statusCode ?? -1
            struct Row: Decodable {
                let kind: String; let id: Int; let title: String
                let showTitle: String?; let poster: String?
            }
            let dec = JSONDecoder(); dec.keyDecodingStrategy = .convertFromSnakeCase
            let rows = (try? dec.decode([Row].self, from: data ?? Data())) ?? []
            self.crumb("shelf: fetch http=\(http) err=\(err.map { String(describing: $0) } ?? "none") rows=\(rows.count)",
                       base: base, token: token)
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
            guard !items.isEmpty else {
                self.crumb("shelf: no items — returning nil", base: base, token: token)
                done(nil); return
            }
            let section = TVTopShelfItemCollection(items: Array(items))
            section.title = "Continue Watching"
            self.crumb("shelf: returning \(items.count) items", base: base, token: token)
            done(TVTopShelfSectionedContent(sections: [section]))
        }.resume()
    }
}
