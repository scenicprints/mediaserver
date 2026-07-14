import SwiftUI

// Collections grid (Marvel, Star Wars, franchises…) → the collection's films.
struct CollectionsView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]
    private let columns = [GridItem(.adaptive(minimum: Theme.posterWidth), spacing: Theme.cardSpacing)]

    var body: some View {
        ScrollView {
            if store.collections.isEmpty {
                VStack(spacing: 14) {
                    Text("No collections yet").font(.title2)
                    Button("Reload") { Task { await store.loadHome() } }
                }.padding(60)
            }
            LazyVGrid(columns: columns, spacing: Theme.rowSpacing) {
                ForEach(store.collections) { col in
                    PosterCard(title: col.name, posterURL: col.poster,
                               subtitle: col.count.map { "\($0) films" }) {
                        route.append(.collection(col.id))
                    }
                }
            }
            .padding(Theme.gutter)
        }
        .task { if store.collections.isEmpty { await store.loadHome() } }
    }
}

struct CollectionDetailView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]
    let collectionId: String

    @State private var detail: CollectionDetail?
    @State private var loading = true
    private let columns = [GridItem(.adaptive(minimum: Theme.posterWidth), spacing: Theme.cardSpacing)]

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if let d = detail {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ZStack(alignment: .bottomLeading) {
                            ArtImage(url: d.backdrop ?? d.poster, aspect: 16.0 / 9.0)
                                .frame(height: 520).frame(maxWidth: .infinity).clipped()
                                .overlay {
                                    LinearGradient(colors: [.clear, Theme.bg.opacity(0.6), Theme.bg],
                                                   startPoint: .top, endPoint: .bottom)
                                }
                            Text(d.name ?? "Collection")
                                .font(.system(size: 58, weight: .bold)).shadow(radius: 10)
                                .padding(.horizontal, Theme.gutter).padding(.bottom, 36)
                        }
                        LazyVGrid(columns: columns, spacing: Theme.rowSpacing) {
                            ForEach(d.items) { movie in
                                PosterCard(title: movie.title, posterURL: movie.poster,
                                           subtitle: movie.year.map(String.init),
                                           progress: movie.progressFraction) {
                                    if let lid = movie.localId { route.append(.movie(lid)) }
                                }
                            }
                        }
                        .padding(Theme.gutter)
                    }
                }
                .ignoresSafeArea(edges: .top)
            } else if loading {
                ProgressView().scaleEffect(1.6)
            } else {
                Text("Couldn't load this collection.").foregroundStyle(.secondary)
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .task {
            loading = true
            detail = await store.collectionDetail(collectionId)
            loading = false
        }
    }
}
