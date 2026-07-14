import SwiftUI

// The Library tab — the whole collection A→Z, toggled Movies/TV, with an
// alphabet rail that jumps to any letter (matching the web Library view).
struct LibraryView: View {
    @EnvironmentObject var store: Store
    @Binding var route: [Route]
    @State private var kind = "movie"
    private let columns = [GridItem(.adaptive(minimum: Theme.posterWidth), spacing: Theme.cardSpacing)]

    private struct LibItem: Identifiable { let id: String; let title: String; let poster: String?; let sub: String?; let progress: Double; let route: Route }

    private func sortKey(_ title: String) -> String {
        title.replacingOccurrences(of: #"^(the|a|an) "#, with: "", options: [.regularExpression, .caseInsensitive])
    }
    private func letter(_ title: String) -> String {
        let c = sortKey(title).uppercased().first.map(String.init) ?? "#"
        return (c >= "A" && c <= "Z") ? c : "#"
    }

    private var items: [LibItem] {
        if kind == "movie" {
            return store.movies.filter { !$0.isStream }.map {
                LibItem(id: "m\($0.id)", title: $0.title, poster: $0.poster,
                        sub: $0.year.map(String.init), progress: $0.progressFraction,
                        route: .movie($0.localId ?? 0))
            }.sorted { sortKey($0.title).localizedCaseInsensitiveCompare(sortKey($1.title)) == .orderedAscending }
        } else {
            return store.shows.filter { !$0.isStream }.map {
                LibItem(id: "s\($0.id)", title: $0.title, poster: $0.poster,
                        sub: $0.year.map(String.init), progress: 0, route: .show($0.localId ?? 0))
            }.sorted { sortKey($0.title).localizedCaseInsensitiveCompare(sortKey($1.title)) == .orderedAscending }
        }
    }
    private var groups: [(String, [LibItem])] {
        Dictionary(grouping: items, by: { letter($0.title) })
            .sorted { $0.key < $1.key }
    }
    private var presentLetters: Set<String> { Set(items.map { letter($0.title) }) }
    private let alphabet: [String] = ["#"] + (65...90).map { String(UnicodeScalar($0)) }

    var body: some View {
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 16) {
                    Text("Library").font(.system(size: 46, weight: .bold))
                    Spacer()
                    ForEach(["movie", "tv"], id: \.self) { k in
                        Button(k == "movie" ? "Movies" : "TV Shows") { kind = k }
                            .buttonStyle(.borderedProminent)
                            .tint(kind == k ? Theme.accent : Color.gray.opacity(0.4))
                    }
                }
                .padding(.horizontal, Theme.gutter).padding(.top, 40).padding(.bottom, 18)

                // Alphabet rail — jump to a letter.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(alphabet, id: \.self) { L in
                            let has = presentLetters.contains(L)
                            Button(L) { if has { withAnimation { proxy.scrollTo(L, anchor: .top) } } }
                                .buttonStyle(.bordered)
                                .tint(Theme.accent)
                                .disabled(!has)
                                .opacity(has ? 1 : 0.3)
                        }
                    }
                    .padding(.horizontal, Theme.gutter).padding(.vertical, 6)
                }

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 30, pinnedViews: [.sectionHeaders]) {
                        ForEach(groups, id: \.0) { L, list in
                            Section {
                                LazyVGrid(columns: columns, spacing: Theme.rowSpacing) {
                                    ForEach(list) { it in
                                        PosterCard(title: it.title, posterURL: it.poster,
                                                   subtitle: it.sub, progress: it.progress) {
                                            route.append(it.route)
                                        }
                                    }
                                }
                                .padding(.horizontal, Theme.gutter)
                            } header: {
                                Text(L).font(.title).fontWeight(.heavy).foregroundStyle(Theme.accentSoft)
                                    .padding(.horizontal, Theme.gutter).padding(.vertical, 8)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Theme.bg.opacity(0.95))
                                    .id(L)
                            }
                        }
                    }
                    .padding(.bottom, Theme.gutter)
                }
            }
        }
        .task { if store.movies.isEmpty { await store.loadHome() } }
    }
}
