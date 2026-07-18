import SwiftUI
import AVKit
import AVFoundation
import CoreMedia
import UIKit

// ---------------------------------------------------------------------------
// Player routing: HDR → AVPlayer, everything else → VLCKit.
//
// On tvOS, VLCKit renders through OpenGL (no Metal vout) and the platform
// withholds the EDR APIs a custom renderer would need, so libVLC ALWAYS
// tone-maps HDR down to SDR — it can never light the TV's HDR badge. The ONLY
// way to get true HDR output on Apple TV is Apple's native pipeline (AVPlayer),
// which switches the display into HDR + the matching frame rate automatically
// (and handles resume seeks crash-free). AVPlayer can't read an MKV container or
// an `hev1`-tagged HEVC file, so HDR titles are fed the server's HLS *remux*
// (src/hls.js) — a lossless container repackage that COPIES the HEVC bitstream
// (HDR metadata intact) and retags it `hvc1`. No video re-encode.
//
// So: probe the file's real color info once (/api/mediainfo); HDR → AVPlayerHDRView,
// SDR/other/live → the universal VLCKit PlayerView (unchanged).
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
            AVPlayerHDRView(session: session, store: store)
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
// now-playing heartbeat, and watched-on-finish, mirroring the VLCKit player's
// reporting so Continue Watching + the admin monitor stay consistent.
// ---------------------------------------------------------------------------
struct AVPlayerHDRView: UIViewControllerRepresentable {
    let session: PlaySession
    let store: Store
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(session: session, store: store) }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = ExitAwarePlayerVC()
        // tvOS 17+: match the display to the current item — this is what lights
        // the HDR badge + switches refresh rate, automatically and crash-free.
        vc.appliesPreferredDisplayCriteriaAutomatically = true
        vc.onExit = { [weak coordinator = context.coordinator] in coordinator?.finish(watched: false) }
        context.coordinator.dismiss = { dismiss() }
        // Store is @MainActor, and this method is too — so build the HLS-remux
        // URL here and hand the player to the (non-isolated) coordinator, which
        // only ever touches the server through `await`.
        if let fid = session.fileId, let url = store.hlsURL(kind: session.kindString, fileId: fid) {
            let item = AVPlayerItem(url: url)
            let player = AVPlayer(playerItem: item)
            vc.player = player
            context.coordinator.begin(player: player, item: item)
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
        private let sessionId = UUID().uuidString
        var dismiss: (() -> Void)?

        private weak var player: AVPlayer?
        private var statusObs: NSKeyValueObservation?
        private var timeObs: Any?
        private var endObs: NSObjectProtocol?
        private var seekedToStart = false
        private var lastSaved: Double = -100
        private var lastBeat: Double = -100
        private var finished = false

        init(session: PlaySession, store: Store) { self.session = session; self.store = store }

        private var kind: String { session.kindString }

        func begin(player: AVPlayer, item: AVPlayerItem) {
            self.player = player

            // Resume: seek ONCE the item is actually ready (AVPlayer applies the
            // seek natively — no display-switch collision, so no crash). Default
            // tolerance lets it snap to a segment boundary for a faster resume.
            statusObs = item.observe(\.status, options: [.new]) { [weak self] item, _ in
                guard let self, item.status == .readyToPlay, !self.seekedToStart else { return }
                self.seekedToStart = true
                let p = self.player
                if self.session.startAt > 1 {
                    p?.seek(to: CMTime(seconds: self.session.startAt, preferredTimescale: 600)) { _ in p?.play() }
                } else {
                    p?.play()
                }
            }

            // Progress + now-playing heartbeat while it plays. Reference the
            // player weakly inside the block (a strong capture here is the classic
            // periodic-observer retain cycle).
            timeObs = player.addPeriodicTimeObserver(
                forInterval: CMTime(seconds: 5, preferredTimescale: 1), queue: .main
            ) { [weak self] t in
                guard let self else { return }
                self.tick(t.seconds, paused: (self.player?.timeControlStatus != .playing))
            }

            // Watched + auto-exit when it reaches the end.
            endObs = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
            ) { [weak self] _ in self?.finish(watched: true) }
        }

        private func tick(_ position: Double, paused: Bool) {
            guard position.isFinite, position >= 0 else { return }
            let total = session.duration
            // Hoist into locals so the Tasks capture only Sendable values, never
            // the (non-Sendable) coordinator.
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

        // Save final position, end the session, and dismiss the cover. Safe to
        // call more than once (Menu press, playback end, and teardown all route
        // here).
        func finish(watched: Bool) {
            let pos = player?.currentTime().seconds ?? 0
            if !finished {
                finished = true
                let total = session.duration
                let done = watched || (total.map { pos / $0 } ?? 0) > 0.92
                let store = self.store, ref = session.ref, sid = sessionId
                if pos > 1 { Task { await store.saveProgress(ref, position: pos, duration: total, watched: done ? true : nil) } }
                Task { await store.sessionEnd(sessionId: sid) }
            }
            player?.pause()
            dismiss?()
        }

        func teardown() {
            statusObs?.invalidate(); statusObs = nil
            if let timeObs { player?.removeTimeObserver(timeObs) }; timeObs = nil
            if let endObs { NotificationCenter.default.removeObserver(endObs) }; endObs = nil
            finish(watched: false)
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
