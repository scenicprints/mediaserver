import SwiftUI

// Home: the rotating Marquee hero (mixed, by rating) over the full row set.
struct HomeView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]

    var body: some View {
        BrowseScreen(route: $route,
                     heroItems: Browse.heroMixed(store.movies, store.shows),
                     rows: Browse.homeRows(store.movies, store.shows),
                     continueKind: nil)
            .task { if store.movies.isEmpty { await store.loadHome() } }
    }
}
