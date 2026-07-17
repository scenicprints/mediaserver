import SwiftUI

// The Library tab — Plex-style: a clean continuous poster grid with a Movies/TV
// toggle, search, and a filter bar (Unwatched + genres). No A-Z letter headers or
// side rail. Streaming titles keep their provider badge and open the service.
struct LibraryView: View {
    @EnvironmentObject var store: Store
    @Environment(\.openURL) private var openURL
    @Binding var route: [Route]
    @State private var kind = "movie"
    @State private var query = ""
    @State private var selectedGenre: String? = nil
    @State private var unwatchedOnly = false
    @FocusState private var searchFocused: Bool
    private let columns = [GridItem(.adaptive(minimum: Theme.posterWidth), spacing: Theme.cardSpacing)]

    private struct LibItem: Identifiable {
        let id: String; let title: String; let poster: String?; let sub: String?
        let progress: Double; let badges: [CardBadge]; let stream: [String]?; let route: Route
        let year: Int?; let genres: [String]; let unwatched: Bool
    }

    private func sortKey(_ t: String) -> String {
        t.replacingOccurrences(of: #"^(the|a|an) "#, with: "", options: [.regularExpression, .caseInsensitive])
    }
    // Franchise base = the part before a "Subtitle" so sequels cluster together.
    private func franchiseBase(_ t: String) -> String {
        let s = sortKey(t)
        for sep in [": ", " - "] { if let r = s.range(of: sep) { return String(s[..<r.lowerBound]) } }
        return s
    }
    // A→Z, but same-franchise titles sort in RELEASE order (year).
    private func lessThan(_ a: LibItem, _ b: LibItem) -> Bool {
        let cmp = franchiseBase(a.title).localizedCaseInsensitiveCompare(franchiseBase(b.title))
        if cmp != .orderedSame { return cmp == .orderedAscending }
        if (a.year ?? 0) != (b.year ?? 0) { return (a.year ?? 0) < (b.year ?? 0) }
        return sortKey(a.title).localizedCaseInsensitiveCompare(sortKey(b.title)) == .orderedAscending
    }

    private func movieItem(_ m: Movie) -> LibItem {
        let c = Browse.movieCard(m)
        return LibItem(id: c.id, title: m.title, poster: m.poster, sub: m.year.map(String.init),
                       progress: m.progressFraction, badges: c.badges, stream: c.stream, route: c.route,
                       year: m.year, genres: Store.parseJSONStrings(m.genres), unwatched: (m.watched ?? 0) == 0)
    }
    private func showItem(_ s: Show) -> LibItem {
        let c = Browse.showCard(s)
        return LibItem(id: c.id, title: s.title, poster: s.poster, sub: s.year.map(String.init),
                       progress: 0, badges: c.badges, stream: c.stream, route: c.route,
                       year: s.year, genres: Store.parseJSONStrings(s.genres), unwatched: (s.unwatched ?? 0) > 0)
    }

    private var allItems: [LibItem] { (kind == "movie" ? store.movies.map(movieItem) : store.shows.map(showItem)) }
    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    // Genres present in the current kind, most common first.
    private var availableGenres: [String] {
        var counts: [String: Int] = [:]
        for it in allItems { for g in it.genres { counts[g, default: 0] += 1 } }
        return counts.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map(\.key)
    }

    private var visible: [LibItem] {
        var src = allItems.sorted(by: lessThan)
        if let g = selectedGenre { src = src.filter { $0.genres.contains(g) } }
        if unwatchedOnly { src = src.filter { $0.unwatched } }
        if !trimmed.isEmpty { src = src.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil } }
        return src
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                MarqueeWordmark()
                HStack(spacing: 20) {
                    toggle
                    searchField
                    Spacer(minLength: 0)
                    Text("\(visible.count)").font(.title3).foregroundStyle(Theme.muted)
                }
                filterBar
                LazyVGrid(columns: columns, spacing: Theme.rowSpacing) {
                    ForEach(visible) { card($0) }
                }
                if visible.isEmpty {
                    Text(trimmed.isEmpty ? "Nothing matches those filters." : "No matches for “\(trimmed)”.")
                        .foregroundStyle(Theme.muted).padding(.top, 20)
                }
            }
            .padding(.horizontal, Theme.gutter).padding(.top, 32).padding(.bottom, Theme.gutter)
        }
        .task { if store.movies.isEmpty { await store.loadHome() } }
        .onAppear { Task { await store.refreshHome() } }
        .onChange(of: kind) { _ in selectedGenre = nil }
    }

    private func card(_ it: LibItem) -> some View {
        PosterCard(title: it.title, posterURL: it.poster, subtitle: it.sub,
                   progress: it.progress, badges: it.badges) {
            if let provs = it.stream, let slug = provs.first, let url = StreamProvider.url(slug, it.title) {
                openURL(url)
            } else { route.append(it.route) }
        }
    }

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

    // Plex-style filter row: All · Unwatched · genres.
    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                pill("All", selectedGenre == nil && !unwatchedOnly) { selectedGenre = nil; unwatchedOnly = false }
                pill("Unwatched", unwatchedOnly) { unwatchedOnly.toggle() }
                ForEach(availableGenres, id: \.self) { g in
                    pill(g, selectedGenre == g) { selectedGenre = (selectedGenre == g ? nil : g) }
                }
            }
            .padding(.vertical, 6).padding(.horizontal, 2)
        }
        .focusSection()
    }
    private func pill(_ label: String, _ active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.headline).padding(.horizontal, 22).padding(.vertical, 10)
                .foregroundStyle(active ? .white : Theme.muted)
                .background(active ? AnyShapeStyle(Theme.grad) : AnyShapeStyle(Theme.card), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}
