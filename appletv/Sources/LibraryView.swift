import SwiftUI

// ============================================================================
// Library — the whole collection in one continuous grid, franchise-ordered, with
// a genre / Unwatched filter row, a search field, and an A–Z index rail.
//
// The index is a real index: the letter you are standing in is the only orange
// on the screen. A selected filter fills with ink instead, so "where I am" and
// "what I've narrowed to" never look like the same thing.
// ============================================================================

struct LibraryView: View {
    @EnvironmentObject var store: Store
    @Environment(\.openURL) private var openURL
    @Environment(\.pal) private var pal
    @Binding var route: [Route]
    @State private var kind = "movie"
    @State private var query = ""
    @State private var selectedGenre: String? = nil
    @State private var unwatchedOnly = false
    @State private var genresExpanded = false
    @State private var current = "A"
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 22), count: 8)

    private struct LibItem: Identifiable {
        let id: String; let title: String; let poster: String?; let sub: String?
        let progress: Double; let badges: [CardBadge]; let stream: [String]?; let route: Route
        let year: Int?; let genres: [String]; let unwatched: Bool
    }

    private func sortKey(_ t: String) -> String {
        t.replacingOccurrences(of: #"^(the|a|an) "#, with: "", options: [.regularExpression, .caseInsensitive])
    }
    // Franchise order: "Alien" before "Aliens", sequels by year, not alphabet.
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

    private var allItems: [LibItem] { kind == "movie" ? store.movies.map(movieItem) : store.shows.map(showItem) }
    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    // Top genres only (most common first) — keeps the filter row condensed.
    private var availableGenres: [String] {
        var counts: [String: Int] = [:]
        for it in allItems { for g in it.genres { counts[g, default: 0] += 1 } }
        return Array(counts.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map(\.key).prefix(12))
    }

    private var visible: [LibItem] {
        var src = allItems.sorted(by: lessThan)
        if let g = selectedGenre { src = src.filter { $0.genres.contains(g) } }
        if unwatchedOnly { src = src.filter { $0.unwatched } }
        if !trimmed.isEmpty { src = src.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil } }
        return src
    }
    // First item id for each present letter (for the A–Z jump).
    private var letterAnchors: [(letter: String, id: String)] {
        var seen = Set<String>(); var out: [(String, String)] = []
        for it in visible { let L = letterOf(it.title); if seen.insert(L).inserted { out.append((L, it.id)) } }
        return out
    }

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            ScrollViewReader { proxy in
                HStack(alignment: .top, spacing: 34) {
                    if trimmed.isEmpty && !letterAnchors.isEmpty { indexRail(proxy) }
                    content
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.top, 26)
            }
        }
        .task { if store.movies.isEmpty { await store.loadHome() } }
        .onAppear { Task { await store.refreshHome() } }
        .onChange(of: kind) { selectedGenre = nil; unwatchedOnly = false }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                SeasonCell(title: "Movies", selected: kind == "movie") { kind = "movie" }
                SeasonCell(title: "TV Shows", selected: kind == "tv") { kind = "tv" }
                Spacer(minLength: 24)
                InlineSearch(text: $query)
                Text("\(visible.count)").font(F.mono(17)).foregroundStyle(pal.ink3)
            }
            .overlay(alignment: .bottom) { Rectangle().fill(pal.rule).frame(height: 1) }
            .focusSection()

            filterRow.padding(.top, 16)

            if visible.isEmpty {
                Text(trimmed.isEmpty ? "Nothing matches those filters."
                                     : "Nothing matches “\(trimmed)”.")
                    .font(F.reg(22)).foregroundStyle(pal.ink2).padding(.top, 34)
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 26) {
                        ForEach(visible) { card($0).id($0.id) }
                    }
                    .padding(.top, 20).padding(.bottom, 50)
                }
                .focusSection()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func card(_ it: LibItem) -> some View {
        PosterCard(title: it.title, posterURL: it.poster, subtitle: it.sub,
                   progress: it.progress, badges: it.badges,
                   width: 186, height: 279) {
            // Streaming titles open their service; owned ones push a detail page.
            if let provs = it.stream, let slug = provs.first, let url = StreamProvider.url(slug, it.title) {
                openURL(url)
            } else {
                route.append(it.route)
            }
        }
    }

    // All · Unwatched · a few genres · More. A selected filter fills with ink.
    private var filterRow: some View {
        let genres = genresExpanded ? availableGenres : Array(availableGenres.prefix(5))
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                FilterChip(label: "All", selected: selectedGenre == nil && !unwatchedOnly) {
                    selectedGenre = nil; unwatchedOnly = false
                }
                FilterChip(label: "Unwatched", selected: unwatchedOnly) { unwatchedOnly.toggle() }
                ForEach(genres, id: \.self) { g in
                    FilterChip(label: g, selected: selectedGenre == g) {
                        selectedGenre = (selectedGenre == g ? nil : g)
                    }
                }
                if availableGenres.count > 5 {
                    FilterChip(label: genresExpanded ? "Fewer" : "More", selected: false) {
                        genresExpanded.toggle()
                    }
                }
            }
            .padding(.vertical, 2)
        }
        .focusSection()
    }

    private func indexRail(_ proxy: ScrollViewProxy) -> some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 10) {
                ForEach(letterAnchors, id: \.letter) { a in
                    IndexLetter(letter: a.letter, current: current == a.letter) {
                        current = a.letter
                        withAnimation { proxy.scrollTo(a.id, anchor: .top) }
                    }
                }
            }
            .padding(.top, 116)
        }
        .frame(width: 46)
        .focusSection()
    }
}

// A filter chip. Outlined at rest, ink-filled when it is the active filter —
// orange stays reserved for where you are, which here is the A–Z letter.
struct FilterChip: View {
    let label: String
    let selected: Bool
    let action: () -> Void
    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) {
            Text(label.uppercased())
                .font(F.med(15)).tracking(1.6)
                .foregroundStyle(selected || focused ? pal.onInverse : pal.ink2)
                .padding(.horizontal, 18).padding(.vertical, 11)
                .background(selected || focused ? pal.inverse : Color.clear)
                .overlay(Rectangle().strokeBorder(focused ? pal.inverse : pal.rule, lineWidth: focused ? 3 : 1))
        }
        .buttonStyle(.bare)
        .focused($focused)
        .focusEffectDisabled()
    }
}

// A compact search field for a header row: no label, just the rule under it.
struct InlineSearch: View {
    @Binding var text: String
    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 12) {
            Lab("Search", small: true)
            TextField("", text: $text)
                .textFieldStyle(.plain)
                .textInputAutocapitalization(.never)
                .font(F.med(21))
                .foregroundStyle(pal.ink)
                .focused($focused)
                .frame(width: 300)
        }
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            Rectangle().fill(focused ? pal.signal : pal.rule).frame(height: focused ? 3 : 1)
        }
    }
}

struct IndexLetter: View {
    let letter: String
    let current: Bool
    let action: () -> Void
    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) {
            Text(letter)
                .font(F.monoMed(18))
                .foregroundStyle(current ? pal.signal : (focused ? pal.ink : pal.ink3))
                .frame(width: 40, height: 32)
                .background(focused ? pal.panel2 : .clear)
        }
        .buttonStyle(.bare)
        .focused($focused)
        .focusEffectDisabled()
    }
}
