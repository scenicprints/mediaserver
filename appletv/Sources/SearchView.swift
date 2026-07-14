import SwiftUI

// Search across the already-loaded library (movies + shows), filtered live as
// you type on the tvOS keyboard. Selecting a result opens its detail page.
struct SearchView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]
    @State private var query = ""
    private let columns = [GridItem(.adaptive(minimum: Theme.posterWidth), spacing: Theme.cardSpacing)]

    private var movieHits: [Movie] {
        guard !trimmed.isEmpty else { return [] }
        return store.movies.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil }
    }
    private var showHits: [Show] {
        guard !trimmed.isEmpty else { return [] }
        return store.shows.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil }
    }
    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                TextField("Search movies & shows", text: $query)
                    .textFieldStyle(.plain)
                    .font(.title2)
                    .padding(.horizontal, Theme.gutter).padding(.top, 40)

                if trimmed.isEmpty {
                    Text("Start typing to search your library.")
                        .foregroundStyle(.secondary).padding(.horizontal, Theme.gutter)
                } else if movieHits.isEmpty && showHits.isEmpty {
                    Text("No matches for “\(trimmed)”.")
                        .foregroundStyle(.secondary).padding(.horizontal, Theme.gutter)
                }

                if !movieHits.isEmpty {
                    section("Movies") {
                        ForEach(movieHits) { m in
                            PosterCard(title: m.title, posterURL: m.poster,
                                       subtitle: m.year.map(String.init),
                                       progress: m.progressFraction) { if let lid = m.localId { route.append(.movie(lid)) } }
                        }
                    }
                }
                if !showHits.isEmpty {
                    section("TV Shows") {
                        ForEach(showHits) { s in
                            PosterCard(title: s.title, posterURL: s.poster,
                                       subtitle: s.year.map(String.init)) { if let lid = s.localId { route.append(.show(lid)) } }
                        }
                    }
                }
            }
            .padding(.bottom, Theme.gutter)
        }
        .task { if store.movies.isEmpty { await store.loadHome() } }
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(title).font(.title2).fontWeight(.semibold).padding(.leading, Theme.gutter)
            LazyVGrid(columns: columns, spacing: Theme.rowSpacing) { content() }
                .padding(.horizontal, Theme.gutter)
        }
    }
}
