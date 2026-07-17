import SwiftUI

// The Library tab — Plex-style continuous poster grid with a Movies/TV toggle,
// search, a compact genre + Unwatched filter bar (click "More" to expand genres),
// and an A-Z quick-jump rail. Streaming titles keep their provider badge.
struct LibraryView: View {
    @EnvironmentObject var store: Store
    @Environment(\.openURL) private var openURL
    @Binding var route: [Route]
    @State private var kind = "movie"
    @State private var query = ""
    @State private var selectedGenre: String? = nil
    @State private var unwatchedOnly = false
    @State private var genresExpanded = false
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
    private func franchiseBase(_ t: String) -> String {
        let s = sortKey(t)
        for sep in [": ", " - "] { if let r = s.range(of: sep) { return String(s[..<r.lowerBound]) } }
        return s
    }
    private func lessThan(_ a: LibItem, _ b: LibItem) -> Bool {
        let cmp = franchiseBase(a.title).localizedCaseInsensitiveCompare(franchiseBase(b.title))
        if cmp != .orderedSame { return cmp == .orderedAscending }
        if (a.year ?? 0) != (b.year ?? 0) { return (a.year ?? 0) < (b.year ?? 0) }
        return sortKey(a.title).localizedCaseInsensitiveCompare(sortKey(b.title)) == .orderedAscending
    }
    private func letterOf(_ t: String) -> String {
        let c = sortKey(t).uppercased().first.map(String.init) ?? "#"
        return (c >= "A" && c <= "Z") ? c : "#"
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
    // First item id for each present letter (for the A-Z jump).
    private var letterAnchors: [(letter: String, id: String)] {
        var seen = Set<String>(); var out: [(String, String)] = []
        for it in visible { let L = letterOf(it.title); if seen.insert(L).inserted { out.append((L, it.id)) } }
        return out
    }

    var body: some View {
        ScrollViewReader { proxy in
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
                        ForEach(visible) { card($0).id($0.id) }
                    }
                    if visible.isEmpty {
                        Text(trimmed.isEmpty ? "Nothing matches those filters." : "No matches for “\(trimmed)”.")
                            .foregroundStyle(Theme.muted).padding(.top, 20)
                    }
                }
                .padding(.leading, Theme.gutter).padding(.trailing, 96)
                .padding(.top, 32).padding(.bottom, Theme.gutter)
            }
            .overlay(alignment: .trailing) { if trimmed.isEmpty && !letterAnchors.isEmpty { azRail(proxy) } }
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

    // Compact filter row: All · Unwatched · a few genres · More/Less.
    private var filterBar: some View {
        let genres = genresExpanded ? availableGenres : Array(availableGenres.prefix(6))
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                pill("All", selectedGenre == nil && !unwatchedOnly) { selectedGenre = nil; unwatchedOnly = false }
                pill("Unwatched", unwatchedOnly) { unwatchedOnly.toggle() }
                ForEach(genres, id: \.self) { g in
                    pill(g, selectedGenre == g) { selectedGenre = (selectedGenre == g ? nil : g) }
                }
                if availableGenres.count > 6 {
                    pill(genresExpanded ? "Less" : "More…", false) { genresExpanded.toggle() }
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

    // A-Z quick-jump rail (right edge) — scrolls to the first title of each letter.
    private func azRail(_ proxy: ScrollViewProxy) -> some View {
        VStack(spacing: 2) {
            ForEach(letterAnchors, id: \.letter) { a in
                Button { withAnimation { proxy.scrollTo(a.id, anchor: .top) } } label: {
                    Text(a.letter).font(.caption).fontWeight(.heavy).foregroundStyle(Theme.accent2)
                        .frame(width: 46, height: 30)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 14).background(Theme.card.opacity(0.65), in: Capsule()).padding(.trailing, 24)
    }
}
