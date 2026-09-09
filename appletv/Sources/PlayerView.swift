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

struct PlaySession: Identifiable {
    // A subtitle file already on this Apple TV, alongside a downloaded film.
    struct LocalSub: Hashable { let label: String; let url: URL }

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
    // Offered on the end card when this finishes — the next film in the
    // franchise. Deliberately NOT in `upNext`: a film should not roll into its
    // sequel unasked, the way an episode rolls into the next episode.
    var endNext: UpNextItem? = nil
    // Set when playing a downloaded copy: the server is not necessarily
    // reachable, so the subtitle menu is built from these files instead.
    var localSubs: [LocalSub] = []
}

extension PlayerView {
    init(session: PlaySession, store: Store, useAVPlayer: Bool = false) {
        self.init(url: session.url, startAt: session.startAt, ref: session.ref,
                  duration: session.duration, store: store, prerollURL: session.preroll,
                  title: session.title, subtitle: session.subtitle,
                  fileId: session.fileId, live: session.live, upNext: session.upNext,
                  endNext: session.endNext,
                  localSubs: session.localSubs, useAVPlayer: useAVPlayer)
    }
}

// Player colors — the web player's tokens (style.css :root).
private enum VP {
    // ALWAYS the dark finish, whatever the app's finish setting is: this chrome
    // sits on top of a picture, and light chrome over a picture is unreadable.
    static let pal = Theme.black

    // One signal colour, used for state and never for decoration — the whole
    // point of the Braun palette. There is no second accent any more: the old
    // purple/cyan pair existed only to make a gradient, and Braun does not
    // gradient. Both names survive so every call site keeps reading sensibly.
    static let accent = pal.signal
    static let accent2 = pal.signal
    static let grad = pal.signal

    static let panel = pal.panel
    static let panel2 = pal.panel2
    static let line = pal.rule
    static let muted = pal.ink2
    static let ink = pal.ink
}

enum PlayerFocus: Hashable {
    case catcher, skipBack, play, skipFwd, scrubber, cc, gear
    case skipIntro, skipCredits, upNext, upNextDismiss
    case endNext, endBack, endReplay
    case menuRow(Int)
}

// A button with no focus/press visual at all — for the full-screen remote catcher,
// so the select click works without tvOS painting a white focus highlight.
private struct InvisibleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label }
}

