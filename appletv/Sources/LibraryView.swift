import SwiftUI

// The Library tab — the whole collection A→Z, toggled between Movies and TV,
// matching the web app's alphabetical Library view.
struct LibraryView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]
    @State private var kind = "movie"
    private let columns = [GridItem(.adaptive(minimum: Theme.posterWidth), spacing: Theme.cardSpacing)]

    private func sortKey(_ title: String) -> String {
        title.replacingOccurrences(of: #"^(the|a|an) "#, with: "", options: [.regularExpression, .caseInsensitive])
    }
    private var movies: [Movie] { store.movies.sorted { sortKey($0.title).localizedCaseInsensitiveCompare(sortKey($1.title)) == .orderedAscending } }
    private var shows: [Show] { store.shows.sorted { sortKey($0.title).localizedCaseInsensitiveCompare(sortKey($1.title)) == .orderedAscending } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                HStack(spacing: 16) {
                    Text("Library").font(.system(size: 52, weight: .bold))
                    Spacer()
                    ForEach(["movie", "tv"], id: \.self) { k in
                        Button(k == "movie" ? "Movies" : "TV Shows") { kind = k }
                            .buttonStyle(.borderedProminent)
                            .tint(kind == k ? Theme.accent : Color.gray.opacity(0.4))
                    }
                }
                .padding(.horizontal, Theme.gutter).padding(.top, 40)

                LazyVGrid(columns: columns, spacing: Theme.rowSpacing) {
                    if kind == "movie" {
                        ForEach(movies) { m in
                            PosterCard(title: m.title, posterURL: m.poster,
                                       subtitle: m.year.map(String.init), progress: m.progressFraction) {
                                route.append(.movie(m.id))
                            }
                        }
                    } else {
                        ForEach(shows) { s in
                            PosterCard(title: s.title, posterURL: s.poster,
                                       subtitle: s.year.map(String.init)) { route.append(.show(s.id)) }
                        }
                    }
                }
                .padding(.horizontal, Theme.gutter)
            }
            .padding(.bottom, Theme.gutter)
        }
        .task { if store.movies.isEmpty { await store.loadHome() } }
    }
}
