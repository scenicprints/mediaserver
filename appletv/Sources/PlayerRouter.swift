import SwiftUI
import AVKit
import AVFoundation
import CoreMedia
import UIKit

// ---------------------------------------------------------------------------
// Player routing: HDR → AVPlayer (real HDR), everything else → VLCKit.
//
// On tvOS, VLCKit renders through OpenGL (no Metal vout) and the platform
// withholds the EDR APIs a custom renderer would need, so libVLC ALWAYS
// tone-maps HDR down to SDR — it can never light the TV's HDR badge. The ONLY
// way to get true HDR output on Apple TV is Apple's native pipeline (AVPlayer),
// which switches the display into HDR + the matching frame rate automatically
// (and handles resume seeks crash-free). AVPlayer can't read an MKV container or
// an `hev1`-tagged HEVC file, so HDR titles are fed the server's HLS *remux*
// (src/hls.js) — a lossless container repackage that COPIES the HEVC bitstream
// (HDR metadata intact) and retags it `hvc1`. This is exactly what Plex does for
// the Apple TV (its client requests protocol=hls, directPlay/directStream).
//
// Robustness: if AVPlayer can't play a given HDR file (e.g. a Dolby Vision
// profile it rejects, or any HLS load failure), we DON'T sit on a black screen —
// we fall back to the universal VLCKit player (tone-mapped SDR). So HDR10 gets
// real HDR, and anything AVPlayer can't handle still plays, never black.
// ---------------------------------------------------------------------------
struct PlayerRouter: View {
    let session: PlaySession
    let store: Store
    @State private var decision: Decision = .deciding
    enum Decision { case deciding, vlc, hdr }

    var body: some View {
        switch decision {
        case .deciding:
            ZStack { Color.black.ignoresSafeArea(); ProgressView().tint(.white).scaleEffect(1.6) }
                .task { await decide() }
        case .vlc:
            PlayerView(session: session, store: store)
        case .hdr:
            AVPlayerHDRView(session: session, store: store, onFailure: { decision = .vlc })
        }
    }

    @MainActor
    private func decide() async {
        // Live TV and any file with no id stay on the universal VLCKit path.
        guard let fid = session.fileId, !session.live else { decision = .vlc; return }
        let hdr = (await store.mediaInfo(kind: session.kindString, fileId: fid))?.isHDR == true
        decision = hdr ? .hdr : .vlc
    }
}

extension PlaySession {
    var kindString: String { if case .episode = ref { return "episode" }; return "movie" }
}