// MARK: - Player screen (SwiftUI over VLCKit), styled to match the web player

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
    var endNext: UpNextItem? = nil
    var localSubs: [PlaySession.LocalSub] = []
    // HDR path: drive playback with AVPlayer (the only tvOS pipeline that outputs
    // real HDR + lights the badge) instead of libVLC, but keep this exact same
    // web-styled HUD on top. SDR stays on VLCKit (direct-plays every codec).
    var useAVPlayer: Bool = false

    @Environment(\.dismiss) private var dismiss
    @StateObject private var m = PlayerModel()
    @FocusState private var focus: PlayerFocus?

    private var kind: String { if case .episode = ref { return "episode" }; return "movie" }
    private var chromeUp: Bool { m.controlsVisible || m.menu != .none }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if useAVPlayer { AVPlayerLayerHost(model: m).ignoresSafeArea() }
            else { VLCVideoView(model: m).ignoresSafeArea() }

            // Invisible catcher owns the remote when nothing else is up. It's a
            // Button (so the CENTER/select click pauses + shows the HUD) with a
            // no-op style so there's NO tvOS focus highlight (no white flash).
            Button(action: { m.togglePlay(); m.flashControls() }) { Color.clear }
                .buttonStyle(InvisibleButtonStyle())
                .disabled(chromeUp || m.showSkipIntro || m.showSkipCredits || m.showUpNext || m.showEndCard)
                .focused($focus, equals: .catcher)
                .onMoveCommand { _ in m.flashControls() }
                .onPlayPauseCommand { m.togglePlay(); m.flashControls() }

            if chromeUp { topBar; bottomChrome }
            if m.buffering { spinner }
            skipAndUpNext
            if m.menu != .none { settingsMenu }
            if m.showEndCard { endCard }
        }
        .onExitCommand {
            if m.showEndCard { m.leaveEndCard() }
            else if m.menu != .none { m.closeMenu(); focus = .catcher }
            else if m.controlsVisible { m.controlsVisible = false; focus = .catcher }
            else { m.teardown(); dismiss() }
        }
        .onAppear {
            m.bind(store: store)
            m.start(url: url, startAt: startAt, ref: ref, kind: kind, duration: duration,
                    title: title, subtitle: subtitle, fileId: fileId, live: live,
                    preroll: prerollURL, upNext: upNext, endNext: endNext, localSubs: localSubs,
                    useAVPlayer: useAVPlayer)
            focus = .catcher
        }
        .onDisappear { m.teardown() }
        .onChange(of: m.controlsVisible) { vis in
            if vis { if !menuOrPrompt { focus = .play } }
            else if !menuOrPrompt { focus = .catcher }
        }
        .onChange(of: m.menu) { menu in
            if menu == .settings { focus = .menuRow(0) }
            else if menu == .aiPicker { focus = .menuRow(0) }
            else if menu == .osSearch { focus = .menuRow(0) }
        }
        .onChange(of: m.showSkipIntro) { on in if on { focus = .skipIntro } else if focus == .skipIntro { focus = m.controlsVisible ? .play : .catcher } }
        .onChange(of: m.showSkipCredits) { on in if on { focus = .skipCredits } else if focus == .skipCredits { focus = m.controlsVisible ? .play : .catcher } }
        .onChange(of: m.showUpNext) { on in if on { focus = .upNext } else if focus == .upNext || focus == .upNextDismiss { focus = m.controlsVisible ? .play : .catcher } }
        .onChange(of: m.finishedPlayback) { done in if done { m.teardown(); dismiss() } }
    }

    private var menuOrPrompt: Bool { m.menu != .none || m.showSkipIntro || m.showSkipCredits || m.showUpNext || m.showEndCard }

    // MARK: Top bar — Back + title (web .vp-top)

    private var topBar: some View {
        VStack {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.system(size: 40, weight: .bold)).foregroundStyle(.white)
                    if let s = subtitle { Text(s).font(.title3).foregroundStyle(Color(hex: 0xc7ccda)) }
                }
                Spacer()
            }
            .padding(.top, 54).padding(.horizontal, 68)
            .background(LinearGradient(colors: [.black.opacity(0.7), .clear], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .top).allowsHitTesting(false))
            Spacer()
        }
        .transition(.opacity)
    }

    // MARK: Center transport + bottom scrubber/utility (web .vp-transport + .vp-bottom)

    private var bottomChrome: some View {
        VStack(spacing: 0) {
            Spacer()
            // Center transport — a single round glass play/pause (the ±10s side
            // buttons were redundant: D-pad left/right already jumps ±10s).
            glassButton(m.isPlaying ? "pause.fill" : "play.fill", 140, .play) { m.togglePlay(); m.flashControls() }
            Spacer()
            // Bottom: scrubber + utility row over a scrim.
            VStack(spacing: 14) {
                // A channel has nowhere to scrub TO. The web player hides the
                // scrub bar, the transport and the clock outright on a live feed
                // (.vp-live) and shows a LIVE flag instead; this is that. The
                // scrubber is also the surface the D-pad seeks from, so leaving
                // it on screen would keep ±10s reachable however well jump() is
                // guarded.
                if !live { scrubber }
                HStack(spacing: 18) {
                    if live {
                        // Signal orange: state, never decoration — which is
                        // exactly what LIVE is.
                        HStack(spacing: 10) {
                            Rectangle().fill(VP.accent).frame(width: 12, height: 12)
                            Text("LIVE").font(.system(size: 22, weight: .semibold)).tracking(3)
                                .foregroundStyle(VP.accent)
                        }
                    } else {
                        Text("\(m.clock(m.position)) / \(m.clock(m.duration))")
                            .font(.system(size: 26, weight: .medium).monospacedDigit()).tracking(1.5)
                            .foregroundStyle(VP.ink)
                    }
                    Spacer()
                    utilityButton(.cc) { Text("CC").font(.system(size: 26, weight: .heavy)) } action: { m.menu = .settings }
                    utilityButton(.gear) { Image(systemName: "gearshape.fill").font(.system(size: 30)) } action: { m.menu = .settings }
                }
            }
            .padding(.horizontal, 80).padding(.bottom, 54)
            .background(LinearGradient(stops: [
                .init(color: .black.opacity(0.88), location: 0),
                .init(color: .black.opacity(0.45), location: 0.55),
                .init(color: .clear, location: 1)
            ], startPoint: .bottom, endPoint: .top).ignoresSafeArea(edges: .bottom).allowsHitTesting(false))
        }
        .transition(.opacity)
    }

    private var scrubber: some View {
        let f = (focus == .scrubber)
        return GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle().fill(.white.opacity(0.18)).frame(height: f ? 10 : 6)
                Rectangle().fill(.white.opacity(0.30))
                    .frame(width: geo.size.width * m.buffered, height: f ? 10 : 6)
                Rectangle().fill(VP.grad)
                    .frame(width: max(0, geo.size.width * m.progress), height: f ? 10 : 6)
                // thumb
                // A cursor, not a jewel: a hairline bar the width of a switch.
                Rectangle().fill(VP.ink)
                    .frame(width: f ? 4 : 0, height: f ? 30 : 0)
                    .offset(x: max(0, geo.size.width * m.progress - (f ? 2 : 0)))
            }
            .frame(height: 40)
        }
        .frame(height: 40)
        .focusable(m.controlsVisible && m.menu == .none)
        .focused($focus, equals: .scrubber)
        .onMoveCommand { dir in
            switch dir { case .left: m.jump(-10); case .right: m.jump(10); default: break }
            m.flashControls()
        }
        .animation(.easeOut(duration: 0.12), value: f)
    }

    // MARK: Skip Intro / Up Next (web .vp-skipbtn / .vp-upnext), bottom-right

    private var skipAndUpNext: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                if m.showSkipIntro {
                    Button { m.skipIntro() } label: {
                        Label("SKIP INTRO", systemImage: "forward.end.fill")
                            .font(.system(size: 22, weight: .semibold)).tracking(2.4)
                            .padding(.horizontal, 26).padding(.vertical, 16)
                            .background(VP.pal.paper.opacity(0.82), in: Rectangle())
                            .overlay(Rectangle().strokeBorder(VP.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain).foregroundStyle(.white)
                    .focused($focus, equals: .skipIntro)
                    .focusRing(focus == .skipIntro)
                }
                if m.showSkipCredits {
                    Button { m.skipCredits() } label: {
                        Label("SKIP CREDITS", systemImage: "forward.end.fill")
                            .font(.system(size: 22, weight: .semibold)).tracking(2.4)
                            .padding(.horizontal, 26).padding(.vertical, 16)
                            .background(VP.pal.paper.opacity(0.82), in: Rectangle())
                            .overlay(Rectangle().strokeBorder(VP.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain).foregroundStyle(.white)
                    .focused($focus, equals: .skipCredits)
                    .focusRing(focus == .skipCredits)
                }
                if m.showUpNext, let n = m.upNextItem {
                    // Dismiss sits UNDER the card, right-aligned with it — the web
                    // keeps its actions inside the card, which tvOS can't do (a
                    // Button's label cannot hold another Button and stay focusable).
                    // Beside it, the capsule read as unrelated to the card.
                    VStack(alignment: .trailing, spacing: 12) {
                        Button { m.playNext() } label: { upNextCard(n) }
                            .buttonStyle(.plain)
                            .focused($focus, equals: .upNext)
                            .focusRing(focus == .upNext)
                        Button { m.dismissUpNext() } label: {
                            Text("DISMISS").font(.system(size: 20, weight: .semibold)).tracking(2.2)
                                .padding(.horizontal, 22).padding(.vertical, 11)
                                .background(VP.panel2.opacity(0.96), in: Rectangle())
                                .overlay(Rectangle().strokeBorder(VP.line, lineWidth: 1))
                        }
                        .buttonStyle(.plain).foregroundStyle(.white)
                        .focused($focus, equals: .upNextDismiss)
                        .focusRing(focus == .upNextDismiss)
                    }
                }
            }
            .padding(.trailing, 80).padding(.bottom, 150)
        }
    }

    private func upNextCard(_ n: UpNextItem) -> some View {
        HStack(spacing: 16) {
            ArtImage(url: n.still, aspect: 16.0/9.0).frame(width: 168, height: 94)
                .clipShape(Rectangle())
            VStack(alignment: .leading, spacing: 5) {
                Text("UP NEXT").font(.system(size: 17, weight: .semibold)).tracking(3)
                    .foregroundStyle(VP.accent)
                Text(n.title).font(.title3.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
                if let s = n.subtitle { Text(s).font(.subheadline).foregroundStyle(VP.muted) }
                // Visible countdown: the card acts on its own, so say when.
                Text(m.upNextIn > 0 ? "Playing in \(m.upNextIn)s" : "Playing\u{2026}")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(VP.accent2)
                    .monospacedDigit()
            }
            Spacer(minLength: 0)
        }
        .padding(16).frame(width: 460)
        .background(VP.panel.opacity(0.96), in: Rectangle())
        .overlay(Rectangle().strokeBorder(VP.line, lineWidth: 1))
    }

    // MARK: End card (web .vp-endcard)
    // Full-bleed so the frozen last frame is not what you are looking at, and
    // centred because at this point it is the only thing on screen.
    private var endCard: some View {
        ZStack {
            Color.black.opacity(0.86).ignoresSafeArea()
            VStack(spacing: 10) {
                Text(title).font(.system(size: 46, weight: .semibold)).foregroundStyle(VP.ink)
                    .lineLimit(2).multilineTextAlignment(.center)
                Text("FINISHED").font(.system(size: 20, weight: .semibold)).tracking(3)
                    .foregroundStyle(VP.muted)
                HStack(spacing: 18) {
                    if let n = m.endCardNext {
                        Button { m.playEndCardNext() } label: {
                            Text("\u{25B6}  \(n.title.uppercased())")
                                .font(.system(size: 22, weight: .semibold)).tracking(2.2)
                                .lineLimit(1)
                                .padding(.horizontal, 28).padding(.vertical, 14)
                                .background(VP.grad, in: Rectangle())
                                .foregroundStyle(VP.pal.onSignal)
                        }
                        .buttonStyle(.plain)
                        .focused($focus, equals: .endNext)
                        .focusRing(focus == .endNext)
                    }
                    endCardButton("Back", .endBack) { m.leaveEndCard() }
                    endCardButton("Watch again", .endReplay) { m.replayFromEndCard() }
                }
                .padding(.top, 26)
            }
            .padding(48)
        }
        .onAppear { focus = m.endCardNext != nil ? .endNext : .endBack }
    }

    private func endCardButton(_ label: String, _ f: PlayerFocus, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label.uppercased()).font(.system(size: 22, weight: .semibold)).tracking(2.2)
                .padding(.horizontal, 28).padding(.vertical, 14)
                .background(VP.panel2.opacity(0.96), in: Rectangle())
                .overlay(Rectangle().strokeBorder(VP.line, lineWidth: 1))
                .foregroundStyle(VP.ink)
        }
        .buttonStyle(.plain)
        .focused($focus, equals: f)
        .focusRing(focus == f)
    }

    // MARK: Settings / Subtitles menu (web .vp-menu) — scrollable, bottom-right

    private var settingsMenu: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                menuPanel
                    .frame(width: 560)
                    .padding(.trailing, 80).padding(.bottom, 150)
            }
        }
    }

    @ViewBuilder private var menuPanel: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                switch m.menu {
                case .aiProgress:
                    menuHeader("Generating subtitles")
                    VStack(alignment: .leading, spacing: 12) {
                        GeometryReader { g in
                            ZStack(alignment: .leading) {
                                Rectangle().fill(.white.opacity(0.15)).frame(height: 10)
                                Rectangle().fill(VP.grad).frame(width: g.size.width * Double(m.aiPct)/100.0, height: 10)
                            }
                        }.frame(height: 10)
                        Text("\(m.aiPhase ?? "Working")… \(m.aiPct)%").foregroundStyle(.white).font(.title3)
                        Text("A full movie takes a few minutes — you can keep watching; the track appears when it's ready.")
                            .font(.callout).foregroundStyle(VP.muted)
                    }.padding(.horizontal, 10)
                    menuButton("Keep watching", 0, false) { m.closeMenu(); focus = .catcher }
                case .aiPicker:
                    menuHeader("Generate with AI")
                    menuButton("Transcribe spoken audio", 0, false) { m.startAISubs("orig") }
                    menuButton("Subtitles in English", 1, false) { m.startAISubs("en") }
                    menuButton("Subtitles in Spanish", 2, false) { m.startAISubs("es") }
                    Text("Runs on the server. Great when there are no subtitles, or to translate.")
                        .font(.callout).foregroundStyle(VP.muted).padding(10)
                    menuButton("‹ Back", 3, false) { m.menu = .settings; focus = .menuRow(0) }
                case .osSearch:
                    menuHeader("Find subtitles online")
                    if let st = m.osStatus {
                        Text(st).font(.callout).foregroundStyle(VP.muted)
                            .padding(.horizontal, 10).padding(.bottom, 4)
                    }
                    ForEach(Array(m.osResults.enumerated()), id: \.offset) { i, r in
                        menuButton(r.label, i, false) { m.fetchOnlineSub(r) }
                    }
                    menuButton("\u{2039} Back", m.osResults.count, false) { m.menu = .settings; focus = .menuRow(0) }
                default:
                    menuHeader("Subtitles")
                    // AI first — it's what you see the moment you open captions.
                    menuButton(m.aiActive ? "✨  Generating subtitles… \(m.aiPct)%" : "✨  Generate with AI…", 0, false) {
                        if m.aiActive { m.menu = .aiProgress } else { m.menu = .aiPicker; focus = .menuRow(0) }
                    }
                    menuButton("\u{1F50E}  Find subtitles online\u{2026}", 1, false) {
                        m.menu = .osSearch; focus = .menuRow(0); m.searchOnlineSubs()
                    }
                    ForEach(Array(m.subtitleRows.enumerated()), id: \.offset) { i, row in
                        menuButton(row.label, i + 2, row.id == m.currentSubtitle) { m.selectSubtitle(row.id); m.closeMenu(); focus = .catcher }
                    }
                    if m.audioOptions.count > 1 {
                        menuHeader("Audio")
                        let base = m.subtitleRows.count + 2
                        ForEach(Array(m.audioOptions.enumerated()), id: \.offset) { j, a in
                            menuButton(a.label, base + j, a.id == m.currentAudio) { m.selectAudio(a.id); m.closeMenu(); focus = .catcher }
                        }
                    }
                }
            }
            .padding(16)
        }
        .frame(maxHeight: 620)
        .background(VP.panel.opacity(0.97), in: Rectangle())
        .overlay(Rectangle().strokeBorder(VP.line, lineWidth: 1))
    }

    private func menuHeader(_ t: String) -> some View {
        Text(t.uppercased()).font(.caption.weight(.semibold)).tracking(0.5)
            .foregroundStyle(VP.muted).padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 4)
    }
    private func menuButton(_ label: String, _ idx: Int, _ checked: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label).foregroundStyle(checked ? VP.accent2 : .white)
                Spacer()
                if checked { Image(systemName: "checkmark").foregroundStyle(VP.accent2) }
            }
            .font(.title3).padding(.vertical, 12).padding(.horizontal, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((focus == .menuRow(idx)) ? VP.panel2 : .clear, in: Rectangle())
            .overlay(Rectangle().strokeBorder((focus == .menuRow(idx)) ? VP.accent : .clear, lineWidth: 2))
        }
        .buttonStyle(.plain).focused($focus, equals: .menuRow(idx))
    }

    // MARK: Reusable buttons with the web focus ring

    private func glassButton(_ icon: String, _ size: CGFloat, _ id: PlayerFocus, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(VP.ink)
                .frame(width: size, height: size)
                .background(VP.pal.sunk.opacity(0.62), in: Circle())
        }
        .buttonStyle(.plain).focused($focus, equals: id).focusRing(focus == id)
    }
    private func utilityButton<L: View>(_ id: PlayerFocus, @ViewBuilder label: () -> L, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            label().foregroundStyle(VP.ink).frame(width: 70, height: 70)
                .background(.white.opacity(0.08), in: Circle())
        }
        .buttonStyle(.plain).focused($focus, equals: id).focusRing(focus == id)
    }

    private var spinner: some View {
        ProgressView().scaleEffect(2).tint(VP.accent)
    }
}

