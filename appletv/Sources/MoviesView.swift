import SwiftUI

// Movies: rotating Marquee hero (movies) + the full categorized row set.
struct MoviesView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]

    var body: some View {
        Group {
            if store.movies.isEmpty {
                emptyState
            } else {
                BrowseScreen(route: $route,
                             heroItems: Browse.heroFromMovies(store.movies),
                             rows: Browse.movieRows(store.movies),
                             continueKind: "movie")
            }
        }
        .task { if store.movies.isEmpty { await store.loadHome() } }
    }

    private var emptyState: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 14) {
                if let e = store.error { Text("Couldn't load your library").font(.title2); Text(e).foregroundStyle(.secondary) }
                else { ProgressView().scaleEffect(1.5) }
                Button("Retry") { Task { await store.loadHome() } }
            }.padding(60)
        }
    }
}
