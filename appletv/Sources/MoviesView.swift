import SwiftUI

// The full Movies library as a poster grid. Selecting a poster pushes the
// cinematic detail page (which handles playback).
struct MoviesView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]
    private let columns = [GridItem(.adaptive(minimum: Theme.posterWidth), spacing: Theme.cardSpacing)]

    var body: some View {
        ScrollView {
            if let e = store.error, store.movies.isEmpty {
                VStack(spacing: 14) {
                    Text("Couldn't load your library").font(.title2)
                    Text(e).foregroundStyle(.secondary)
                    Button("Retry") { Task { await store.loadHome() } }
                }
                .padding(60)
            }

            LazyVGrid(columns: columns, spacing: Theme.rowSpacing) {
                ForEach(store.movies) { movie in
                    PosterCard(title: movie.title, posterURL: movie.poster,
                               subtitle: movie.year.map(String.init),
                               progress: movie.progressFraction) {
                        route.append(.movie(movie.id))
                    }
                }
            }
            .padding(Theme.gutter)
        }
        .task { if store.movies.isEmpty { await store.loadHome() } }
    }
}
