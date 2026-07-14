import SwiftUI

// Request new movies/shows via Radarr/Sonarr — search, then add. Degrades to a
// friendly notice if the server has no *arr configured.
struct RequestsView: View {
    @EnvironmentObject var store: Store
    @State private var query = ""
    @State private var results: [RequestResult] = []
    @State private var notice: String?
    @State private var toast: String?
    @State private var searching = false
    private let columns = [GridItem(.adaptive(minimum: Theme.posterWidth), spacing: Theme.cardSpacing)]

    var body: some View {
        ZStack(alignment: .bottom) {
            Theme.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Request").font(.largeTitle).fontWeight(.bold)
                        HStack(spacing: 20) {
                            TextField("Search for a movie or show to add", text: $query)
                                .textFieldStyle(.plain).font(.title3)
                                .onSubmit { runSearch() }
                            Button("Search") { runSearch() }
                                .buttonStyle(.borderedProminent).tint(Theme.accent)
                        }
                    }
                    .padding(.horizontal, Theme.gutter).padding(.top, 40)

                    if searching {
                        ProgressView().padding(.horizontal, Theme.gutter)
                    } else if let notice {
                        Text(notice).foregroundStyle(.secondary).padding(.horizontal, Theme.gutter)
                    } else if !results.isEmpty {
                        LazyVGrid(columns: columns, spacing: Theme.rowSpacing) {
                            ForEach(results) { r in
                                RequestCard(result: r) { add(r) }
                            }
                        }
                        .padding(.horizontal, Theme.gutter)
                    }
                }
                .padding(.bottom, Theme.gutter)
            }

            if let toast {
                Text(toast)
                    .font(.headline).padding(.horizontal, 28).padding(.vertical, 16)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 60)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }

    private func runSearch() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        searching = true; notice = nil; results = []
        Task {
            let (res, err) = await store.requestsSearch(q)
            results = res
            notice = err ?? (res.isEmpty ? "No results for “\(q)”." : nil)
            searching = false
        }
    }

    private func add(_ r: RequestResult) {
        Task {
            let msg = await store.requestAdd(r)
            showToast(msg)
        }
    }

    private func showToast(_ msg: String) {
        withAnimation { toast = msg }
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            withAnimation { toast = nil }
        }
    }
}

struct RequestCard: View {
    let result: RequestResult
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                ArtImage(url: result.poster, aspect: 2.0 / 3.0)
                    .frame(width: Theme.posterWidth, height: Theme.posterHeight)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.posterRadius))
                    .overlay(alignment: .topTrailing) {
                        Text(result.type == "tv" ? "TV" : "Movie")
                            .font(.caption2).fontWeight(.bold)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Theme.accent, in: Capsule())
                            .padding(10)
                    }
                    .overlay(alignment: .bottomLeading) {
                        Label("Request", systemImage: "plus.circle.fill")
                            .font(.caption).padding(8)
                            .background(.black.opacity(0.5), in: Capsule()).padding(8)
                    }
                Text(result.title).font(.callout).fontWeight(.medium).lineLimit(1)
                    .frame(width: Theme.posterWidth, alignment: .leading)
                if let y = result.year {
                    Text(String(y)).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.card)
    }
}
