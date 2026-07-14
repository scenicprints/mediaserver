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

    var body: some View {
        Group {
            if store.isLoggedIn {
                TabView {
                    NavTab { HomeView(route: $0) }.tabItem { Text("Home") }
                    NavTab { MoviesView(route: $0) }.tabItem { Text("Movies") }
                    NavTab { ShowsView(route: $0) }.tabItem { Text("TV") }
                    ComingSoon(name: "Live TV").tabItem { Text("Live TV") }
                    NavTab { CollectionsView(route: $0) }.tabItem { Text("Collections") }
                    ComingSoon(name: "Requests").tabItem { Text("Requests") }
                    NavTab { SearchView(route: $0) }.tabItem { Text("Search") }
                    SettingsView().tabItem { Text("Settings") }
                }
            } else {
                LoginView()
            }
        }
        .task { await store.checkSession() }
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
                    case .movie(let id): MovieDetailView(movieId: id)
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
