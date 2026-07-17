import SwiftUI
import UIKit
import AVKit
import AVFoundation
import CoreMedia
import VLCKitSPM

// One upcoming episode for the in-player "Up Next" autoplay queue.
struct UpNextItem: Identifiable, Hashable {
    let id = UUID()
    let fileId: Int
    let ref: Store.PlayRef
    let title: String
    let subtitle: String?
    let still: String?
    let duration: Double?
}

// A fully-resolved playback request.
struct PlaySession: Identifiable {
    let id = UUID()
    let url: URL
    let ref: Store.PlayRef
    let duration: Double?
    let startAt: Double
    let title: String
    var subtitle: String? = nil
    var fileId: Int? = nil
    var preroll: URL? = nil
    var live: Bool = false
    var upNext: [UpNextItem] = []
}

extension PlayerView {
    init(session: PlaySession, store: Store) {
        self.init(url: session.url, startAt: session.startAt, ref: session.ref,
                  duration: session.duration, store: store, prerollURL: session.preroll,
                  title: session.title, subtitle: session.subtitle,
                  fileId: session.fileId, live: session.live, upNext: session.upNext)
    }
}

// MARK: - Player screen (SwiftUI over VLCKit)

struct PlayerView: View {
    let url: URL
    let startAt: Double
    let ref: Store.PlayRef
    let duration: Double?
    let store: Store
    var prerollURL: URL? = nil
    var title: String = ""
    var subtitle: String? = nil
    var fileId: Int? = nil
    var live: Bool = false
    var upNext: [UpNextItem] = []

    @Environment(\.dismiss) private var dismiss
    @StateObject private var m = PlayerModel()
    @FocusState private var focus: PlayerFocus?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VLCVideoView(model: m).ignoresSafeArea()

            // Bottom scrim so controls read against bright video.
            if m.controlsVisible || m.menu != .none {
                LinearGradient(colors: [.clear, .black.opacity(0.85)],
                               startPoint: .center, endPoint: .bottom)
                    .ignoresSafeArea().allowsHitTesting(false)
            }

            // The invisible full-screen surface owns the remote when no overlay is up:
            // click = play/pause, swipe L/R = seek, swipe up = show controls.
            // Owns the remote only when no controls/menus/prompts are up, so focus
            // can move to the buttons the rest of the time.
            Button(action: { m.togglePlay(); m.flashControls() }) { Color.clear }
                .buttonStyle(.plain)
                .focused($focus, equals: .surface)
                .disabled(m.controlsVisible || m.menu == .subs || m.menu == .audio || m.showSkipIntro || m.showUpNext)
                .onMoveCommand { dir in
                    switch dir {
                    case .left: m.jump(-10); m.flashControls()
                    case .right: m.jump(10); m.flashControls()
                    default: m.flashControls()
                    }
                }

