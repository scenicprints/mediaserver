import SwiftUI

// ============================================================================
// Entry point for the tvOS app.
//
// There is no TabView. tvOS's tab bar can't be restyled, and Marquee's rail is
// part of the design: wordmark left, tabs centred under a signal underline,
// clock and settings right, one hairline under the lot. Replacing it also
// retires the "Back exits the app from a show page" bug — Back now walks the
// NavigationStack, and at a tab's root it moves focus up to the rail.
// ============================================================================

@main
struct MediaServerApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environment(\.pal, Theme.palette(store.finish))
                // System surfaces (keyboard, alerts) follow the chosen finish.
                .preferredColorScheme(store.finish == .white ? .light : .dark)
        }
    }
}

// Navigation targets pushed within a tab's NavigationStack.
enum Route: Hashable {
    case movie(Int)
    case show(Int)
    case episode(Int, Int)     // showId, episodeId — the episode description page
    case collection(String)
}

enum Tab: String, CaseIterable, Identifiable {
    case home, movies, tv, live, library, collections, search, settings
    var id: String { rawValue }
    var label: String {
        switch self {
        case .home: return "Home"
        case .movies: return "Movies"
        case .tv: return "TV"
        case .live: return "Live"
        case .library: return "Library"
        case .collections: return "Collections"
        case .search: return "Search"
        case .settings: return "Settings"
        }
    }
    // Settings lives on the gear at the right end, not in the centre run.
    static var railTabs: [Tab] { [.home, .movies, .tv, .live, .library, .collections, .search] }
}

struct ContentView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
    @State private var tab: Tab = .home
    @State private var paths: [String: [Route]] = [:]
    @State private var previewShowId: Int?
    @FocusState private var railFocus: Tab?

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            if store.isLoggedIn {
                if let sid = previewShowId {
                    NavigationStack { ShowDetailView(showId: sid) }   // CI preview: seasons screen
                } else {
                    shell
                }
            } else {
                LoginView()
            }
        }
        .task { if await preview() == false { await store.checkSession() } }
    }

    private var shell: some View {
        VStack(spacing: 0) {
            TopRail(tab: $tab, railFocus: $railFocus)
                .focusSection()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .focusSection()
                // Back at a tab's root walks focus up to the rail. Deeper in, the
                // NavigationStack's own handler wins and pops instead; with the
                // rail focused nothing intercepts, so Back exits the app.
                .onExitCommand { railFocus = tab }
        }
        .ignoresSafeArea(edges: .bottom)
    }

    @ViewBuilder private var content: some View {
        switch tab {
        case .home:        NavTab(path: binding("home")) { HomeView(route: $0) }
        case .movies:      NavTab(path: binding("movies")) { MoviesView(route: $0) }
        case .tv:          NavTab(path: binding("tv")) { ShowsView(route: $0) }
        case .live:        LiveTVView()
        case .library:     NavTab(path: binding("library")) { LibraryView(route: $0) }
        case .collections: NavTab(path: binding("collections")) { CollectionsView(route: $0) }
        case .search:      NavTab(path: binding("search")) { SearchView(route: $0) }
        case .settings:    SettingsView()
        }
    }

    private func binding(_ id: String) -> Binding<[Route]> {
        Binding(get: { paths[id] ?? [] }, set: { paths[id] = $0 })
    }

    // CI "preview" hook: when launched with PREVIEW_* env vars (the screenshot
    // workflow), open a tab and either populate sample data from TMDB (mock, so
    // it works with the server offline) or auto-login to a real server.
    private func preview() async -> Bool {
        let env = ProcessInfo.processInfo.environment
        if let t = env["PREVIEW_TAB"], let parsed = Tab(rawValue: t == "livetv" ? "live" : t) { tab = parsed }
        if let key = env["PREVIEW_TMDB"], !key.isEmpty {
            await store.loadPreviewMock(tmdbKey: key)
            if env["PREVIEW_ROUTE"] == "show" { previewShowId = store.shows.first?.localId }
            return true
        }
        if let server = env["PREVIEW_SERVER"], !server.isEmpty {
            store.serverURL = server
            if let u = env["PREVIEW_USER"], let p = env["PREVIEW_PASS"], !store.isLoggedIn {
                await store.login(username: u, password: p)
            }
            return true
        }
        return false
    }
}