// The web player's focus ring: white inner + purple outer ring + ambient glow + scale.
private extension View {
    func focusRing(_ on: Bool) -> some View {
        // A switch that is selected, not a light that is glowing: a hard
        // rectangle in the signal colour, no bloom, barely any lift.
        self.overlay(
            Rectangle()
                .strokeBorder(VP.accent, lineWidth: on ? 3 : 0)
                .padding(-4)
                .allowsHitTesting(false)
        )
        .scaleEffect(on ? 1.03 : 1)
        .animation(.easeOut(duration: 0.14), value: on)
    }
}

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

// AVPlayer video host — a UIView backed by an AVPlayerLayer. AVPlayer + this
// layer output true HDR on tvOS (and light the badge); the model owns the
// AVPlayer and attaches its layer here.
final class PlayerLayerUIView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
struct AVPlayerLayerHost: UIViewRepresentable {
    let model: PlayerModel
    func makeUIView(context: Context) -> PlayerLayerUIView {
        let v = PlayerLayerUIView(); v.backgroundColor = .black
        v.playerLayer.videoGravity = .resizeAspect
        model.attachAVLayer(v.playerLayer, host: v)
        return v
    }
    func updateUIView(_ uiView: PlayerLayerUIView, context: Context) {}
}

// MARK: - Player model

@MainActor
final class PlayerModel: NSObject, ObservableObject, VLCMediaPlayerDelegate {
    struct TrackOption: Identifiable, Hashable { let id: Int; let label: String }
    enum Menu { case none, settings, aiPicker, aiProgress, osSearch }

    private let player = VLCMediaPlayer()

    // AVPlayer engine (HDR path). When `useAV` is true, all the transport/track/
    // time logic below routes to AVPlayer instead of libVLC; the HUD is identical.
    private var useAV = false
    private var av: AVQueuePlayer?
    private weak var avLayer: AVPlayerLayer?
    private var avStatusObs: NSKeyValueObservation?
    private var avRateObs: NSKeyValueObservation?
    private var avTimeObs: Any?
    private var avEndObs: NSObjectProtocol?
    private var avLegible: AVMediaSelectionGroup?
    private var avAudible: AVMediaSelectionGroup?
    private var avMainItem: AVPlayerItem?   // the current main content item (vs the pre-roll)

