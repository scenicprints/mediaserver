import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var store: Store
    @State private var url = ""

    var body: some View {
        Form {
            Section("Account") {
                if let u = store.user {
                    Text("Signed in as \(u.username)")
                }
                Button("Log out", role: .destructive) { store.logout() }
            }
            Section("Server") {
                TextField("https://marqu33.duckdns.org", text: $url)
                    .textInputAutocapitalization(.never)
                Button("Save & reconnect") {
                    store.serverURL = url.isEmpty ? Store.defaultServer : url
                    Task { await store.loadMovies() }
                }
            }
        }
        .onAppear { url = store.serverURL }
    }
}

// Hex color helper (matches the web UI's accent palette).
extension Color {
    init(hex: UInt) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255.0,
                  green: Double((hex >> 8) & 0xff) / 255.0,
                  blue: Double(hex & 0xff) / 255.0,
                  opacity: 1.0)
    }
}
