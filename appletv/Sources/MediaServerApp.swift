import SwiftUI

// Entry point for the tvOS app. This talks to the existing media-server HTTP
// API (the same `/api/*` endpoints the web UI uses) — nothing new server-side
// is required for this first build. The native tvOS focus engine (Button
// `.card` style, LazyVGrid) gives us D-pad navigation + scale/parallax for
// free, so we don't port `public/focus.js`.
@main
struct MediaServerApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        Group {
            if store.isLoggedIn {
                TabView {
                    MoviesView()
                        .tabItem { Text("Movies") }
                    SettingsView()
                        .tabItem { Text("Settings") }
                }
            } else {
                LoginView()
            }
        }
        .task { await store.checkSession() }
    }
}