            overlay
        }
        .onExitCommand {
            if m.menu != .none { m.menu = .none; m.controlsVisible = false; focus = .surface }
            else if m.controlsVisible { m.controlsVisible = false; focus = .surface }
            else { m.teardown(); dismiss() }
        }
        .onAppear {
            m.bind(store: store)
            m.start(url: url, startAt: startAt, ref: ref, kind: kind, duration: duration,
                    title: title, subtitle: subtitle, fileId: fileId, live: live,
                    preroll: prerollURL, upNext: upNext, window: nil)
            focus = .surface
        }
        .onDisappear { m.teardown() }
        .onChange(of: m.controlsVisible) { vis in
            if vis { if focus != .skip && focus != .upNext { focus = .control(0) } }
            else if m.menu == .none && !m.showSkipIntro && !m.showUpNext { focus = .surface }
        }
        .onChange(of: m.showSkipIntro) { on in if on { focus = .skip } else if focus == .skip { focus = m.controlsVisible ? .control(0) : .surface } }
        .onChange(of: m.showUpNext) { on in if on { focus = .upNext } else if focus == .upNext { focus = m.controlsVisible ? .control(0) : .surface } }
        .onChange(of: m.finishedPlayback) { done in if done { m.teardown(); dismiss() } }
    }

    private var kind: String { if case .episode = ref { return "episode" }; return "movie" }

    @ViewBuilder private var overlay: some View {
        VStack(alignment: .leading) {
            // Title (top) when controls are up.
            if m.controlsVisible || m.menu != .none {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.system(size: 42, weight: .bold)).foregroundStyle(.white)
                    if let s = subtitle { Text(s).font(.title3).foregroundStyle(Theme.muted) }
                }
                .shadow(radius: 10)
                .padding(.top, 60).padding(.leading, Theme.gutter)
                .transition(.opacity)
            }
            Spacer()

            // Info panel / menus.
            if m.menu == .info { infoPanel.padding(.leading, Theme.gutter).padding(.bottom, 20) }
            if m.menu == .subs { trackMenu("Subtitles", m.subtitleOptions, m.currentSubtitle) { m.selectSubtitle($0) } }
            if m.menu == .audio { trackMenu("Audio", m.audioOptions, m.currentAudio) { m.selectAudio($0) } }

            // Skip Intro + Up Next (focusable, bottom-trailing).
            HStack {
                Spacer()
                if m.showSkipIntro {
                    Button { m.skipIntro() } label: { pill("Skip Intro", "forward.end.fill") }
                        .buttonStyle(.plain).focused($focus, equals: .skip)
                }
                if m.showUpNext, let n = m.upNextItem {
                    Button { m.playNext() } label: { upNextCard(n) }
                        .buttonStyle(.plain).focused($focus, equals: .upNext)
                }
            }
            .padding(.trailing, Theme.gutter).padding(.bottom, 24)

            // Transport bar.
            if m.controlsVisible { transportBar.transition(.move(edge: .bottom).combined(with: .opacity)) }
        }
        .animation(.easeInOut(duration: 0.25), value: m.controlsVisible)
        .animation(.easeInOut(duration: 0.2), value: m.menu)
    }

    private var transportBar: some View {
        VStack(spacing: 14) {
            // Scrubber.
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.22)).frame(height: 8)
                    Capsule().fill(Theme.grad)
                        .frame(width: max(0, geo.size.width * m.progress), height: 8)
                }
            }
            .frame(height: 8)

            HStack {
                Text(m.clock(m.position)).foregroundStyle(.white)
                Spacer()
                // Control buttons.
                HStack(spacing: 26) {
                    ctrlButton(m.isPlaying ? "pause.fill" : "play.fill", .control(0)) { m.togglePlay() }
                    ctrlButton("captions.bubble", .control(1)) { m.menu = .subs; focus = .menuRow(m.subtitleOptions.first?.id ?? -1) }
                    ctrlButton("waveform", .control(2)) { m.menu = .audio; focus = .menuRow(m.audioOptions.first?.id ?? 0) }
                    ctrlButton("info.circle", .control(3)) { m.menu = (m.menu == .info ? .none : .info) }
                }
                Spacer()
                Text(m.clock(m.duration)).foregroundStyle(.white)
            }
            .font(.title3.monospacedDigit())
        }
        .padding(.horizontal, Theme.gutter).padding(.bottom, 54)
    }

    private func ctrlButton(_ icon: String, _ id: PlayerFocus, _ action: @escaping () -> Void) -> some View {
        Button(action: { action(); m.flashControls() }) {
            Image(systemName: icon).font(.title2).frame(width: 64, height: 64)
                .background(.white.opacity(0.12), in: Circle())
        }
        .buttonStyle(.plain).focused($focus, equals: id)
    }

    private func trackMenu(_ heading: String, _ items: [PlayerModel.TrackOption],
                           _ current: Int, _ pick: @escaping (Int) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(heading).font(.title2.weight(.semibold)).foregroundStyle(.white).padding(.bottom, 6)
            ForEach(items) { item in
                Button { pick(item.id); m.menu = .none; m.controlsVisible = false; focus = .surface } label: {
                    HStack {
                        Image(systemName: item.id == current ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(item.id == current ? Theme.accent : Theme.muted)
                        Text(item.label).foregroundStyle(.white)
                        Spacer()
                    }
                    .padding(.vertical, 10).padding(.horizontal, 18).frame(width: 620)
                }
                .buttonStyle(.plain).focused($focus, equals: .menuRow(item.id))
            }
        }
        .padding(24).background(Theme.card.opacity(0.96), in: RoundedRectangle(cornerRadius: 16))
        .padding(.leading, Theme.gutter).padding(.bottom, 20)
    }

    private var infoPanel: some View {
        let i = m.info
        return VStack(alignment: .leading, spacing: 8) {
            Text("Now Playing").font(.title3.weight(.semibold)).foregroundStyle(.white)
            infoRow("Resolution", m.videoSizeText)
            if let hdr = i?.hdrText { infoRow("Dynamic Range", hdr) } else { infoRow("Dynamic Range", "SDR") }
            infoRow("Video", (i?.vcodec ?? "—").uppercased() + (i?.bitDepth.map { " · \($0)-bit" } ?? ""))
            infoRow("Audio", (i?.acodec ?? "—").uppercased() + (i?.channelLayout.map { " · \($0)" } ?? ""))
            if let kbps = i?.videoKbps {
                infoRow("Bitrate", kbps >= 1000 ? String(format: "%.1f Mbps", Double(kbps) / 1000) : "\(kbps) kbps")
            }
            infoRow("Display", m.displayMatchText)
        }
        .padding(22).background(Theme.card.opacity(0.96), in: RoundedRectangle(cornerRadius: 16))
    }
    private func infoRow(_ k: String, _ v: String) -> some View {
        HStack(spacing: 16) {
            Text(k).foregroundStyle(Theme.muted).frame(width: 200, alignment: .leading)
            Text(v).foregroundStyle(.white)
        }.font(.title3)
    }

    private func pill(_ text: String, _ icon: String) -> some View {
        Label(text, systemImage: icon).font(.headline)
            .padding(.horizontal, 22).padding(.vertical, 14)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.25), lineWidth: 1))
    }
    private func upNextCard(_ n: UpNextItem) -> some View {
        HStack(spacing: 14) {
            ArtImage(url: n.still, aspect: 16.0/9.0).frame(width: 150, height: 84)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 4) {
                Text("Up Next").font(.caption).foregroundStyle(Theme.accent2)
                Text(n.title).font(.headline).foregroundStyle(.white).lineLimit(1)
                if let s = n.subtitle { Text(s).font(.subheadline).foregroundStyle(Theme.muted) }
            }
            Spacer(minLength: 0)
        }
        .padding(14).frame(width: 420)
        .background(Theme.card.opacity(0.96), in: RoundedRectangle(cornerRadius: 12))
    }
}

