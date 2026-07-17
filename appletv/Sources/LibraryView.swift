import SwiftUI

// The Library tab — the whole collection A→Z (matching the web Library): a clean
// grouped grid with accent letter headers, a pill Movies/TV toggle, a sleek
// search field, and a vertical A-Z rail on the right that jumps to any letter.
// Includes streaming titles (provider badge; opens the service), like the web.
struct LibraryView: View {
    @EnvironmentObject var store: Store
    @Environment(\.openURL) private var openURL
    @Binding var route: [Route]
    @State private var kind = "movie"
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    private let columns = [GridItem(.adaptive(minimum: Theme.posterWidth), spacing: Theme.cardSpacing)]

    private struct LibItem: Identifiable {
        let id: String; let title: String; let poster: String?; let sub: String?
        let progress: Double; let badges: [CardBadge]; let stream: [String]?; let route: Route
        let year: Int?
    }

    private func sortKey(_ t: String) -> String {
        t.replacingOccurrences(of: #"^(the|a|an) "#, with: "", options: [.regularExpression, .caseInsensitive])
    }
    // Franchise base = the part before a "Subtitle" (colon/dash), so sequels
    // cluster together. e.g. "Avengers: Endgame" -> "Avengers".
    private func franchiseBase(_ t: String) -> String {
        let s = sortKey(t)
        for sep in [": ", " - "] {
            if let r = s.range(of: sep) { return String(s[..<r.lowerBound]) }
        }
        return s
    }
    // A→Z, but titles in the same franchise sort in RELEASE order (by year) so
    // "Avengers: Infinity War" (2018) precedes "Avengers: Endgame" (2019).
    private func lessThan(_ a: LibItem, _ b: LibItem) -> Bool {
        let cmp = franchiseBase(a.title).localizedCaseInsensitiveCompare(franchiseBase(b.title))
        if cmp != .orderedSame { return cmp == .orderedAscending }
        if (a.year ?? 0) != (b.year ?? 0) { return (a.year ?? 0) < (b.year ?? 0) }
        return sortKey(a.title).localizedCaseInsensitiveCompare(sortKey(b.title)) == .orderedAscending
    }
    private func letter(_ t: String) -> String {
        let c = sortKey(t).uppercased().first.map(String.init) ?? "#"
        return (c >= "A" && c <= "Z") ? c : "#"
    }

    private func movieItem(_ m: Movie) -> LibItem {
        let c = Browse.movieCard(m)
        return LibItem(id: c.id, title: m.title, poster: m.poster, sub: m.year.map(String.init),
                       progress: m.progressFraction, badges: c.badges, stream: c.stream, route: c.route, year: m.year)
    }
    private func showItem(_ s: Show) -> LibItem {
        let c = Browse.showCard(s)
        return LibItem(id: c.id, title: s.title, poster: s.poster, sub: s.year.map(String.init),
                       progress: 0, badges: c.badges, stream: c.stream, route: c.route, year: s.year)
    }

    // The A-Z browse list: the current kind, streaming included (like the web).
    private var items: [LibItem] {
        let src: [LibItem] = kind == "movie" ? store.movies.map(movieItem) : store.shows.map(showItem)
        return src.sorted(by: lessThan)
    }
    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }
    // Search spans EVERYTHING — both kinds, owned and streaming.
    private var filtered: [LibItem] {
        let all = store.movies.map(movieItem) + store.shows.map(showItem)
        return all.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil }
            .sorted(by: lessThan)
    }
    private var groups: [(String, [LibItem])] {
        Dictionary(grouping: items, by: { letter($0.title) }).sorted { $0.key < $1.key }
    }
    private var letters: [String] { groups.map { $0.0 } }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    MarqueeWordmark()

                    HStack(spacing: 20) {
                        toggle
                        searchField
                        Spacer(minLength: 0)
                        Text("\(items.count)").font(.title3).foregroundStyle(Theme.muted)
                    }

                    if !trimmed.isEmpty {
                        LazyVGrid(columns: columns, spacing: Theme.rowSpacing) {
                            ForEach(filtered) { card($0) }
                        }
                        if filtered.isEmpty {
                            Text("No matches for “\(trimmed)”.").foregroundStyle(Theme.muted).padding(.top, 20)
                        }
                    } else {
                        ForEach(groups, id: \.0) { L, list in
                            Text(L).font(.system(size: 30, weight: .heavy)).foregroundStyle(Theme.accent2)
                                .padding(.top, 8).id("L-\(L)")
                            LazyVGrid(columns: columns, spacing: Theme.rowSpacing) {
                                ForEach(list) { card($0) }
                            }
                        }
                    }
                }
                .padding(.leading, Theme.gutter).padding(.trailing, 96)
                .padding(.top, 32).padding(.bottom, Theme.gutter)
            }
            .overlay(alignment: .trailing) {
                if trimmed.isEmpty && !letters.isEmpty { azRail(proxy) }
            }
        }
        .task { if store.movies.isEmpty { await store.loadHome() } }
        .onAppear { Task { await store.refreshHome() } }
    }

    private func card(_ it: LibItem) -> some View {
        PosterCard(title: it.title, posterURL: it.poster, subtitle: it.sub,
                   progress: it.progress, badges: it.badges) {
            // Streaming titles open their service; owned ones push a detail page.
            if let provs = it.stream, let slug = provs.first, let url = StreamProvider.url(slug, it.title) {
                openURL(url)
            } else {
                route.append(it.route)
            }
        }
    }

    // Sleek pill segmented control (web .lib-head .tabs).
    private var toggle: some View {
        HStack(spacing: 4) {
            ForEach(["movie", "tv"], id: \.self) { k in
                Button { kind = k } label: {
                    Text(k == "movie" ? "Movies" : "TV Shows")
                        .font(.headline).padding(.horizontal, 22).padding(.vertical, 10)
                        .foregroundStyle(kind == k ? .white : Theme.muted)
                        .background { if kind == k { Capsule().fill(Theme.grad) } }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(5).background(Theme.card, in: Capsule())
    }

    private var searchField: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass").foregroundStyle(searchFocused ? Theme.accent : Theme.muted)
            TextField("Search", text: $query).textFieldStyle(.plain).font(.title3).focused($searchFocused)
        }
        .padding(.horizontal, 22).padding(.vertical, 12)
        .frame(maxWidth: 520)
        .background(Theme.card, in: Capsule())
        .overlay(Capsule().strokeBorder(searchFocused ? Theme.accent : .clear, lineWidth: 2))
    }

    // Vertical A-Z rail on the right edge — jump to a letter.
    private func azRail(_ proxy: ScrollViewProxy) -> some View {
        VStack(spacing: 2) {
            ForEach(letters, id: \.self) { L in
                Button { withAnimation { proxy.scrollTo("L-\(L)", anchor: .top) } } label: {
                    Text(L).font(.caption).fontWeight(.heavy).foregroundStyle(Theme.accent2)
                        .frame(width: 46, height: 30)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 14)
        .background(Theme.card.opacity(0.65), in: Capsule())
        .padding(.trailing, 24)
    }
}
