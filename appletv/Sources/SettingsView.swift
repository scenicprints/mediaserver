import SwiftUI

// ============================================================================
// Settings — sections on the left, rows on the right, label left and value right
// on a hairline. A spec sheet. Values that are actively ON read orange, so a
// screen of settings tells you what is switched on at a glance.
//
// Rows with a fixed set of choices STEP through them when you press select,
// like a rotary switch. No pickers, no popovers.
// ============================================================================

struct SettingsView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal

    enum Section: String, CaseIterable, Identifiable {
        case display, audio, subtitles, streaming, server, account
        case requests, accounts, engines, nowPlaying, about
        var id: String { rawValue }
        var label: String {
            switch self {
            case .display: return "Display"
            case .audio: return "Audio"
            case .subtitles: return "Subtitles"
            case .streaming: return "Streaming"
            case .server: return "Server"
            case .account: return "Account"
            case .requests: return "Requests"
            case .accounts: return "Accounts"
            case .engines: return "Engines"
            case .nowPlaying: return "Now Playing"
            case .about: return "About"
            }
        }
        var adminOnly: Bool {
            switch self {
            case .accounts, .engines, .nowPlaying: return true
            default: return false
            }
        }
    }

    @State private var section: Section = .display

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

    private var sections: [Section] {
        Section.allCases.filter { !$0.adminOnly || store.isAdmin }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            pal.paper.ignoresSafeArea()
            HStack(alignment: .top, spacing: 64) {
                list.frame(width: 400)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Lab(section.label)
                        detail.padding(.top, 18)
                        Color.clear.frame(height: 60)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .focusSection()
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
        .onAppear { serverField = store.serverURL }
        .task { await loadAll() }
        .fullScreenCover(isPresented: $showRequests) {
            RequestsView()
                .environmentObject(store)
                .environment(\.pal, pal)
                .onExitCommand { showRequests = false }
        }
    }

    private var list: some View {
        VStack(spacing: 0) {
            ForEach(sections) { s in
                SectionCell(title: s.label, selected: section == s) { section = s }
            }
        }
        .overlay(alignment: .top) { Rectangle().fill(pal.rule).frame(height: 1) }
        .focusSection()
    }

    // ---------------------------------------------------------------- sections

    @ViewBuilder private var detail: some View {
        switch section {
        case .display:    display
        case .audio:      audio
        case .subtitles:  subtitles
        case .streaming:  streaming
        case .server:     server
        case .account:    account
        case .requests:   requests
        case .accounts:   accounts
        case .engines:    engines
        case .nowPlaying: nowPlaying
        case .about:      about
        }
    }

    private var display: some View {
        VStack(alignment: .leading, spacing: 0) {
            rows {
                ControlRow(name: "Finish", value: store.finish.label, on: false) {
                    store.finish = store.finish == .white ? .black : .white
                }
            }
            note("White is the daytime housing. Black is the same system for a dark room. The player is always black either way — a white panel across the bottom of a film is the one place the light finish fails.")
        }
    }

    private var audio: some View {
        VStack(alignment: .leading, spacing: 0) {
            rows {
                ControlRow(name: "Output",
                           value: store.audioMode == "surround" ? "Surround 5.1" : "Stereo",
                           on: store.audioMode == "surround") {
                    store.audioMode = store.audioMode == "surround" ? "stereo" : "surround"
                }
                ControlRow(name: "Dialogue boost", value: store.dboost.capitalized,
                           on: store.dboost != "off") {
                    store.dboost = ["off": "normal", "normal": "strong", "strong": "off"][store.dboost] ?? "normal"
                }
                ControlRow(name: "Night mode", value: store.night ? "On" : "Off", on: store.night) {
                    store.night.toggle()
                }
                ControlRow(name: "Loudness normalisation", value: store.norm ? "On" : "Off", on: store.norm) {
                    store.norm.toggle()
                }
            }
            note("Surround passes Dolby Digital straight through to the receiver. Stereo folds it down on the server, which costs a transcode. Saved for this TV, and they take effect next time you start something.")
        }
    }

    private var subtitles: some View {
        VStack(alignment: .leading, spacing: 0) {
            note("Add your free OpenSubtitles account to enable subtitle search.")
            MField(prompt: "API key", text: $osKey).padding(.top, 24)
            MField(prompt: "Username", text: $osUser).padding(.top, 18)
            MField(prompt: "Password", text: $osPass, secure: true).padding(.top, 18)
            MButton(title: "Save subtitle account", kind: .primary) {
                Task { showToast(await store.saveOpenSubtitles(apiKey: osKey, username: osUser, password: osPass)) }
            }
            .padding(.top, 26)
        }
    }

    private var streaming: some View {
        VStack(alignment: .leading, spacing: 0) {
            note("Merge streaming catalogs into Movies and TV. They deep-link out to the service; nothing plays in the app.")
            if let p = providers {
                rows {
                    ForEach(p.providers) { prov in
                        let on = p.enabled.contains(prov.id)
                        ControlRow(name: prov.name, value: on ? "On" : "Off", on: on) {
                            toggleProvider(prov.id, !on)
                        }
                    }
                }
                .padding(.top, 22)
            } else {
                ProgressView().padding(.top, 30)
            }
        }
    }

    private var server: some View {
        VStack(alignment: .leading, spacing: 0) {
            MField(prompt: "Server address", text: $serverField)
            MButton(title: "Save and reconnect", kind: .primary) {
                store.serverURL = serverField.isEmpty ? Store.defaultServer : serverField
                Task { await store.loadHome() }
            }
            .padding(.top, 26)
            note("Leave it empty to go back to \(Store.defaultServer).").padding(.top, 22)
        }
    }

    private var account: some View {
        VStack(alignment: .leading, spacing: 0) {
            rows {
                ControlRow(name: "Signed in as", value: store.user?.username ?? "—")
                ControlRow(name: "Role", value: (store.user?.role ?? "").capitalized)
            }
            MButton(title: "Log out") { store.logout() }.padding(.top, 26)
        }
    }

    private var requests: some View {
        VStack(alignment: .leading, spacing: 0) {
            note("Search Radarr and Sonarr, and add movies and shows to the library.")
            MButton(title: "Open requests", kind: .primary) { showRequests = true }.padding(.top, 24)

            if store.isAdmin {
                Lab("Connection").padding(.top, 40)
                MField(prompt: "Radarr URL", text: $radarrURL).padding(.top, 18)
                MField(prompt: "Radarr API key", text: $radarrKey, secure: true).padding(.top, 18)
                MField(prompt: "Sonarr URL", text: $sonarrURL).padding(.top, 18)
                MField(prompt: "Sonarr API key", text: $sonarrKey, secure: true).padding(.top, 18)
                MButton(title: "Save and test") {
                    Task { showToast(await store.saveArr(radarrURL: radarrURL, radarrKey: radarrKey,
                                                         sonarrURL: sonarrURL, sonarrKey: sonarrKey)) }
                }
                .padding(.top, 26)
            }
        }
    }

    private var accounts: some View {
        VStack(alignment: .leading, spacing: 0) {
            rows {
                ForEach(users) { u in
                    ControlRow(name: u.username, value: u.role.capitalized) {
                        guard u.role != "admin" else { return }   // the admin can't be removed here
                        Task { await store.deleteUser(u.id); users = await store.loadUsers() }
                    }
                }
            }
            Lab("Add someone").padding(.top, 34)
            MField(prompt: "Username", text: $newUser).padding(.top, 18)
            MField(prompt: "Password", text: $newPass, secure: true).padding(.top, 18)
            MButton(title: "Add user", kind: .primary) {
                Task {
                    showToast(await store.addUser(username: newUser, password: newPass))
                    newUser = ""; newPass = ""; users = await store.loadUsers()
                }
            }
            .padding(.top, 26)
            note("Selecting a non-admin removes them.").padding(.top, 20)
        }
    }

    private var engines: some View {
        VStack(alignment: .leading, spacing: 0) {
            rows {
                ControlRow(name: "Playback engine (FFmpeg)", value: engineState(ffmpeg),
                           on: engineReady(ffmpeg)) {
                    guard !engineReady(ffmpeg) else { return }
                    Task { await store.installEngine("ffmpeg"); showToast("Install started.") }
                }
                ControlRow(name: "AI subtitles (Whisper)", value: engineState(whisper),
                           on: engineReady(whisper)) {
                    guard !engineReady(whisper) else { return }
                    Task { await store.installEngine("whisper"); showToast("Install started.") }
                }
                ControlRow(name: "Skip Intro detection", value: "Run now") {
                    Task { await store.runIntroDetect(); showToast("Intro detection started.") }
                }
            }
            Lab("Pre-roll").padding(.top, 34)
            note(prerollAvail ? "Set. It plays before every movie."
                              : "Plays before every movie. Paste the full path to the video on the server.")
                .padding(.top, 12)
            MField(prompt: #"e.g. C:\preroll\intro.mp4"#, text: $prerollPath).padding(.top, 18)
            MButton(title: "Save pre-roll") {
                Task {
                    showToast(await store.savePreroll(path: prerollPath))
                    prerollAvail = await store.prerollAvailable()
                }
            }
            .padding(.top, 26)
        }
    }

    private var nowPlaying: some View {
        VStack(alignment: .leading, spacing: 0) {
            if sessions.isEmpty {
                note("No one is watching right now.")
            } else {
                rows {
                    ForEach(sessions) { s in
                        ControlRow(name: [s.username, s.title, s.subtitle].compactMap { $0 }.joined(separator: " — "),
                                   value: s.paused == true ? "Paused"
                                        : (s.mode == "transcode" ? "Transcode" : "Direct"),
                                   on: s.paused != true)
                    }
                }
            }
            MButton(title: "Refresh") { Task { sessions = await store.loadSessions() } }.padding(.top, 26)
        }
    }

    private var about: some View {
        VStack(alignment: .leading, spacing: 0) {
            SpecGrid(cells: [
                .init(key: "Server", value: shortHost, mono: false),
                .init(key: "Version", value: version.isEmpty ? "—" : version),
                .init(key: "Library", value: "\(store.movies.count) / \(store.shows.count)"),
                .init(key: "Finish", value: store.finish.label, mono: false)
            ])
            note("Marquee for Apple TV.").padding(.top, 24)
        }
    }

    // ---------------------------------------------------------------- helpers

    @ViewBuilder private func rows<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack(spacing: 0) { content() }
            .overlay(alignment: .top) { Rectangle().fill(pal.rule).frame(height: 1) }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(F.reg(19)).lineSpacing(7).foregroundStyle(pal.ink2)
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.top, 22)
    }

    private var shortHost: String {
        URL(string: store.serverURL)?.host ?? store.serverURL
    }
    private func engineReady(_ s: EngineStatus?) -> Bool { (s?.ready ?? s?.installed) == true }
    private func engineState(_ s: EngineStatus?) -> String {
        if engineReady(s) { return "Ready" }
        if s?.installing == true { return "Installing" }
        return "Install"
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

// A section in the settings list.
private struct SectionCell: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).font(F.med(21)).foregroundStyle(selected || focused ? pal.ink : pal.ink2)
                Spacer()
            }
            .padding(.horizontal, 18).padding(.vertical, 19)
            .background(selected || focused ? pal.panel2 : .clear)
            .overlay(alignment: .leading) {
                Rectangle().fill(selected ? pal.signal : (focused ? pal.ink : .clear)).frame(width: 5)
            }
            .overlay(alignment: .bottom) { Rectangle().fill(pal.rule2).frame(height: 1) }
        }
        .buttonStyle(.bare)
        .focused($focused)
        .focusEffectDisabled()
    }
}