enum PlayerFocus: Hashable { case surface, skip, upNext, control(Int), menuRow(Int) }

// MARK: - VLCKit drawable host

struct VLCVideoView: UIViewRepresentable {
    let model: PlayerModel
    func makeUIView(context: Context) -> UIView {
        let v = UIView(); v.backgroundColor = .black
        model.attachDrawable(v)
        return v
    }
    func updateUIView(_ uiView: UIView, context: Context) {}
}

// MARK: - Player model (owns libVLC, publishes UI state, does the work)

@MainActor
final class PlayerModel: NSObject, ObservableObject, VLCMediaPlayerDelegate {
    struct TrackOption: Identifiable, Hashable { let id: Int; let label: String }

    enum Menu { case none, subs, audio, info }

    private let player = VLCMediaPlayer()
    private weak var store: Store?

    // Published UI state
    @Published var position: Double = 0
    @Published var duration: Double = 0
    @Published var isPlaying = false
    @Published var controlsVisible = true
    @Published var menu: Menu = .none
    @Published var showSkipIntro = false
    @Published var showUpNext = false
    @Published var finishedPlayback = false
    @Published var info: Store.MediaInfo?
    @Published var subtitleOptions: [TrackOption] = []
    @Published var audioOptions: [TrackOption] = []
    @Published var currentSubtitle = -1
    @Published var currentAudio = 0
    @Published var displayMatchText = "—"

    // Context
    private var ref: Store.PlayRef?
    private var kind = "movie"
    private var fileId: Int?
    private var mediaTitle = ""
    private var mediaSubtitle: String?
    private var declaredDuration: Double?
    private var live = false
    private var startAt: Double = 0
    private var prerollURL: URL?
    private var upNext: [UpNextItem] = []
    private let sessionId = UUID().uuidString

    // Reporting / state
    private var onMain = false
    private var mainURL: URL?
    private var seekedToStart = false
    private var lastSaved: Double = 0
    private var lastBeat: Double = -100
    private var finished = false
    private var hideTimer: Timer?
    private var introRange: Store.IntroRange?
    private weak var hostWindow: UIWindow?
    private var addedSubURLs: [Int: Int] = [:]   // menu id -> vlc spu index (for server slaves)

    func bind(store: Store) { self.store = store }

    func attachDrawable(_ view: UIView) {
        player.drawable = view
        hostWindow = view.window
    }