// ---------------------------------------------------------------- the rail

struct TopRail: View {
    @Binding var tab: Tab
    var railFocus: FocusState<Tab?>.Binding
    @Environment(\.pal) private var pal
    @State private var now = Date()
    private let clock = Timer.publish(every: 20, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 0) {
            MarqueeWordmark()
            Spacer(minLength: 24)
            HStack(spacing: 36) {
                ForEach(Tab.railTabs) { t in
                    RailTab(tab: t, selected: tab == t, focus: railFocus) { tab = t }
                }
            }
            Spacer(minLength: 24)
            HStack(spacing: 22) {
                Text(timeString).font(F.mono(17)).foregroundStyle(pal.ink3)
                RailGear(selected: tab == .settings, focus: railFocus) { tab = .settings }
            }
        }
        .padding(.horizontal, Theme.gutter)
        .frame(height: Theme.railHeight)
        .background(pal.panel)
        .overlay(alignment: .bottom) { Rectangle().fill(pal.rule).frame(height: 1) }
        .onReceive(clock) { now = $0 }
    }

    private var timeString: String {
        let f = DateFormatter(); f.dateFormat = "h:mm"
        return f.string(from: now)
    }
}

private struct RailTab: View {
    let tab: Tab
    let selected: Bool
    var focus: FocusState<Tab?>.Binding
    let action: () -> Void
    @Environment(\.pal) private var pal

    var body: some View {
        Button(action: action) {
            Text(tab.label.uppercased())
                .font(F.med(17)).tracking(2.8)
                .foregroundStyle(selected || focus.wrappedValue == tab ? pal.ink : pal.ink2)
                .padding(.bottom, 10)
                .overlay(alignment: .bottom) {
                    // Selected is the signal underline; focus is an ink one, so
                    // "where I am" and "what I'm about to pick" never look alike.
                    Rectangle()
                        .fill(selected ? pal.signal : (focus.wrappedValue == tab ? pal.ink : .clear))
                        .frame(height: 3)
                }
        }
        .buttonStyle(.plain)
        .focused(focus, equals: tab)
        .focusEffectDisabled()
    }
}

private struct RailGear: View {
    let selected: Bool
    var focus: FocusState<Tab?>.Binding
    let action: () -> Void
    @Environment(\.pal) private var pal

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().strokeBorder(tint, lineWidth: 2).frame(width: 28, height: 28)
                Circle().strokeBorder(tint, lineWidth: 2).frame(width: 12, height: 12)
            }
            .padding(.bottom, 10)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(selected ? pal.signal : (focus.wrappedValue == .settings ? pal.ink : .clear))
                    .frame(height: 3)
            }
        }
        .buttonStyle(.plain)
        .focused(focus, equals: .settings)
        .focusEffectDisabled()
    }
    private var tint: Color {
        selected || focus.wrappedValue == .settings ? pal.ink : pal.ink2
    }
}

// A tab whose content can push detail pages onto its own stack. The path lives
// in ContentView so navigation survives switching tabs and coming back.
struct NavTab<Content: View>: View {
    @Binding var path: [Route]
    @ViewBuilder let content: (Binding<[Route]>) -> Content

    var body: some View {
        NavigationStack(path: $path) {
            content($path)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .movie(let id): MovieDetailView(route: $path, movieId: id)
                    case .show(let id): ShowDetailView(showId: id)
                    case .episode(let sid, let eid): EpisodeRouteView(showId: sid, episodeId: eid)
                    case .collection(let id): CollectionDetailView(route: $path, collectionId: id)
                    }
                }
        }
    }
}
