import SwiftUI

// Entry point for the tvOS app. Talks to the existing media-server HTTP API
// (the same /api/* endpoints the web UI uses). The native tvOS focus engine
// (.card button style, LazyVGrid/HStack) gives D-pad navigation + scale/parallax
// for free, so we don't port public/focus.js.
@main
struct MediaServerApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(store)
                .preferredColorScheme(.dark)
        }
    }
}

// Navigation targets pushed within a tab's NavigationStack.
enum Route: Hashable {
    case movie(Int)
    case show(Int)
    case collection(String)
}

struct ContentView: View {
    @EnvironmentObject var store: Store
    @State private var tab = "home"

    var body: some View {
        Group {
            if store.isLoggedIn {
                TabView(selection: $tab) {
                    NavTab { HomeView(route: $0) }.tabItem { Text("Home") }.tag("home")
                    NavTab { MoviesView(route: $0) }.tabItem { Text("Movies") }.tag("movies")
                    NavTab { ShowsView(route: $0) }.tabItem { Text("TV") }.tag("tv")
                    LiveTVView().tabItem { Text("Live TV") }.tag("livetv")
                    NavTab { LibraryView(route: $0) }.tabItem { Text("Library") }.tag("library")
                    NavTab { CollectionsView(route: $0) }.tabItem { Text("Collections") }.tag("collections")
                    RequestsView().tabItem { Text("Requests") }.tag("requests")
                    NavTab { SearchView(route: $0) }.tabItem { Text("Search") }.tag("search")
                    SettingsView().tabItem { Text("Settings") }.tag("settings")
                }
            } else {
                LoginView()
            }
        }
        .task { await preview(); await store.checkSession() }
    }

    // CI "preview" hook: when launched with PREVIEW_* env vars (the screenshot
    // workflow), point at the given server, auto-login, and open a tab — so the
    // cloud Mac can screenshot real screens without TestFlight.
    private func preview() async {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["PREVIEW_SERVER"], !server.isEmpty else { return }
        store.serverURL = server
        if let t = env["PREVIEW_TAB"] { tab = t }
        if let u = env["PREVIEW_USER"], let p = env["PREVIEW_PASS"], !store.isLoggedIn {
            await store.login(username: u, password: p)
        }
    }
}

// A tab whose content can push movie detail pages onto its own stack.
struct NavTab<Content: View>: View {
    @ViewBuilder let content: (Binding<[Route]>) -> Content
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            content($path)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .movie(let id): MovieDetailView(route: $path, movieId: id)
                    case .show(let id): ShowDetailView(showId: id)
                    case .collection(let id): CollectionDetailView(route: $path, collectionId: id)
                    }
                }
        }
    }
}

// Placeholder for tabs whose native UI lands in a later parity pass.
struct ComingSoon: View {
    let name: String
    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "tv").font(.system(size: 72)).foregroundStyle(Theme.accent)
                Text(name).font(.largeTitle).fontWeight(.bold)
                Text("Coming in the next Marquee update.").foregroundStyle(.secondary)
            }
        }
    }
}