    func start(url: URL, startAt: Double, ref: Store.PlayRef, kind: String, duration: Double?,
               title: String, subtitle: String?, fileId: Int?, live: Bool,
               preroll: URL?, upNext: [UpNextItem], window: UIWindow?) {
        self.ref = ref; self.kind = kind; self.fileId = fileId; self.mediaTitle = title
        self.mediaSubtitle = subtitle; self.declaredDuration = duration; self.live = live
        self.startAt = startAt; self.prerollURL = preroll; self.upNext = upNext
        self.mainURL = url
        self.duration = duration ?? 0
        player.delegate = self

        if let preroll {
            player.media = VLCMedia(url: preroll)
            Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
                Task { @MainActor in self?.switchToMain(url: url) }
            }
        } else {
            onMain = true
            player.media = mediaWithFilters(url)
        }
        player.play()
        flashControls()
        Task { await loadMeta() }
    }

    private func mediaWithFilters(_ url: URL) -> VLCMedia {
        let media = VLCMedia(url: url)
        for opt in store?.audioFilterOptions() ?? [] { media.addOption(opt) }
        return media
    }

    private func switchToMain(url: URL) {
        guard !onMain else { return }
        onMain = true; seekedToStart = false
        player.media = mediaWithFilters(url)
        player.play()
    }

    // Fetch intro/chapters, media info (for HDR match + overlay), subtitle tracks.
    private func loadMeta() async {
        guard let store, let fileId else { return }
        if kind == "episode", let pm = await store.playMeta(kind: kind, fileId: fileId) {
            introRange = pm.intro
        }
        if let mi = await store.mediaInfo(kind: kind, fileId: fileId) {
            info = mi
            applyDisplayCriteria(mi)
        }
        let tracks = await store.subtitleTracks(kind: kind, fileId: fileId)
        var opts: [TrackOption] = [TrackOption(id: -1, label: "Off")]
        for t in tracks { opts.append(TrackOption(id: t.idx, label: t.label)) }
        subtitleOptions = opts
    }

    // MARK: Remote

    func togglePlay() { if player.isPlaying { player.pause() } else { player.play() } }
    func jump(_ s: Int) { if s < 0 { player.jumpBackward(Int32(-s)) } else { player.jumpForward(Int32(s)) } }

    func flashControls() {
        controlsVisible = true
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 4.5, repeats: false) { [weak self] _ in
            Task { @MainActor in if self?.menu == PlayerModel.Menu.none { self?.controlsVisible = false } }
        }
    }

    func skipIntro() {
        guard let end = introRange?.end else { return }
        player.time = VLCTime(int: Int32(end * 1000))
        showSkipIntro = false
    }

    // MARK: Subtitle / audio menus

    var currentSubtitleOptions: [TrackOption] { subtitleOptions }
    func selectSubtitle(_ id: Int) {
        currentSubtitle = id
        if id == -1 { player.currentVideoSubTitleIndex = -1; return }
        // Load the server's WebVTT for this track as a slave, then select it.
        if let store, let fileId, let url = store.subtitleURL(kind: kind, fileId: fileId, idx: id) {
            let spu = player.addPlaybackSlave(url, type: .subtitle, enforce: true)
            addedSubURLs[id] = Int(spu)
        }
    }
    func selectAudio(_ id: Int) { currentAudio = id; player.currentAudioTrackIndex = Int32(id) }

    private func refreshAudioTracks() {
        let idxs = (player.audioTrackIndexes as? [NSNumber]) ?? []
        let names = (player.audioTrackNames as? [String]) ?? []
        var opts: [TrackOption] = []
        for (i, n) in zip(idxs, names) where i.int32Value >= 0 { opts.append(TrackOption(id: Int(i.int32Value), label: n)) }
        audioOptions = opts
        currentAudio = Int(player.currentAudioTrackIndex)
    }

    var currentSubtitle_: Int { currentSubtitle }

    // MARK: Up Next

    var upNextItem: UpNextItem? { upNext.first }
    func playNext() {
        guard let next = upNext.first, let store else { return }
        upNext.removeFirst()
        showUpNext = false
        finish(save: true)      // save progress on the finishing item
        // Reset for the new item
        finished = false; onMain = true; seekedToStart = true; lastSaved = 0; lastBeat = -100
        ref = next.ref; fileId = next.fileId; mediaTitle = next.title
        mediaSubtitle = next.subtitle; declaredDuration = next.duration
        duration = next.duration ?? 0; position = 0
        if let url = store.episodeStreamURL(fileId: next.fileId) {
            player.media = mediaWithFilters(url)
            player.play()
        }
        Task { await loadMeta() }
    }

    // MARK: VLCMediaPlayerDelegate

    // libVLC delivers delegate callbacks off the main thread; SwiftUI @Published
    // MUST be mutated on main, so these hop before touching any state (an
    // off-main @Published write crashes the app — the likely "closes on play").
    nonisolated func mediaPlayerStateChanged(_ aNotification: Notification!) {
        Task { @MainActor in self.handleState() }
    }
    nonisolated func mediaPlayerTimeChanged(_ aNotification: Notification!) {
        Task { @MainActor in self.handleTime() }
    }

    private func handleState() {
        isPlaying = player.isPlaying
        switch player.state {
        case .playing:
            if onMain, !seekedToStart, startAt > 1 {
                seekedToStart = true
                player.time = VLCTime(int: Int32(startAt * 1000))
            }
            refreshAudioTracks()
        case .ended:
            if onMain {
                if !upNext.isEmpty { playNext() } else { finish(save: true); finishedPlayback = true }
            } else if let u = mainURL { switchToMain(url: u) }   // pre-roll finished early
        case .error:
            finish(save: false); finishedPlayback = true
        default: break
        }
    }

    private func handleTime() {
        guard onMain else { return }
        position = Double(player.time.intValue) / 1000.0
        if duration <= 0 { duration = Double(player.media?.length.intValue ?? 0) / 1000.0 }
        if let r = introRange { showSkipIntro = position >= r.start && position <= r.end }
        if !upNext.isEmpty, duration > 0 {
            showUpNext = position >= duration - upNextLead && position < duration
        }
        report(position: position)
    }

    private var upNextLead: Double { max(20, min(60, duration * 0.04)) }
    var progress: Double { duration > 0 ? min(1, max(0, position / duration)) : 0 }
    var videoSizeText: String {
        let s = player.videoSize
        if s.width > 0 { return "\(Int(s.width))×\(Int(s.height))" }
        if let w = info?.width, let h = info?.height { return "\(w)×\(h)" }
        return "—"
    }

    func clock(_ s: Double) -> String {
        guard s.isFinite, s >= 0 else { return "0:00" }
        let t = Int(s), h = t/3600, m = (t%3600)/60, sec = t%60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }
    var currentAudioLabel: String { audioOptions.first { $0.id == currentAudio }?.label ?? "—" }
    var currentSubtitleLabel: String { subtitleOptions.first { $0.id == currentSubtitle }?.label ?? "Off" }

    // Expose selected ids for the checkmarks.
    var currentSub: Int { currentSubtitle }
    var currentAud: Int { currentAudio }

    // MARK: HDR / frame-rate display matching (what AVPlayer did for free)

    private func applyDisplayCriteria(_ i: Store.MediaInfo) {
        // NOTE: automatic HDR/frame-rate display switching (AVDisplayManager +
        // AVDisplayCriteria) is temporarily disabled while we stabilize playback —
        // it was a prime suspect for the "app closes on play" crash. The info
        // overlay still reports the source's real range/fps below; we'll re-enable
        // the actual display switch, guarded, once playback is confirmed stable.
        if let fps = i.fps {
            displayMatchText = "\(i.hdrText ?? "SDR") · \(String(format: "%.0f", fps))Hz (source)"
        } else {
            displayMatchText = i.hdrText ?? "SDR"
        }
    }

    // MARK: Progress reporting (mirrors the proven AVPlayer coordinator)

    private var reportKind: String { live ? "live" : kind }
    private func report(position: Double) {
        guard position.isFinite else { return }
        if position - lastBeat >= 10 { lastBeat = position; heartbeat(position: position) }
        guard position - lastSaved >= 8 else { return }
        lastSaved = position
        if live { return }
        let total = declaredDuration ?? (duration > 0 ? duration : nil)
        let watched = (total.map { position / $0 } ?? 0) > 0.92
        if let store, let ref { Task { await store.saveProgress(ref, position: position, duration: total, watched: watched ? true : nil) } }
    }
    private func heartbeat(position: Double) {
        guard let store else { return }
        let paused = !player.isPlaying
        let total = declaredDuration ?? (duration > 0 ? duration : nil)
        Task {
            await store.sessionHeartbeat(sessionId: sessionId, kind: reportKind, fileId: fileId,
                                         title: mediaTitle, subtitle: mediaSubtitle, mode: "direct",
                                         position: position, duration: total, paused: paused, live: live)
        }
    }
    private func finish(save: Bool) {
        guard !finished else { return }
        finished = true
        if let store { let sid = sessionId; Task { await store.sessionEnd(sessionId: sid) } }
        let pos = Double(player.time.intValue) / 1000.0
        if save, onMain, !live, pos > 1, let store, let ref {
            let total = declaredDuration ?? (duration > 0 ? duration : nil)
            let watched = (total.map { pos / $0 } ?? 0) > 0.92
            Task { await store.saveProgress(ref, position: pos, duration: total, watched: watched ? true : nil) }
        }
    }

    func teardown() {
        hideTimer?.invalidate()
        finish(save: true)
        player.stop()
    }
}
