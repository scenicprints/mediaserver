import SwiftUI

// Full Settings — mirrors the web settings sheet. Viewer sections for everyone;
// server-admin sections gated behind isAdmin (same as the web .admin-only class).
struct SettingsView: View {
    @EnvironmentObject var store: Store

    // Form state
    @State private var serverField = ""
    @State private var osKey = ""
    @State private var osUser = ""
    @State private var osPass = ""
    @State private var radarrURL = ""
    @State private var radarrKey = ""
    @State private var sonarrURL = ""
    @State private var sonarrKey = ""
    @State private var prerollPath = ""
    @State private var prerollAvail = false
    @State private var newUser = ""
    @State private var newPass = ""
    // Loaded data
    @State private var providers: ProvidersResponse?
    @State private var users: [UserRow] = []
    @State private var sessions: [AdminSession] = []
    @State private var ffmpeg: EngineStatus?
    @State private var whisper: EngineStatus?
    @State private var version = ""
    @State private var toast: String?
    @State private var showRequests = false

    var body: some View {
        ZStack(alignment: .bottom) {
            Theme.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    Text("Settings").font(.system(size: 56, weight: .bold))
                        .padding(.horizontal, Theme.gutter).padding(.top, 40)

                    account
                    requests
                    audio
                    subtitles
                    streaming
                    server
                    if store.isAdmin { adminSections }
                    about
                }
                .frame(maxWidth: 1500, alignment: .leading)
                .padding(.bottom, Theme.gutter)
            }
            if let toast {
                Text(toast).font(.headline).padding(.horizontal, 28).padding(.vertical, 16)
                    .background(.ultraThinMaterial, in: Capsule()).padding(.bottom, 50)
            }
        }
        .onAppear { serverField = store.serverURL }
        .task { await loadAll() }
        .fullScreenCover(isPresented: $showRequests) {
            ZStack(alignment: .topTrailing) {
                RequestsView()
                Button { showRequests = false } label: {
                    Label("Done", systemImage: "xmark").padding(.horizontal, 10)
                }
                .buttonStyle(.bordered).padding(Theme.gutter)
            }
            .onExitCommand { showRequests = false }
        }
    }

    private var requests: some View {
        SettingsCard("Requests") {
            Text("Search Radarr/Sonarr and add movies & shows to your library.")
                .font(.callout).foregroundStyle(.secondary)
            Button { showRequests = true } label: {
                Label("Open Requests", systemImage: "plus.magnifyingglass")
            }.buttonStyle(.borderedProminent).tint(Theme.accent)
        }
    }

    // ---- Viewer sections ----
    private var account: some View {
        SettingsCard("Account") {
            if let u = store.user {
                Text("Signed in as \(u.username)").font(.title3)
                Text(u.role.capitalized).font(.caption).foregroundStyle(.secondary)
            }
            Button("Log out", role: .destructive) { store.logout() }.buttonStyle(.bordered).padding(.top, 6)
        }
    }

    private var audio: some View {
        SettingsCard("Audio") {
            Text("Saved for this TV — take effect next time you start something.")
                .font(.callout).foregroundStyle(.secondary)
            seg("Output", ["Stereo": "stereo", "Surround": "surround"],
                get: store.audioMode) { store.audioMode = $0 }
            seg("Dialogue boost", ["Off": "off", "Normal": "normal", "Strong": "strong"],
                get: store.dboost) { store.dboost = $0 }
            seg("Night mode", ["Off": "0", "On": "1"],
                get: store.night ? "1" : "0") { store.night = $0 == "1" }
            seg("Loudness normalization", ["Off": "0", "On": "1"],
                get: store.norm ? "1" : "0") { store.norm = $0 == "1" }
        }
    }

    private var subtitles: some View {
        SettingsCard("Subtitle account (OpenSubtitles)") {
            Text("Add your free OpenSubtitles account to enable subtitle search.")
                .font(.callout).foregroundStyle(.secondary)
            field("API key", $osKey)
            field("Username", $osUser)
            secure("Password", $osPass)
            Button("Save subtitle account") {
                Task { showToast(await store.saveOpenSubtitles(apiKey: osKey, username: osUser, password: osPass)) }
            }.buttonStyle(.borderedProminent).tint(Theme.accent)
        }
    }

    private var streaming: some View {
        SettingsCard("Streaming services") {
            Text("Merge streaming catalogs into Movies & TV. They deep-link out (no in-app play).")
                .font(.callout).foregroundStyle(.secondary)
            if let p = providers {
                ForEach(p.providers) { prov in
                    Toggle(prov.name, isOn: Binding(
                        get: { p.enabled.contains(prov.id) },
                        set: { on in toggleProvider(prov.id, on) }))
                }
            } else { ProgressView() }
        }
    }

    private var server: some View {
        SettingsCard("Server") {
            field("https://marqu33.duckdns.org", $serverField)
            Button("Save & reconnect") {
                store.serverURL = serverField.isEmpty ? Store.defaultServer : serverField
                Task { await store.loadHome() }
            }.buttonStyle(.borderedProminent).tint(Theme.accent)
        }
    }

    // ---- Admin sections ----
    @ViewBuilder private var adminSections: some View {
        SettingsCard("Requests (Radarr & Sonarr)") {
            Text("Connect Radarr (movies) and Sonarr (TV) to request titles.")
                .font(.callout).foregroundStyle(.secondary)
            field("Radarr URL", $radarrURL); secure("Radarr API key", $radarrKey)
            field("Sonarr URL", $sonarrURL); secure("Sonarr API key", $sonarrKey)
            Button("Save & test connection") {
                Task { showToast(await store.saveArr(radarrURL: radarrURL, radarrKey: radarrKey, sonarrURL: sonarrURL, sonarrKey: sonarrKey)) }
            }.buttonStyle(.borderedProminent).tint(Theme.accent)
        }

        SettingsCard("Pre-roll video") {
            Text(prerollAvail ? "Pre-roll is set — plays before every movie." : "Plays before every movie. Paste the full path to the video on the server.")
                .font(.callout).foregroundStyle(prerollAvail ? .green : .secondary)
            field(#"e.g. C:\preroll\intro.mp4"#, $prerollPath)
            Button("Save pre-roll") {
                Task { showToast(await store.savePreroll(path: prerollPath)); prerollAvail = await store.prerollAvailable() }
            }.buttonStyle(.borderedProminent).tint(Theme.accent)
        }

        SettingsCard("Accounts") {
            ForEach(users) { u in
                HStack {
                    Text(u.username); Text(u.role).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if u.role != "admin" {
                        Button(role: .destructive) { Task { await store.deleteUser(u.id); users = await store.loadUsers() } }
                            label: { Image(systemName: "trash") }.buttonStyle(.bordered)
                    }
                }
            }
            field("Username", $newUser); secure("Password", $newPass)
            Button("Add user") {
                Task { showToast(await store.addUser(username: newUser, password: newPass)); newUser = ""; newPass = ""; users = await store.loadUsers() }
            }.buttonStyle(.borderedProminent).tint(Theme.accent)
        }

        engineCard("Playback engine (FFmpeg)", status: ffmpeg, path: "ffmpeg")
        engineCard("AI subtitles (Whisper)", status: whisper, path: "whisper")

        SettingsCard("Skip Intro detection") {
            Button("Detect intros now") { Task { await store.runIntroDetect(); showToast("Intro detection started.") } }
                .buttonStyle(.bordered)
        }

        SettingsCard("Now Playing") {
            if sessions.isEmpty {
                Text("No one is watching right now.").foregroundStyle(.secondary)
            } else {
                ForEach(sessions) { s in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(s.username ?? "?").fontWeight(.semibold)
                            Text(s.mode == "transcode" ? "⚙ Transcode" : "▶ Direct").font(.caption).foregroundStyle(.secondary)
                            if s.paused == true { Text("Paused").font(.caption).foregroundStyle(.orange) }
                        }
                        Text([s.title, s.subtitle].compactMap { $0 }.joined(separator: " — ")).font(.callout)
                    }
                    .padding(.vertical, 4)
                }
            }
            Button("Refresh") { Task { sessions = await store.loadSessions() } }.buttonStyle(.bordered).padding(.top, 4)
        }
    }

    private func engineCard(_ title: String, status: EngineStatus?, path: String) -> some View {
        SettingsCard(title) {
            let ready = (status?.ready ?? status?.installed) == true
            let installing = status?.installing == true
            Text(ready ? "Installed and ready." : installing ? "Installing…" : "Not installed.")
                .font(.callout).foregroundStyle(ready ? .green : .secondary)
            if !ready && !installing {
                Button("Install") { Task { await store.installEngine(path); showToast("Install started.") } }
                    .buttonStyle(.borderedProminent).tint(Theme.accent)
            }
        }
    }

    private var about: some View {
        SettingsCard("About") {
            Text(version.isEmpty ? "Marquee for Apple TV" : "Server version \(version)")
                .foregroundStyle(.secondary)
        }
    }

    // ---- Helpers ----
    @ViewBuilder
    private func seg(_ title: String, _ options: [String: String], get: String, set: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            HStack(spacing: 14) {
                ForEach(options.sorted(by: { $0.value < $1.value }), id: \.key) { label, value in
                    Button(label) { set(value) }
                        .buttonStyle(.borderedProminent)
                        .tint(get == value ? Theme.accent : Color.gray.opacity(0.4))
                }
            }
        }
    }
    private func field(_ prompt: String, _ text: Binding<String>) -> some View {
        TextField(prompt, text: text).textFieldStyle(.plain)
            .textInputAutocapitalization(.never).font(.title3)
            .padding(12).background(Theme.bg, in: RoundedRectangle(cornerRadius: 8))
    }
    private func secure(_ prompt: String, _ text: Binding<String>) -> some View {
        SecureField(prompt, text: text).textFieldStyle(.plain).font(.title3)
            .padding(12).background(Theme.bg, in: RoundedRectangle(cornerRadius: 8))
    }
    private func toggleProvider(_ id: String, _ on: Bool) {
        guard let p = providers else { return }
        var enabled = p.enabled
        if on { if !enabled.contains(id) { enabled.append(id) } } else { enabled.removeAll { $0 == id } }
        providers = ProvidersResponse(providers: p.providers, enabled: enabled, local: p.local)
        Task { await store.saveProviders(enabled: enabled, local: p.local) }
    }
    private func showToast(_ m: String) {
        withAnimation { toast = m }
        Task { try? await Task.sleep(nanoseconds: 3_000_000_000); withAnimation { toast = nil } }
    }
    private func loadAll() async {
        providers = await store.loadProviders()
        version = await store.serverVersion() ?? ""
        if store.isAdmin {
            users = await store.loadUsers()
            prerollAvail = await store.prerollAvailable()
            ffmpeg = await store.engineStatus("ffmpeg")
            whisper = await store.engineStatus("whisper")
            sessions = await store.loadSessions()
        }
    }
}

// A titled settings card, matching the web app's "sub-account" blocks.
struct SettingsCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title; self.content = content
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.title2).fontWeight(.semibold)
            content()
        }
        .padding(32)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18))
        .padding(.horizontal, Theme.gutter)
    }
}
