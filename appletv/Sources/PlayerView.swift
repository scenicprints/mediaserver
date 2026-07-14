import SwiftUI
import AVKit
import UIKit

// A fully-resolved playback request: URL picked (direct vs HLS, subtitle-aware),
// context for the admin monitor, and the resume point. Views resolve one of
// these asynchronously, then present PlayerView from it.
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

// Native tvOS video playback via AVPlayerViewController (full transport UI,
// scrubbing, info panel, native CC picker for HLS subtitle renditions).
// Streams the server file over ?token=; seeks to the resume point; reports
// progress so Continue Watching stays in sync with the web app; heartbeats the
// session so the admin "Now Playing" monitor sees this viewer; and surfaces
// Skip Intro / Skip Credits as native contextual actions (the Netflix-style
// top overlay button) driven by the server's chapter/fingerprint data.
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

    private var kind: String {
        if case .episode = ref { return "episode" }
        return "movie"
    }

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
            // Queue: pre-roll → feature. Seek the feature to the resume point once
            // the pre-roll ends; progress is only reported on the feature.
            let pre = AVPlayerItem(url: prerollURL)
            let q = AVQueuePlayer(items: [pre, mainItem])
            player = q
            context.coordinator.observePrerollEnd(pre, player: q)
        } else {
            player = AVPlayer(playerItem: mainItem)
            if startAt > 1 { player.seek(to: CMTime(seconds: startAt, preferredTimescale: 600)) }
            context.coordinator.onMain = true
        }

        vc.player = player
        player.play()

        // One 1s cadence drives everything: skip-button visibility (needs to be
        // snappy), progress saves (self-throttled to ~10s), and heartbeats (every
        // 10th tick).
        let interval = CMTime(seconds: 1, preferredTimescale: 10)
        context.coordinator.timeObserver = player.addPeriodicTimeObserver(
            forInterval: interval, queue: .main) { time in
            context.coordinator.tick(position: time.seconds, item: player.currentItem)
        }
        context.coordinator.player = player
        context.coordinator.vc = vc
        context.coordinator.loadPlayMeta()
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
        weak var vc: AVPlayerViewController?
        var mainItem: AVPlayerItem?
        var timeObserver: Any?
        var onMain = false
        private var endObserver: NSObjectProtocol?
        private var failObserver: NSObjectProtocol?
        private var lastSaved: Double = 0
        private var tickCount = 0

        // Skip Intro / Skip Credits ranges (server fingerprint + named chapters).
        private var introRange: Store.IntroRange?
        private var creditsRange: Store.IntroRange?
        private var introSkipped = false
        private var creditsSkipped = false
        private var showingIntro = false
        private var showingCredits = false

        init(store: Store, ref: Store.PlayRef, kind: String, duration: Double?, startAt: Double,
             title: String, subtitle: String?, fileId: Int?, live: Bool, mode: String) {
            self.store = store; self.ref = ref; self.kind = kind; self.duration = duration
            self.startAt = startAt; self.title = title; self.subtitle = subtitle
            self.fileId = fileId; self.live = live; self.mode = mode
        }

        // /api/play gives the fingerprinted intro range + named chapters (and
        // primes the server's engine decision for the admin monitor).
        func loadPlayMeta() {
            guard let fileId, !live else { return }
            Task { [weak self] in
                guard let self, let meta = await self.store.playMeta(kind: self.kind, fileId: fileId) else { return }
                // Intro: the detected range, else a chapter whose name says intro.
                self.introRange = meta.intro
                if self.introRange == nil, let ch = meta.chapters?.first(where: {
                    ($0.title ?? "").range(of: "intro|opening", options: [.regularExpression, .caseInsensitive]) != nil
                }) { self.introRange = Store.IntroRange(start: ch.start, end: ch.end) }
                // Credits: only a named chapter (bounded and authoritative).
                if let ch = meta.chapters?.first(where: {
                    ($0.title ?? "").range(of: "credit", options: [.regularExpression, .caseInsensitive]) != nil
                }) { self.creditsRange = Store.IntroRange(start: ch.start, end: ch.end) }
            }
        }

        // When the pre-roll finishes, the queue advances to the feature; seek it
        // to the resume point and start counting progress.
        func observePrerollEnd(_ preroll: AVPlayerItem, player: AVPlayer) {
            let advance: (Notification) -> Void = { [weak self] _ in
                guard let self, !self.onMain else { return }
                if self.startAt > 1 {
                    player.seek(to: CMTime(seconds: self.startAt, preferredTimescale: 600))
                }
                self.onMain = true
            }
            let nc = NotificationCenter.default
            endObserver = nc.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: preroll, queue: .main, using: advance)
            // If the pre-roll can't be played, skip straight to the feature.
            failObserver = nc.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: preroll, queue: .main) { [weak self] n in
                if let q = player as? AVQueuePlayer { q.advanceToNextItem() }
                advance(n)
                _ = self
            }
        }

        func tick(position: Double, item: AVPlayerItem?) {
            guard onMain, item === mainItem, position.isFinite else { return }
            updateSkipActions(position)
            if position - lastSaved >= 9 { report(position: position, item: item) }
            tickCount += 1
            if tickCount % 10 == 1 { heartbeat(position: position) }
        }

        private func updateSkipActions(_ t: Double) {
            let showIntro = !live && !introSkipped && introRange.map { t >= $0.start && t < $0.end } == true
            let showCredits = !live && !creditsSkipped && creditsRange.map { t >= $0.start && t < $0.end } == true
            guard showIntro != showingIntro || showCredits != showingCredits else { return }
            showingIntro = showIntro; showingCredits = showCredits
            var actions: [UIAction] = []
            if showIntro, let r = introRange {
                actions.append(UIAction(title: "Skip Intro") { [weak self] _ in
                    self?.introSkipped = true
                    self?.player?.seek(to: CMTime(seconds: r.end, preferredTimescale: 600))
                    self?.updateSkipActions(r.end)
                })
            }
            if showCredits, let r = creditsRange {
                actions.append(UIAction(title: "Skip Credits") { [weak self] _ in
                    self?.creditsSkipped = true
                    self?.player?.seek(to: CMTime(seconds: r.end, preferredTimescale: 600))
                    self?.updateSkipActions(r.end)
                })
            }
            vc?.contextualActions = actions
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

        func report(position: Double, item: AVPlayerItem?) {
            guard onMain, item === mainItem else { return }        // ignore pre-roll
            guard position.isFinite else { return }
            lastSaved = position
            let dur = duration ?? item?.duration.seconds
            let total = (dur?.isFinite == true) ? dur : nil
            let watched = (total.map { position / $0 } ?? 0) > 0.92
            Task { await store.saveProgress(ref, position: position, duration: total, watched: watched ? true : nil) }
        }

        func flush(finalPosition: Double?) {
            let sid = sessionId
            Task { await store.sessionEnd(sessionId: sid) }
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
