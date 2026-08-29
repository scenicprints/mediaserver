import SwiftUI

// Collections (Marvel, Star Wars, franchises…) → the collection's films.
struct CollectionsView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
    @Binding var route: [Route]
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 22), count: 8)

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                RowHead(title: "Collections", count: "\(store.collections.count)")
                    .padding(.horizontal, Theme.gutter).padding(.top, 30)

                if store.collections.isEmpty {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("No collections yet.").font(F.reg(24)).foregroundStyle(pal.ink2)
                        MButton(title: "Reload") { Task { await store.loadHome() } }
                    }
                    .padding(.horizontal, Theme.gutter).padding(.top, 40)
                }

                ScrollView {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 26) {
                        ForEach(store.collections) { col in
                            PosterCard(title: col.name, posterURL: col.poster,
                                       subtitle: col.count.map { "\($0) films" },
                                       width: 186, height: 279) {
                                route.append(.collection(col.id))
                            }
                        }
                    }
                    .padding(.horizontal, Theme.gutter).padding(.top, 22).padding(.bottom, 60)
                }
            }
        }
        .task { if store.collections.isEmpty { await store.loadHome() } }
    }
}

struct CollectionDetailView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
    @Binding var route: [Route]
    let collectionId: String

    @State private var detail: CollectionDetail?
    @State private var loading = true
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 22), count: 8)

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            if let d = detail {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ArtPlate(url: d.backdrop ?? d.poster, height: 300, title: d.name)
                            .padding(.horizontal, Theme.gutter).padding(.top, 24)

                        Text(d.name ?? "Collection")
                            .font(F.med(64)).foregroundStyle(pal.ink)
                            .padding(.horizontal, Theme.gutter).padding(.top, 22)

                        RowHead(title: "Films", count: "\(d.items.count)")
                            .padding(.horizontal, Theme.gutter).padding(.top, 24)

                        LazyVGrid(columns: columns, alignment: .leading, spacing: 26) {
                            ForEach(d.items) { movie in
                                PosterCard(title: movie.title, posterURL: movie.poster,
                                           subtitle: movie.year.map(String.init),
                                           progress: movie.progressFraction,
                                           width: 186, height: 279) {
                                    if let lid = movie.localId { route.append(.movie(lid)) }
                                }
                            }
                        }
                        .padding(.horizontal, Theme.gutter).padding(.top, 20).padding(.bottom, 60)
                    }
                }
            } else if loading {
                ProgressView().scaleEffect(1.6)
            } else {
                Text("Couldn't load this collection.").font(F.reg(24)).foregroundStyle(pal.ink2)
            }
        }
        .task {
            loading = true
            detail = await store.collectionDetail(collectionId)
            loading = false
        }
    }
}