    @Published var position: Double = 0
    @Published var duration: Double = 0
    @Published var buffered: Double = 0
    @Published var isPlaying = false
    @Published var buffering = false
    @Published var controlsVisible = false   // HUD starts hidden; shown on interaction
    @Published var menu: Menu = .none
    @Published var showSkipIntro = false
    @Published var showSkipCredits = false
    @Published var showUpNext = false
    // Dismissed by hand: the card goes away AND the chain stops, so a binge you
    // stepped out of does not keep rolling. Cleared on the next file.
    @Published var upNextDismissed = false
    // A film has nothing to roll into, so instead of a frozen last frame it gets
    // an end card. Live TV and a dismissed binge just leave.
    @Published var showEndCard = false
    @Published var finishedPlayback = false
    @Published var subtitleOptions: [TrackOption] = []
    @Published var audioOptions: [TrackOption] = []
    // The server's view of the same audio streams, used to label and rank them.
    @Published var serverAudio: [AudioTrack] = []
    private var audioRequested = false
    private var autoAudioApplied = false
    @Published var currentSubtitle = -1
    @Published var currentAudio = 0
    @Published var aiPhase: String?
    // Sidecars that came down with a downloaded film. When these exist the
    // subtitle menu is built from them, because the server may be unreachable.
    var localSubs: [PlaySession.LocalSub] = []
    // Playing from disk: never block the open on a server request.
    private(set) var offline = false
    // OpenSubtitles search results for the current file, and the line above them.
    @Published var osResults: [Store.OSResult] = []
    @Published var osStatus: String?
    @Published var osBusy = false
    @Published var aiPct = 0
    @Published var aiActive = false

    private weak var store: Store?
    private var ref: Store.PlayRef?
    private var kind = "movie"
    private var fileId: Int?
    private var mediaTitle = ""
    private var mediaSubtitle: String?
    private var declaredDuration: Double?
    private var live = false
    private var startAt: Double = 0
    private var prerollURL: URL?
    private var mainURL: URL?
    private var upNext: [UpNextItem] = []
    private var endNext: UpNextItem?
    private let sessionId = UUID().uuidString

    private var onMain = false
    private var seekedToStart = false
    private var lastSaved: Double = 0
    private var lastBeat: Double = -100
    private var finished = false
    private var hideTask: Task<Void, Never>?
    private var introRange: Store.IntroRange?

    var subtitleRows: [TrackOption] { subtitleOptions }
    var upNextItem: UpNextItem? { upNext.first }
    var progress: Double { duration > 0 ? min(1, max(0, position / duration)) : 0 }
    private var upNextLead: Double { max(20, min(60, duration * 0.04)) }

