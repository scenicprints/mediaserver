import SwiftUI

// ============================================================================
// Search. A fixed six-column keyboard grid rather than the tvOS ribbon, so the
// letters stay where your thumb learned them. The caret is the signal, and the
// query sits on an ink rule — a form field that has been filled in.
// Results are a grid, not a row: search results have no order to scroll along.
// ============================================================================

struct SearchView: View {
    @EnvironmentObject var store: Store
    @Environment(\.openURL) private var openURL
    @Environment(\.pal) private var pal
    @Binding var route: [Route]
    @State private var query = ""

    private let keys = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").map(String.init)
    private let keyCols = Array(repeating: GridItem(.flexible(), spacing: 0), count: 6)
    private let resultCols = Array(repeating: GridItem(.flexible(), spacing: 24), count: 5)

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    private var hits: [BrowseCard] {
        guard !trimmed.isEmpty else { return [] }
        let m = store.movies.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil }
            .map(Browse.movieCard)
        let s = store.shows.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil }
            .map(Browse.showCard)
        return (m + s).sorted { $0.title.count < $1.title.count }
    }

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            HStack(alignment: .top, spacing: 56) {
                keyboard.frame(width: 520)
                results.frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.top, 26)
        }
        .task { if store.movies.isEmpty { await store.loadHome() } }
    }

    private var keyboard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Lab("Search your library", small: true)

            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(query.isEmpty ? " " : query.lowercased())
                    .font(F.med(44)).foregroundStyle(pal.ink).lineLimit(1)
                Rectangle().fill(pal.signal).frame(width: 3, height: 40)
                Spacer(minLength: 0)
            }
            .padding(.top, 14).padding(.bottom, 14)
            .overlay(alignment: .bottom) { Rectangle().fill(pal.ink).frame(height: 2) }

            LazyVGrid(columns: keyCols, spacing: 0) {
                ForEach(keys, id: \.self) { k in
                    Key(label: k) { query.append(k) }
                }
            }
            .padding(.top, 26)
            .overlay(alignment: .top) { Rectangle().fill(pal.rule).frame(height: 1).padding(.top, 26) }
            .focusSection()

            HStack(spacing: 12) {
                MButton(title: "Space", wide: true, height: 58) { query.append(" ") }
                MButton(title: "Delete", wide: true, height: 58) {
                    if !query.isEmpty { query.removeLast() }
                }
            }
            .padding(.top, 22)
        }
    }

    private var results: some View {
        VStack(alignment: .leading, spacing: 0) {
            RowHead(title: "Results",
                    count: trimmed.isEmpty ? "\(store.movies.count + store.shows.count) in library"
                                           : "\(hits.count) of \(store.movies.count + store.shows.count)")

            if trimmed.isEmpty {
                Text("Type a title. Everything in the library is searched, owned and streaming alike.")
                    .font(F.reg(20)).foregroundStyle(pal.ink3)
                    .frame(maxWidth: 520, alignment: .leading)
                    .padding(.top, 26)
            } else if hits.isEmpty {
                Text("Nothing matches “\(trimmed)”.")
                    .font(F.reg(22)).foregroundStyle(pal.ink2).padding(.top, 26)
            } else {
                ScrollView {
                    LazyVGrid(columns: resultCols, alignment: .leading, spacing: 26) {
                        ForEach(hits) { c in
                            PosterCard(title: c.title, posterURL: c.poster, subtitle: c.subtitle,
                                       progress: c.progress, badges: c.badges,
                                       width: 186, height: 279) { tap(c) }
                        }
                    }
                    .padding(.top, 20)
                }
                .focusSection()
            }
        }
    }

    private func tap(_ c: BrowseCard) {
        if let provs = c.stream, let slug = provs.first, let url = StreamProvider.url(slug, c.title) {
            openURL(url)
        } else {
            route.append(c.route)
        }
    }
}

private struct Key: View {
    let label: String
    let action: () -> Void
    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(F.med(24))
                .foregroundStyle(focused ? pal.onInverse : pal.ink2)
                .frame(maxWidth: .infinity)
                .frame(height: 72)
                .background(focused ? pal.inverse : .clear)
                .overlay(alignment: .bottom) { Rectangle().fill(pal.rule2).frame(height: 1) }
                .overlay(alignment: .trailing) { Rectangle().fill(pal.rule2).frame(width: 1) }
        }
        .buttonStyle(.bare)
        .focused($focused)
        .focusEffectDisabled()
    }
}
