import SwiftUI

// Request new movies/shows via Radarr/Sonarr — search, then add. Degrades to a
// friendly notice if the server has no *arr configured.
struct RequestsView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
    @State private var query = ""
    @State private var results: [RequestResult] = []
    @State private var notice: String?
    @State private var toast: String?
    @State private var searching = false
    @State private var pending: RequestResult?          // awaiting a quality choice
    @State private var profiles: [ArrProfile] = []
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 22), count: 7)

    var body: some View {
        ZStack(alignment: .bottom) {
            pal.paper.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                Lab("Request something new", small: true)

                HStack(spacing: 24) {
                    MField(prompt: "Title", text: $query)
                    MButton(title: "Search", kind: .primary) { runSearch() }
                }
                .padding(.top, 14)

                if searching {
                    ProgressView().padding(.top, 40)
                } else if let notice {
                    Text(notice).font(F.reg(22)).foregroundStyle(pal.ink2).padding(.top, 34)
                } else if !results.isEmpty {
                    RowHead(title: "Results", count: "\(results.count)").padding(.top, 34)
                    ScrollView {
                        LazyVGrid(columns: columns, alignment: .leading, spacing: 26) {
                            ForEach(results) { r in
                                RequestCard(result: r) { add(r) }
                            }
                        }
                        .padding(.top, 20).padding(.bottom, 40)
                    }
                    .focusSection()
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.top, 30)

            if let toast {
                Text(toast).font(F.med(20)).foregroundStyle(pal.onSignal)
                    .padding(.horizontal, 30).padding(.vertical, 18)
                    .background(pal.signal)
                    .padding(.bottom, 50)
            }
        }
        // Quality picker: when Radarr/Sonarr have more than one profile, ask
        // which one this request should use (matches the web request flow).
        .confirmationDialog("Quality for “\(pending?.title ?? "")”",
                            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                            titleVisibility: .visible) {
            ForEach(profiles, id: \.id) { p in
                Button(p.name ?? "Profile \(p.id)") {
                    if let r = pending { submit(r, profileId: p.id) }
                    pending = nil
                }
            }
            Button("Cancel", role: .cancel) { pending = nil }
        }
    }

    private func runSearch() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        searching = true; notice = nil; results = []
        Task {
            let (res, err) = await store.requestsSearch(q)
            results = res
            notice = err ?? (res.isEmpty ? "Nothing matches “\(q)”." : nil)
            searching = false
        }
    }

    private func add(_ r: RequestResult) {
        Task {
            let p = await store.requestProfiles(for: r.type)
            if p.count > 1 { profiles = p; pending = r }   // let the user pick
            else { submit(r, profileId: p.first?.id) }
        }
    }

    private func submit(_ r: RequestResult, profileId: Int?) {
        Task {
            let msg = await store.requestAdd(r, profileId: profileId)
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
        PosterCard(title: result.title, posterURL: result.poster,
                   subtitle: result.year.map(String.init),
                   badges: [.quality(result.type == "tv" ? "TV" : "Movie")],
                   width: 186, height: 279,
                   action: action)
    }
}
