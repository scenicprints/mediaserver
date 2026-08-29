import SwiftUI

// Movies: the Marquee hero (movies) + the full categorized row set.
struct MoviesView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
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
            pal.paper.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 18) {
                if let e = store.error {
                    Text("Couldn't reach the library").font(F.med(30)).foregroundStyle(pal.ink)
                    Text(e).font(F.reg(20)).foregroundStyle(pal.ink2)
                } else {
                    ProgressView().scaleEffect(1.5)
                }
                MButton(title: "Retry") { Task { await store.loadHome() } }
            }
            .padding(60)
        }
    }
}
