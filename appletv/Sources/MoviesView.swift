import SwiftUI

struct MoviesView: View {
    @EnvironmentObject var store: Store
    private let columns = [GridItem(.adaptive(minimum: 240), spacing: 40)]

    var body: some View {
        ScrollView {
            if let e = store.error, store.movies.isEmpty {
                VStack(spacing: 14) {
                    Text("Couldn't load your library").font(.title2)
                    Text(e).foregroundStyle(.secondary)
                    Button("Retry") { Task { await store.loadMovies() } }
                }
                .padding(60)
            }

            LazyVGrid(columns: columns, spacing: 40) {
                ForEach(store.movies) { movie in
                    MovieCard(movie: movie)
                }
            }
            .padding(60)
        }
        .task { if store.movies.isEmpty { await store.loadMovies() } }
    }
}

struct MovieCard: View {
    let movie: Movie

    var body: some View {
        Button { } label: {
            VStack(alignment: .leading, spacing: 8) {
                AsyncImage(url: URL(string: movie.poster ?? "")) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(2.0 / 3.0, contentMode: .fit)
                    default:
                        Rectangle().fill(.gray.opacity(0.25)).aspectRatio(2.0 / 3.0, contentMode: .fit)
                    }
                }
                .cornerRadius(10)

                Text(movie.title).font(.caption).lineLimit(1)
            }
        }
        .buttonStyle(.card)
    }
}
