import SwiftUI
import AVKit

// A fully-resolved playback request: URL picked (direct vs HLS), context for the
// admin monitor, and the resume point. Views resolve one of these, then present
// PlayerView from it.
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
}

extension PlayerView {
    init(session: PlaySession, store: Store) {
        self.init(url: session.url, startAt: session.startAt, ref: session.ref,
                  duration: session.duration, store: store, prerollURL: session.preroll,
                  title: session.title, subtitle: session.subtitle,
                  fileId: session.fileId, live: session.live)
    }
}

// Native tvOS playback via AVPlayerViewController (full transport UI, scrubbing,
// native subtitle/CC picker). Deliberately SIMPLE — this is the reset after a
// pile of extras (skip-intro, in-player AI-subs menu, buffer polling) broke
// playback. Kept: resume, progress save, a lightweight admin heartbeat, and an
// optional pre-roll that CANNOT wedge the feature (hard watchdog).
struct PlayerView: UIViewControllerRepresentable {
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

    private var kind: String { if case .episode = ref { return "episode" }; return "movie" }

    func makeCoordinator() -> Coordinator {
        Coordinator(store: store, ref: ref, kind: kind, duration: duration, startAt: startAt,
                    title: title, subtitle: subtitle, fileId: fileId, live: live,
                    mode: url.path.contains("/api/hls/") ? "transcode" : "direct")
    }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        let mainItem = AVPlayerItem(url: url)
        context.coordinator.mainItem = mainItem

        let player: AVPlayer
        if let prerollURL {
            let pre = AVPlayerItem(url: prerollURL)
            let q = AVQueuePlayer(items: [pre, mainItem])
            player = q
            context.coordinator.startPreroll(pre, mainItem: mainItem, player: q)
        } else {
            player = AVPlayer(playerItem: mainItem)
            if startAt > 1 { player.seek(to: CMTime(seconds: startAt, preferredTimescale: 600)) }
            context.coordinator.onMain = true
        }
        vc.player = player
        player.play()

        // A single 5s tick saves progress and heartbeats — light, off the render path.
        let interval = CMTime(seconds: 5, preferredTimescale: 1)
        context.coordinator.timeObserver = player.addPeriodicTimeObserver(
            forInterval: interval, queue: .main) { time in
            context.coordinator.tick(position: time.seconds, item: player.currentItem)
        }
        context.coordinator.player = player
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {}

    static func dismantleUIViewController(_ vc: AVPlayerViewController, coordinator: Coordinator) {
        coordinator.flush(finalPosition: vc.player?.currentTime().seconds)
        if let obs = coordinator.timeObserver { coordinator.player?.removeTimeObserver(obs) }
        coordinator.teardown()
        vc.player?.pause()
    }

    @MainActor
    final class Coordinator {
        let store: Store
        let ref: Store.PlayRef
        let kind: String
        let duration: Double?
        let startAt: Double
        let title: String
        let subtitle: String?
        let fileId: Int?
        let live: Bool
        let mode: String
        let sessionId = UUID().uuidString

        var player: AVPlayer?
        var mainItem: AVPlayerItem?
        var timeObserver: Any?
        var onMain = false
        private var endObserver: NSObjectProtocol?
        private var failObserver: NSObjectProtocol?
        private var lastSaved: Double = 0
        private var ticks = 0

        init(store: Store, ref: Store.PlayRef, kind: String, duration: Double?, startAt: Double,
             title: String, subtitle: String?, fileId: Int?, live: Bool, mode: String) {
            self.store = store; self.ref = ref; self.kind = kind; self.duration = duration
            self.startAt = startAt; self.title = title; self.subtitle = subtitle
            self.fileId = fileId; self.live = live; self.mode = mode
        }

        // Pre-roll → feature, with a watchdog so a slow/stalled pre-roll can NEVER
        // wedge the movie: if the feature isn't playing shortly, skip straight to it.
        func startPreroll(_ pre: AVPlayerItem, mainItem: AVPlayerItem, player: AVQueuePlayer) {
            let advance: () -> Void = { [weak self, weak player] in
                guard let self, !self.onMain else { return }
                self.onMain = true
                if let player, player.currentItem !== mainItem { player.advanceToNextItem() }
                if self.startAt > 1 { player?.seek(to: CMTime(seconds: self.startAt, preferredTimescale: 600)) }
                player?.play()
            }
            let nc = NotificationCenter.default
            endObserver = nc.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: pre, queue: .main) { _ in advance() }
            failObserver = nc.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: pre, queue: .main) { _ in advance() }
            // Hard watchdog: no matter what the pre-roll does, the feature starts.
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { advance() }
        }

        func tick(position: Double, item: AVPlayerItem?) {
            guard onMain, item === mainItem, position.isFinite else { return }
            if position - lastSaved >= 8 { report(position: position) }
            ticks += 1
            if ticks % 2 == 1 { heartbeat(position: position) }   // ~every 10s
        }

        private func heartbeat(position: Double) {
            let dur = duration ?? mainItem?.duration.seconds
            let paused = (player?.rate ?? 0) == 0
            Task {
                await store.sessionHeartbeat(sessionId: sessionId, kind: live ? "live" : kind,
                                             fileId: fileId, title: title, subtitle: subtitle,
                                             mode: mode, position: position,
                                             duration: (dur?.isFinite == true) ? dur : nil,
                                             paused: paused, live: live)
            }
        }

        func report(position: Double) {
            guard onMain, position.isFinite else { return }
            lastSaved = position
            if live { return }   // Live TV is ephemeral — never write watch-state
            let dur = duration ?? mainItem?.duration.seconds
            let total = (dur?.isFinite == true) ? dur : nil
            let watched = (total.map { position / $0 } ?? 0) > 0.92
            Task { await store.saveProgress(ref, position: position, duration: total, watched: watched ? true : nil) }
        }

        func flush(finalPosition: Double?) {
            let sid = sessionId
            Task { await store.sessionEnd(sessionId: sid) }
            if live { return }
            guard onMain, let p = finalPosition, p.isFinite, p > 1 else { return }
            let total = (duration?.isFinite == true) ? duration : nil
            let watched = (total.map { p / $0 } ?? 0) > 0.92
            Task { await store.saveProgress(ref, position: p, duration: total, watched: watched ? true : nil) }
        }

        func teardown() {
            if let e = endObserver { NotificationCenter.default.removeObserver(e); endObserver = nil }
            if let e = failObserver { NotificationCenter.default.removeObserver(e); failObserver = nil }
        }
    }
}