    func clock(_ s: Double) -> String {
        guard s.isFinite, s >= 0 else { return "0:00" }
        let t = Int(s), h = t / 3600, mn = (t % 3600) / 60, sec = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, mn, sec) : String(format: "%d:%02d", mn, sec)
    }

    func bind(store: Store) { self.store = store }
    func attachDrawable(_ view: UIView) { player.drawable = view }
    func attachAVLayer(_ layer: AVPlayerLayer, host: UIView) {
        avLayer = layer; avHostView = host
        if let av { layer.player = av }
    }
    private weak var avHostView: UIView?

    func start(url: URL, startAt: Double, ref: Store.PlayRef, kind: String, duration: Double?,
               title: String, subtitle: String?, fileId: Int?, live: Bool,
               preroll: URL?, upNext: [UpNextItem], endNext: UpNextItem? = nil,
               localSubs: [PlaySession.LocalSub] = [],
               useAVPlayer: Bool = false) {
        self.localSubs = localSubs
        self.offline = url.isFileURL
        self.ref = ref; self.kind = kind; self.fileId = fileId; self.mediaTitle = title
        self.mediaSubtitle = subtitle; self.declaredDuration = duration; self.live = live
        self.startAt = startAt; self.prerollURL = preroll; self.upNext = upNext; self.endNext = endNext
        self.mainURL = url; self.duration = duration ?? 0
        self.useAV = useAVPlayer
        if !useAV { player.delegate = self }
        // HUD stays hidden at start (no flashControls here) — it appears only when
        // the viewer interacts with the remote.
        Task { @MainActor in
            // NOTE: we deliberately do NOT switch the TV into an HDR display mode
            // here anymore. On tvOS, libVLC renders through OpenGL (no Metal vout)
            // and the platform withholds the EDR APIs a custom renderer needs, so
            // VLCKit ALWAYS tone-maps HDR down to SDR — it never emits real HDR
            // pixels. So `AVDisplayManager.preferredDisplayCriteria` could only
            // flip the panel into an HDR *container* over SDR pixels (washed out)
            // or silently no-op — and, worse, that async display reconfigure
            // collided with the resume seek and killed libVLC's video surface
            // ("app closes when you press Resume on a 4K file"). Removing it makes
            // resume crash-free; HDR still DECODES and shows correctly as
            // tone-mapped SDR (exactly what VLC-for-Apple-TV ships). Real HDR
            // output (the TV's HDR badge) requires the native AVPlayer path — see
            // the HLS-remux route (src/hls.js) — not VLCKit.
            beginPlayback()
            await loadMeta()
        }
    }

    private func beginPlayback() {
        if useAV { beginAVPlayback(); return }
        if let preroll = prerollURL {
            player.media = VLCMedia(url: preroll)
            Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
                Task { @MainActor in if let u = self?.mainURL { self?.switchToMain(url: u) } }
            }
        } else if let u = mainURL {
            onMain = true
            player.media = mediaWithFilters(u)
        }
        player.play()
    }

    // AVPlayer (HDR) engine. Streams the HLS remux (real HDR + badge). Optional
    // pre-roll plays first via an AVQueuePlayer; when the queue advances to the
    // main item we mark `onMain` and apply the resume seek.
    // HDR display switch — the researched, by-the-book sequence (Apple Tech Talk
    // 503 + how Infuse/AetherEngine ship it):
    //   1. A raw AVPlayerLayer does NOT auto-match the display; only
    //      AVPlayerViewController does. Without the switch, tvOS 26 rejects the
    //      VIDEO-RANGE=PQ variant outright (-11868 "NoCompatibleAlternates…" —
    //      master fetched, media playlist never requested).
    //   2. Set preferredDisplayCriteria BEFORE creating/assigning the
    //      AVPlayerItem ("so AVPlayer configures itself based on the targeted
    //      display mode" — Tech Talk 503).
    //   3. Wait for displayModeSwitchInProgress to end, with a ~5s timeout.
    //      HDMI mode switches take SECONDS on most TVs (Infuse waits ~4s); the
    //      old fixed 700ms sleep started the player mid-renegotiation.
    //   4. Revert (criteria = nil) only at orderly teardown, after player stop.
    // Every step breadcrumbs to the server (POST /api/clientlog) so a failure
    // names its exact step.
    // Switch-AFTER-ready ordering (what AVPlayerViewController actually does:
    // it derives display criteria from the stream's init segment, i.e. it
    // switches MID-playback, never before loading). Creating the player right
    // after a manual HDMI mode switch proved flaky — the identical stream
    // nondeterministically failed -12927 seconds after a switch and played
    // when the pipeline was quiet. So: play first on a stable display, then
    // switch once the item is readyToPlay (video keeps rolling; brief blink;
    // badge lights).
    private var avPendingHDR: Store.MediaInfo?
    // Timeline base: the stream starts at this absolute position (resume/seek
    // respawn) — real position = avBase + player.currentTime (the same virtual-
    // timeline model the web player uses for its transcode streams).
    private var avBase: Double = 0
    private func beginAVPlayback() {
        Task { @MainActor in
            // Resume: resolve the exact keyframe and start the stream THERE —
            // never seek into a remux that hasn't produced the target yet
            // (that was "resume plays from the beginning").
            if startAt > 1, let store, let fid = fileId {
                avBase = await store.seekPoint(kind: kind, fileId: fid, start: startAt)
                store.crumb("av: resume base=\(String(format: "%.1f", avBase)) (asked \(String(format: "%.1f", startAt)))")
            }
            if let store, let fid = fileId {
                store.warmHLS(kind: kind, fileId: fid, start: avBase)   // head start for the remux
                if let mi = await store.mediaInfo(kind: kind, fileId: fid), mi.isHDR {
                    await store.crumbSync("hdr: begin \(mi.hdr ?? "?") \(mi.width ?? 0)x\(mi.height ?? 0)@\(mi.fps ?? 0) — switch deferred until readyToPlay")
                    avPendingHDR = mi
                }
            }
            await store?.crumbSync("av: creating player (base=\(Int(avBase)))")
            setupAVQueue()
            store?.crumb("av: playing")
        }
    }

    private var displayWindow: UIWindow?
    @MainActor
    private func switchDisplayToHDR(_ mi: Store.MediaInfo) async {
        // Wait for the player view to actually be IN a window — i.e. the
        // fullScreenCover presentation has settled. Setting display criteria
        // while the scene is mid-presentation is a prime crash suspect, and the
        // host view's own window is the RIGHT window to switch (not whichever
        // window happens to be key mid-animation).
        let w0 = Date()
        while avHostView?.window == nil && Date().timeIntervalSince(w0) < 2 {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        let window = avHostView?.window
            ?? UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })?.keyWindow
        guard let window else { await store?.crumbSync("hdr: no window after 2s — skipping switch"); return }
        await store?.crumbSync("hdr: window ok (host=\(avHostView?.window != nil)) after \(String(format: "%.1f", Date().timeIntervalSince(w0)))s")

        // Every step below is an AWAITED breadcrumb, so a crash names its line.
        let dm = window.avDisplayManager
        await store?.crumbSync("hdr: avDisplayManager ok, matchingEnabled=\(dm.isDisplayCriteriaMatchingEnabled)")
        guard dm.isDisplayCriteriaMatchingEnabled else { return }   // Match Content OFF → no-op
        guard let criteria = hdrCriteria(mi) else { await store?.crumbSync("hdr: criteria build FAILED"); return }
        displayWindow = window
        await store?.crumbSync("hdr: SETTING preferredDisplayCriteria now")
        dm.preferredDisplayCriteria = criteria
        await store?.crumbSync("hdr: criteria SET ok — waiting for mode switch")
        // The switch is async and may not have started yet — give it a beat to
        // begin, then wait until it's no longer in progress (max 5s total).
        let t0 = Date()
        try? await Task.sleep(nanoseconds: 800_000_000)
        while dm.isDisplayModeSwitchInProgress && Date().timeIntervalSince(t0) < 5 {
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        await store?.crumbSync("hdr: switch settled after \(String(format: "%.1f", Date().timeIntervalSince(t0)))s (inProgress=\(dm.isDisplayModeSwitchInProgress))")
    }

    // BT.2020 + PQ (or HLG) CMFormatDescription for AVDisplayCriteria.
    private func hdrCriteria(_ i: Store.MediaInfo) -> AVDisplayCriteria? {
        guard let fps = i.fps else { return nil }
        let transfer: CFString = (i.hdr == "hlg")
            ? kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG
            : kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ
        let ext: [CFString: Any] = [
            kCMFormatDescriptionExtension_ColorPrimaries: kCMFormatDescriptionColorPrimaries_ITU_R_2020,
            kCMFormatDescriptionExtension_TransferFunction: transfer,
            kCMFormatDescriptionExtension_YCbCrMatrix: kCMFormatDescriptionYCbCrMatrix_ITU_R_2020
        ]
        var fmt: CMFormatDescription?
        CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault, codecType: kCMVideoCodecType_HEVC,
            width: Int32(i.width ?? 3840), height: Int32(i.height ?? 2160),
            extensions: ext as CFDictionary, formatDescriptionOut: &fmt)
        guard let fmt else { return nil }
        return AVDisplayCriteria(refreshRate: Float(fps), formatDescription: fmt)
    }

    private func setupAVQueue() {
        // The HDR path always streams the HLS remux, not the raw VLC URL.
        let mainURLForAV: URL = (store?.hlsURL(kind: kind, fileId: fileId ?? -1, start: avBase)) ?? mainURL!
        self.mainURL = mainURLForAV
        if let t = store?.token {
            store?.crumb("av: item url=\(mainURLForAV.absoluteString.replacingOccurrences(of: t, with: "TOKEN")) preroll=\(prerollURL != nil)")
        }
        var items: [AVPlayerItem] = []
        if let preroll = prerollURL { items.append(AVPlayerItem(url: preroll)) }
        let mainItem = AVPlayerItem(url: mainURLForAV)
        items.append(mainItem)
        let q = AVQueuePlayer(items: items)
        q.appliesMediaSelectionCriteriaAutomatically = false
        self.av = q
        self.avMainItem = mainItem
        avLayer?.player = q

        // onMain flips true once the pre-roll finishes and the main item is current.
        onMain = (prerollURL == nil)
        observeAV(main: mainItem)
        q.play()
    }

    // Cold-start retry counter for the direct media-playlist item.
    private var avTry = 0

    private func observeMainItem(_ item: AVPlayerItem) {
        avStatusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
            Task { @MainActor in self?.handleAVItemStatus(it) }
        }
    }

    private func handleAVItemStatus(_ item: AVPlayerItem) {
        if item.status == .failed {
            // Surface the REAL error to the server log, including WHICH URL
            // failed and the player's own error log — no more guessing.
            let e = item.error as NSError?
            let failing = (e?.userInfo["NSErrorFailingURLStringKey"] as? String)
                ?? (e?.userInfo[NSURLErrorFailingURLStringErrorKey] as? String) ?? "-"
            let under = (e?.userInfo[NSUnderlyingErrorKey] as? NSError).map { "\($0.domain) \($0.code)" } ?? "-"
            let logEv = item.errorLog()?.events.last.map {
                "code=\($0.errorStatusCode) dom=\($0.errorDomain) uri=\($0.uri ?? "-") \($0.errorComment ?? "")"
            } ?? "-"
            let red = { (s: String) -> String in
                guard let t = self.store?.token, !t.isEmpty else { return s }
                return s.replacingOccurrences(of: t, with: "TOKEN")
            }
            store?.crumb("av: item FAILED (try=\(avTry)) \(e?.domain ?? "?") \(e?.code ?? 0): \(e?.localizedDescription ?? "?") | failingURL=\(red(failing)) | underlying=\(under) | errlog=\(red(logEv))")
            // Cold-start safety net: the media playlist may not have segments in
            // its first second of life — retry the same URL a few times, spaced.
            guard avTry < 4, let q = av else { return }
            avTry += 1
            guard let url = store?.hlsURL(kind: kind, fileId: fileId ?? -1, start: avBase) else { return }
            let tn = avTry
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)   // let the remux produce segments
                guard !self.finished else { return }
                self.store?.crumb("av: retry #\(tn)")
                let next = AVPlayerItem(url: url)
                q.removeAllItems(); q.insert(next, after: nil)
                self.avMainItem = next
                self.observeMainItem(next)
                q.play()
            }
            return
        }
        guard item.status == .readyToPlay else { return }
        store?.crumb("av: item readyToPlay (try=\(avTry))")
        refreshAVTracks(item)
        // NOW switch the display into HDR — playback is established, so the
        // mode change happens under a rolling pipeline (the PVC choreography).
        if let mi = avPendingHDR {
            avPendingHDR = nil
            Task { @MainActor in await switchDisplayToHDR(mi) }
        }
    }

    private func observeAV(main mainItem: AVPlayerItem) {
        guard let q = av else { return }
        observeMainItem(mainItem)
        avRateObs = q.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
            Task { @MainActor in
                guard let self else { return }
                self.isPlaying = (p.timeControlStatus == .playing)
                self.buffering = (p.timeControlStatus == .waitingToPlayAtSpecifiedRate)
            }
        }
        avTimeObs = q.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.avTick() }
        }
        avEndObs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in self?.avItemEnded(note.object as? AVPlayerItem) }
        }
    }

    // Seek to an ABSOLUTE position. Inside the stream's produced window → a
    // plain AVPlayer seek; outside it (deep scrub, seek before the resume
    // base) → respawn the stream at the target keyframe (the Plex model).
    func avSeek(_ t: Double) {
        guard useAV, let q = av else { return }
        let target = max(0, duration > 0 ? min(t, duration - 0.5) : t)
        let rel = target - avBase
        var inWindow = false
        if rel >= 0, let item = q.currentItem {
            for r in item.seekableTimeRanges {
                let tr = r.timeRangeValue
                if rel >= tr.start.seconds - 0.5 && rel <= tr.start.seconds + tr.duration.seconds + 0.5 { inWindow = true; break }
            }
        }
        if inWindow {
            q.seek(to: CMTime(seconds: max(0, rel), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .positiveInfinity)
            return
        }
        guard let store, let fid = fileId else { return }
        buffering = true
        Task { @MainActor in
            let base = await store.seekPoint(kind: kind, fileId: fid, start: target)
            guard !self.finished, let url = store.hlsURL(kind: self.kind, fileId: fid, start: base), let q2 = self.av else { return }
            self.avBase = base
            store.crumb("av: seek respawn base=\(Int(base))")
            let item = AVPlayerItem(url: url)
            q2.removeAllItems(); q2.insert(item, after: nil)
            self.avMainItem = item
            self.observeMainItem(item)
            q2.play()
        }
    }

    private func avItemEnded(_ item: AVPlayerItem?) {
        guard useAV, let item else { return }
        if item === avMainItem {
            // Main content finished → Up Next or dismiss.
            if !upNext.isEmpty, !upNextDismissed { playNext() } else { endOfPlayback() }
        } else {
            // Pre-roll finished; the queue has advanced to the main item
            // (which already starts at avBase — no seek needed).
            onMain = true
        }
    }

    // AVPlayer per-tick UI update — mirrors handleTime for the AV engine.
    // Positions are avBase-offset: the stream's t=0 is the resume keyframe.
    private func avTick() {
        guard useAV, onMain, let q = av, q.currentItem != nil else { return }
        let t = q.currentTime().seconds
        if t.isFinite { position = max(0, avBase + t) }
        if duration <= 0, let d = q.currentItem?.duration.seconds, d.isFinite, d > 0 { duration = avBase + d }
        if let r = q.currentItem?.loadedTimeRanges.last?.timeRangeValue {
            let end = avBase + r.start.seconds + r.duration.seconds
            if duration > 0, end.isFinite { buffered = min(1, end / duration) }
        }
        if let r = introRange { showSkipIntro = position >= r.start && position <= r.end }
        updateSkipCredits()
        if !upNext.isEmpty, !upNextDismissed, duration > 0 { showUpNext = position >= duration - upNextLead && position < duration }
        report(position: position)
    }

    // Populate the subtitle + audio menus from the HLS media-selection groups.
    private func refreshAVTracks(_ item: AVPlayerItem) {
        let asset = item.asset
        if let g = asset.mediaSelectionGroup(forMediaCharacteristic: .legible) {
            avLegible = g
            // "Off" first (id -1), then each rendition by its option index.
            var subs: [TrackOption] = [TrackOption(id: -1, label: "Off")]
            for (i, opt) in g.options.enumerated() { subs.append(TrackOption(id: i, label: opt.displayName)) }
            subtitleOptions = subs
            // Captions OFF by default unless the viewer picked one.
            if currentSubtitle < 0 { item.select(nil, in: g) }
        }
        if let g = asset.mediaSelectionGroup(forMediaCharacteristic: .audible) {
            avAudible = g
            var auds: [TrackOption] = []
            for (i, opt) in g.options.enumerated() { auds.append(TrackOption(id: i, label: opt.displayName)) }
            if auds.count > 1 { audioOptions = auds }
            if let sel = item.currentMediaSelection.selectedMediaOption(in: g), let idx = g.options.firstIndex(of: sel) { currentAudio = idx }
        }
    }

    // After AI subtitles finish, re-fetch the HLS master (now lists the new
    // WebVTT rendition) at the current position and turn the newest track on.
    private func avReloadForNewSubtitles(selectNewest: Bool) {
        guard useAV, let q = av, let url = store?.hlsURL(kind: kind, fileId: fileId ?? -1) else { return }
        let at = q.currentTime()
        let item = AVPlayerItem(url: url)
        q.removeAllItems(); q.insert(item, after: nil)
        avMainItem = item
        avStatusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
            Task { @MainActor in
                guard let self, it.status == .readyToPlay else { return }
                self.av?.seek(to: at, toleranceBefore: .zero, toleranceAfter: .positiveInfinity)
                self.refreshAVTracks(it)
                if selectNewest, let g = self.avLegible, !g.options.isEmpty { self.selectSubtitle(g.options.count - 1) }
            }
        }
        q.play()
    }

    private func mediaWithFilters(_ url: URL) -> VLCMedia {
        let media = VLCMedia(url: url)
        for opt in store?.audioFilterOptions() ?? [] { media.addOption(opt) }
        return media
    }
    private func switchToMain(url: URL) {
        guard !onMain else { return }
        onMain = true; seekedToStart = false
        player.media = mediaWithFilters(url); player.play()
    }

    private func loadMeta() async {
        guard let store, let fileId else { return }
        // Skip the server round-trip when playing a downloaded copy.
        // Never on a live feed: there is nothing to skip forward into on a
        // channel, and an intro range borrowed from the episode's own file would
        // put a Skip Intro button over a programme already in progress.
        if kind == "episode", !live, !offline,
           let pm = await store.playMeta(kind: kind, fileId: fileId) { introRange = pm.intro }
        // AV builds its subtitle list from the HLS media-selection groups
        // (refreshAVTracks); the VLC path pulls the server track list.
        if !useAV { await reloadSubtitles() }
    }

    private func reloadSubtitles() async {
        // An offline copy lists what came down with it; ids index localSubs.
        // It never asks the server, which may not be reachable at all.
        if offline {
            var opts: [TrackOption] = [TrackOption(id: -1, label: "Off")]
            for (i, l) in localSubs.enumerated() { opts.append(TrackOption(id: i, label: l.label)) }
            subtitleOptions = opts
            return
        }
        guard let store, let fileId else { return }
        let tracks = await store.subtitleTracks(kind: kind, fileId: fileId)
        var opts: [TrackOption] = [TrackOption(id: -1, label: "Off")]
        for t in tracks { opts.append(TrackOption(id: t.idx, label: t.label)) }
        subtitleOptions = opts
    }

    // MARK: Transport
    func togglePlay() {
        if useAV { if av?.timeControlStatus == .paused { av?.play() } else { av?.pause() }; return }
        if player.isPlaying { player.pause() } else { player.play() }
    }
    func jump(_ s: Int) {
        // Nothing on a live channel is seekable — see the LIVE branch in
        // bottomChrome. Guarded here too so no future caller can reintroduce it.
        guard !live else { return }
        if useAV { avSeek(position + Double(s)); return }
        if s < 0 { player.jumpBackward(Int32(-s)) } else { player.jumpForward(Int32(s)) }
    }
    private var enginePlaying: Bool { useAV ? (av?.timeControlStatus == .playing) : player.isPlaying }
    func flashControls() {
        controlsVisible = true
        hideTask?.cancel()
        // NOT a Timer: run-loop timers sit in .default mode, and tvOS keeps the
        // main run loop in tracking mode while a thumb rests on the Siri remote
        // touchpad — the timer never fires and the HUD never auto-hides. A
        // structured-concurrency sleep doesn't care about run-loop modes.
        hideTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            guard let self, !Task.isCancelled else { return }
            // Always auto-hide (unless a menu is up) so the HUD never sticks.
            if self.menu == PlayerModel.Menu.none { self.controlsVisible = false }
        }
    }
    // Matches the web: a named credits chapter is authoritative there, and
    // without one it shows for the last 45 seconds of an episode that has a next
    // one. Never on a live channel, and never while the Up Next card is already
    // up — two controls doing the same job is worse than one.
    private func updateSkipCredits() {
        guard !live, !upNext.isEmpty, !upNextDismissed, !showUpNext, duration > 0 else {
            if showSkipCredits { showSkipCredits = false }
            return
        }
        showSkipCredits = position >= duration - 45 && position < duration - 1
    }
    func skipIntro() {
        guard !live, let end = introRange?.end else { return }
        if useAV { avSeek(end) }
        else { player.time = VLCTime(int: Int32(end * 1000)) }
        showSkipIntro = false
    }
    // Skip Credits goes to the NEXT EPISODE rather than seeking to the end —
    // which is what the web button does, and what people actually mean by it.
    func skipCredits() {
        guard !upNext.isEmpty else { return }
        showSkipCredits = false
        playNext()
    }
    func closeMenu() { menu = .none }
    // Cancels the roll-on for THIS episode only; the queue is left intact so a
    // later manual Play Now still works.
    func dismissUpNext() { upNextDismissed = true; showUpNext = false }

    // MARK: End of a film
    // Nothing follows a film, so rather than dismissing instantly (which felt
    // like a crash) or sitting on the last frame (which is what it used to do),
    // show the way back plus the next part of the franchise when we own it. It
    // leaves on its own after 90 seconds, for when nobody is awake to press
    // anything.
    var endCardNext: UpNextItem? { endNext }

    private func endOfPlayback() {
        finish(save: true)
        // Live TV that ran out of guide, and a binge the viewer dismissed, both
        // just leave — an end card there would be in the way.
        guard !live, !upNextDismissed else { finishedPlayback = true; return }
        showEndCard = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 90_000_000_000)
            if showEndCard { leaveEndCard() }
        }
    }

    func leaveEndCard() { showEndCard = false; finishedPlayback = true }

    func replayFromEndCard() {
        showEndCard = false
        finished = false; position = 0; lastSaved = 0; lastBeat = -100; seekedToStart = true
        if useAV { avBase = 0; av?.seek(to: .zero); av?.play() }
        else if let u = mainURL { player.media = mediaWithFilters(u); player.play() }
    }

    // Hand the franchise's next part to the ordinary advance path, so it goes
    // through exactly the same code an episode does.
    func playEndCardNext() {
        guard let n = endNext else { return }
        showEndCard = false
        endNext = nil
        upNext = [n]
        finished = false
        playNext()
    }
    // Whole seconds until the card fires, for the visible countdown. Without one
    // the card just sits there and the viewer cannot tell it is going to act.
    var upNextIn: Int { max(0, Int((duration - position).rounded())) }

    // MARK: Subtitles / audio
    func toggleCC() {
        // Quick toggle: if a track is on, turn off; else turn on the first real track.
        if currentSubtitle >= 0 { selectSubtitle(-1) }
        else if let first = subtitleOptions.first(where: { $0.id >= 0 }) { selectSubtitle(first.id) }
        else { menu = .aiPicker }   // nothing to show yet → offer AI
        flashControls()
    }
    func selectSubtitle(_ id: Int) {
        currentSubtitle = id
        if useAV {
            guard let g = avLegible, let item = av?.currentItem else { return }
            if id == -1 || id >= g.options.count { item.select(nil, in: g) }
            else { item.select(g.options[id], in: g) }
            return
        }
        if id == -1 { player.currentVideoSubTitleIndex = -1; return }
        if offline {
            if id < localSubs.count {
                _ = player.addPlaybackSlave(localSubs[id].url, type: .subtitle, enforce: true)
            }
            return
        }
        if let store, let fileId, let url = store.subtitleURL(kind: kind, fileId: fileId, idx: id) {
            _ = player.addPlaybackSlave(url, type: .subtitle, enforce: true)
        }
    }
    func selectAudio(_ id: Int) {
        currentAudio = id
        if useAV {
            if let g = avAudible, let item = av?.currentItem, id >= 0, id < g.options.count { item.select(g.options[id], in: g) }
            return
        }
        player.currentAudioTrackIndex = Int32(id)
    }
    // Batch 2 parity: the RIGHT audio track, not merely the first one.
    //
    // libVLC hands back its own track ids and free-text names; the server hands
    // back ffprobe's audio streams in container order with codec, channels and
    // dispositions. Both lists are the file's audio streams in the same order,
    // so position N in one is position N in the other — that ordinal is the only
    // safe bridge between them (VLC's ids are not stream indexes, and its names
    // are not parseable). If the counts disagree, something is being filtered
    // and the mapping is not trustworthy: leave VLC's own choice alone.
    private func loadServerAudio() {
        guard !audioRequested, let store, let fileId, !live else { return }
        audioRequested = true
        Task { @MainActor in
            serverAudio = await store.audioTracks(kind: kind, fileId: fileId)
            applyAudioPreference()
        }
    }

    private func applyAudioPreference() {
        guard !serverAudio.isEmpty, serverAudio.count == audioOptions.count else { return }
        // Better labels either way — "ENG · DTS · 5.1" beats "Track 1".
        audioOptions = zip(audioOptions, serverAudio).map { TrackOption(id: $0.id, label: $1.label) }
        guard !autoAudioApplied, serverAudio.count > 1 else { return }
        autoAudioApplied = true
        let surround = (store?.audioMode ?? "stereo") == "surround"
        guard let want = Store.rankAudio(serverAudio, surround: surround),
              want.index < audioOptions.count,
              audioOptions[want.index].id != currentAudio else { return }
        selectAudio(audioOptions[want.index].id)
    }

    private func refreshAudioTracks() {
        let idxs = (player.audioTrackIndexes as? [NSNumber]) ?? []
        let names = (player.audioTrackNames as? [String]) ?? []
        var opts: [TrackOption] = []
        for (i, n) in zip(idxs, names) where i.int32Value >= 0 { opts.append(TrackOption(id: Int(i.int32Value), label: n)) }
        audioOptions = opts
        currentAudio = Int(player.currentAudioTrackIndex)
        loadServerAudio()
        applyAudioPreference()
    }

    // MARK: OpenSubtitles — search the catalogue and pull one down mid-play
    // The server writes the chosen file next to the video as a sidecar, so the
    // new track then arrives through the ordinary track list.
    func searchOnlineSubs() {
        guard let store, let fileId else { return }
        osBusy = true; osResults = []; osStatus = "Searching\u{2026}"
        Task {
            let (rows, err) = await store.searchOpenSubtitles(kind: kind, fileId: fileId)
            osBusy = false
            osResults = rows
            osStatus = err ?? "Pick one to download."
        }
    }
    func fetchOnlineSub(_ r: Store.OSResult) {
        guard let store, let fileId, !osBusy else { return }
        osBusy = true; osStatus = "Downloading\u{2026}"
        Task {
            let err = await store.downloadOpenSubtitle(kind: kind, fileId: fileId, osFileId: r.fileId)
            osBusy = false
            if let err { osStatus = err; return }
            // Same landing as a finished AI job: refresh the tracks and switch
            // the new one on, so the subtitles are simply there.
            if useAV {
                avReloadForNewSubtitles(selectNewest: true)
            } else {
                await reloadSubtitles()
                if let newest = subtitleOptions.last(where: { $0.id >= 0 }) { selectSubtitle(newest.id) }
            }
            menu = .none
        }
    }

    // MARK: AI subtitles (Whisper) — the flow the web player has
    func startAISubs(_ target: String) {
        guard let store, let fileId else { return }
        menu = .aiProgress; aiPhase = "Starting"; aiPct = 0; aiActive = true
        Task {
            var job = await store.generateSubtitles(kind: kind, fileId: fileId)
            while let j = job, j.status == "running" {
                aiPhase = phaseLabel(j.phase); aiPct = j.pct ?? 0
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                job = await store.subtitleJobStatus(kind: kind, fileId: fileId)
            }
            aiActive = false
            if let j = job, j.status == "done" {
                aiPct = 100
                if useAV {
                    // Re-fetch the HLS master (now lists the new WebVTT rendition)
                    // at the current position, then turn the new track on.
                    avReloadForNewSubtitles(selectNewest: true)
                } else {
                    await reloadSubtitles()
                    if let newest = subtitleOptions.last(where: { $0.id >= 0 }) { selectSubtitle(newest.id) }
                }
                if menu == .aiProgress { menu = .none }
            } else {
                aiPhase = job?.error ?? "Couldn't generate subtitles"
            }
        }
    }
    private func phaseLabel(_ p: String?) -> String {
        switch p { case "extracting": return "Extracting audio"; case "transcribing": return "Transcribing"
                   case "translating": return "Translating"; default: return "Starting" }
    }

    // MARK: Up Next
    func playNext() {
        guard let next = upNext.first, let store else { return }
        upNext.removeFirst(); showUpNext = false
        finish(save: true)
        finished = false; onMain = true; seekedToStart = true; lastSaved = 0; lastBeat = -100
        ref = next.ref; fileId = next.fileId; mediaTitle = next.title
        mediaSubtitle = next.subtitle; declaredDuration = next.duration
        duration = next.duration ?? 0; position = 0; currentSubtitle = -1
        // New file, new streams: re-ask and re-rank rather than carrying over.
        serverAudio = []; audioRequested = false; autoAudioApplied = false
        upNextDismissed = false
        // A Live TV channel mixes films and episodes, so the endpoint — and the
        // kind everything downstream reports and probes with — has to follow
        // what is actually being played, not what came before it.
        let isEpisode: Bool
        if case .episode = next.ref { isEpisode = true } else { isEpisode = false }
        kind = isEpisode ? "episode" : "movie"
        if useAV {
            avBase = 0
            // Swap the queue over to the next episode's HLS remux.
            if let url = store.hlsURL(kind: kind, fileId: next.fileId), let q = av {
                q.removeAllItems()
                let item = AVPlayerItem(url: url)
                q.insert(item, after: nil)
                avMainItem = item
                avStatusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
                    Task { @MainActor in guard let self, it.status == .readyToPlay else { return }; self.refreshAVTracks(it) }
                }
                q.play()
            }
        } else {
            let nextURL = isEpisode ? store.episodeStreamURL(fileId: next.fileId)
                                    : store.streamURL(fileId: next.fileId)
            if let nextURL { player.media = mediaWithFilters(nextURL); player.play() }
        }
        Task { await loadMeta() }
    }

    // MARK: Delegate (hop to main — libVLC calls off-thread)
    nonisolated func mediaPlayerStateChanged(_ n: Notification!) { Task { @MainActor in self.handleState() } }
    nonisolated func mediaPlayerTimeChanged(_ n: Notification!) { Task { @MainActor in self.handleTime() } }

    private func handleState() {
        isPlaying = player.isPlaying
        switch player.state {
        case .buffering: buffering = !player.isPlaying
        case .playing:
            buffering = false
            // Captions OFF by default: libVLC auto-enables the first embedded text
            // track; force it off unless the viewer picked one.
            if currentSubtitle < 0 { player.currentVideoSubTitleIndex = -1 }
            refreshAudioTracks()
        case .ended:
            if onMain { if !upNext.isEmpty, !upNextDismissed { playNext() } else { endOfPlayback() } }
            else if let u = mainURL { switchToMain(url: u) }
        case .error: finish(save: false); finishedPlayback = true
        default: break
        }
    }
    private func handleTime() {
        guard onMain else { return }
        // Resume: seek once, on the first time update (playback is running &
        // seekable, so the seek sticks instead of restarting from 0).
        if !seekedToStart, startAt > 1, player.isSeekable {
            seekedToStart = true
            player.time = VLCTime(int: Int32(startAt * 1000))
            return
        }
        position = Double(player.time.intValue) / 1000.0
        if duration <= 0 { duration = Double(player.media?.length.intValue ?? 0) / 1000.0 }
        buffered = min(1, progress + 0.06)
        if let r = introRange { showSkipIntro = position >= r.start && position <= r.end }
        updateSkipCredits()
        if !upNext.isEmpty, !upNextDismissed, duration > 0 { showUpNext = position >= duration - upNextLead && position < duration }
        report(position: position)
    }

    // MARK: Reporting
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
    private var currentPositionSeconds: Double {
        if useAV { let t = av?.currentTime().seconds ?? 0; return t.isFinite ? avBase + t : avBase }
        return Double(player.time.intValue) / 1000.0
    }
    private func heartbeat(position: Double) {
        guard let store else { return }
        let paused = !enginePlaying
        let total = declaredDuration ?? (duration > 0 ? duration : nil)
        Task { await store.sessionHeartbeat(sessionId: sessionId, kind: reportKind, fileId: fileId, title: mediaTitle,
                                            subtitle: mediaSubtitle, mode: "direct", position: position, duration: total,
                                            paused: paused, live: live) }
    }
    private func finish(save: Bool) {
        guard !finished else { return }
        finished = true
        if let store { let sid = sessionId; Task { await store.sessionEnd(sessionId: sid) } }
        let pos = currentPositionSeconds
        if save, onMain, !live, pos > 1, let store, let ref {
            let total = declaredDuration ?? (duration > 0 ? duration : nil)
            let watched = (total.map { pos / $0 } ?? 0) > 0.92
            Task { await store.saveProgress(ref, position: pos, duration: total, watched: watched ? true : nil) }
        }
    }
    func teardown() {
        hideTask?.cancel()
        finish(save: true)
        if useAV {
            avStatusObs?.invalidate(); avRateObs?.invalidate()
            if let avTimeObs { av?.removeTimeObserver(avTimeObs) }; avTimeObs = nil
            if let avEndObs { NotificationCenter.default.removeObserver(avEndObs) }; avEndObs = nil
            av?.pause(); av?.removeAllItems(); av = nil
            // Revert the display mode AFTER the orderly stop (Tech Talk 503:
            // "set preferredDisplayCriteria to nil"; AVPlayerViewController's
            // model is revert-on-dismiss). Triggers one more HDMI switch.
            displayWindow?.avDisplayManager.preferredDisplayCriteria = nil
            displayWindow = nil
        } else {
            player.stop()
        }
    }
}