// ---------------------------------------------------------------------------
// AVPlayer-backed HDR player. Uses AVPlayerViewController so tvOS gives us the
// native transport + subtitle picker AND (via appliesPreferredDisplayCriteria-
// Automatically) the automatic HDR/frame-rate display switch — the thing VLCKit
// can't do. Fed the HLS-remux master playlist. Handles resume, progress, the
// now-playing heartbeat, and watched-on-finish. If it can't play, it calls
// onFailure so the router can fall back to VLCKit.
// ---------------------------------------------------------------------------
struct AVPlayerHDRView: UIViewControllerRepresentable {
    let session: PlaySession
    let store: Store
    var onFailure: () -> Void = {}
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(session: session, store: store, onFailure: onFailure) }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = ExitAwarePlayerVC()
        // tvOS 17+: match the display to the current item — this is what lights
        // the HDR badge + switches refresh rate, automatically and crash-free.
        vc.appliesPreferredDisplayCriteriaAutomatically = true
        vc.onExit = { [weak coordinator = context.coordinator] in coordinator?.exitPlayback() }
        context.coordinator.dismiss = { dismiss() }
        // Store is @MainActor, and this method is too — build the HLS-remux URL
        // here and hand the player to the (non-isolated) coordinator, which only
        // ever touches the server through `await`.
        if let fid = session.fileId, let url = store.hlsURL(kind: session.kindString, fileId: fid) {
            let item = AVPlayerItem(url: url)
            let player = AVPlayer(playerItem: item)
            vc.player = player
            context.coordinator.begin(player: player, item: item)
        } else {
            context.coordinator.fail()   // no URL/token → fall back to VLCKit
        }
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {
        context.coordinator.dismiss = { dismiss() }
    }

    static func dismantleUIViewController(_ vc: AVPlayerViewController, coordinator: Coordinator) {
        coordinator.teardown()
    }

    final class Coordinator: NSObject {
        private let session: PlaySession
        private let store: Store
        private let onFailure: () -> Void
        private let sessionId = UUID().uuidString
        var dismiss: (() -> Void)?

        private weak var player: AVPlayer?
        private var statusObs: NSKeyValueObservation?
        private var timeObs: Any?
        private var endObs: NSObjectProtocol?
        private var seekedToStart = false
        private var startedPlaying = false
        private var lastSaved: Double = -100
        private var lastBeat: Double = -100
        private var ended = false        // progress saved + session ended
        private var failedOver = false   // already handed off to VLCKit

        init(session: PlaySession, store: Store, onFailure: @escaping () -> Void) {
            self.session = session; self.store = store; self.onFailure = onFailure
        }

        private var kind: String { session.kindString }

        func begin(player: AVPlayer, item: AVPlayerItem) {
            self.player = player

            // Start playback + resume-seek as soon as the item is ready. Check the
            // CURRENT status too (not just future changes) so we can't miss a
            // ready/failed transition that lands before this observer registers.
            func handle(_ status: AVPlayerItem.Status) {
                switch status {
                case .readyToPlay:
                    if self.session.startAt > 1 && !self.seekedToStart {
                        self.seekedToStart = true
                        player.seek(to: CMTime(seconds: self.session.startAt, preferredTimescale: 600)) { _ in player.play() }
                    } else { player.play() }
                case .failed:
                    self.fail()          // AVPlayer rejected the stream → VLCKit
                default: break
                }
            }
            if item.status != .unknown { handle(item.status) }
            statusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
                guard self != nil else { return }
                handle(it.status)
            }

            // Progress + now-playing heartbeat. Also notes once playback actually
            // started, which disarms the stall watchdog below.
            timeObs = player.addPeriodicTimeObserver(
                forInterval: CMTime(seconds: 5, preferredTimescale: 1), queue: .main
            ) { [weak self] t in
                guard let self else { return }
                let playing = (self.player?.timeControlStatus == .playing)
                if playing { self.startedPlaying = true }
                self.tick(t.seconds, paused: !playing)
            }

            endObs = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
            ) { [weak self] _ in self?.finishAndExit(watched: true) }

            // Stall watchdog: if nothing has played after 20s, treat the HLS as
            // unplayable and fall back to VLCKit rather than sit on a black screen.
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
                guard let self, !self.startedPlaying else { return }
                self.fail()
            }
        }

        // AVPlayer can't play this file — hand off to the VLCKit player (never a
        // silent black screen). The router swaps this view for PlayerView.
        func fail() {
            guard !failedOver, !ended else { return }
            failedOver = true
            player?.pause()
            onFailure()
        }

        private func tick(_ position: Double, paused: Bool) {
            guard position.isFinite, position >= 0 else { return }
            let total = session.duration
            let store = self.store, sid = sessionId, k = kind
            let ref = session.ref, title = session.title, sub = session.subtitle, fid = session.fileId
            if position - lastBeat >= 10 {
                lastBeat = position
                Task { await store.sessionHeartbeat(sessionId: sid, kind: k, fileId: fid,
                                                    title: title, subtitle: sub, mode: "direct",
                                                    position: position, duration: total, paused: paused, live: false) }
            }
            guard position - lastSaved >= 8 else { return }
            lastSaved = position
            let watched = (total.map { position / $0 } ?? 0) > 0.92
            Task { await store.saveProgress(ref, position: position, duration: total, watched: watched ? true : nil) }
        }

        // Menu press or playback end → save, end the session, and dismiss.
        func exitPlayback() { saveAndEnd(watched: false); dismiss?() }
        private func finishAndExit(watched: Bool) { saveAndEnd(watched: watched); dismiss?() }

        private func saveAndEnd(watched: Bool) {
            let pos = player?.currentTime().seconds ?? 0
            guard !ended else { return }
            ended = true
            let total = session.duration
            let done = watched || (total.map { pos / $0 } ?? 0) > 0.92
            let store = self.store, ref = session.ref, sid = sessionId
            if pos > 1 { Task { await store.saveProgress(ref, position: pos, duration: total, watched: done ? true : nil) } }
            Task { await store.sessionEnd(sessionId: sid) }
        }

        func teardown() {
            statusObs?.invalidate(); statusObs = nil
            if let timeObs { player?.removeTimeObserver(timeObs) }; timeObs = nil
            if let endObs { NotificationCenter.default.removeObserver(endObs) }; endObs = nil
            saveAndEnd(watched: false)   // idempotent; no-op if a fallback already occurred at pos 0
            player?.replaceCurrentItem(with: nil)
        }
    }
}

// AVPlayerViewController that treats the remote's MENU press as "exit playback"
// (save + dismiss), the way the VLCKit player's onExitCommand does.
final class ExitAwarePlayerVC: AVPlayerViewController {
    var onExit: (() -> Void)?
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if presses.contains(where: { $0.type == .menu }) { onExit?(); return }
        super.pressesBegan(presses, with: event)
    }
}
