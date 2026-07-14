import SwiftUI
import AVKit

// Native tvOS video playback via AVPlayerViewController (full transport UI,
// scrubbing, info panel). Streams the server file over ?token=; seeks to the
// resume point; reports progress so Continue Watching stays in sync with the
// web app. If a pre-roll clip is configured, it plays first (movies only), then
// the feature — matching the web player.
struct PlayerView: UIViewControllerRepresentable {
    let url: URL
    let startAt: Double
    let ref: Store.PlayRef
    let duration: Double?
    let store: Store
    var prerollURL: URL? = nil

    func makeCoordinator() -> Coordinator { Coordinator(store: store, ref: ref, duration: duration, startAt: startAt) }

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

        let interval = CMTime(seconds: 10, preferredTimescale: 1)
        context.coordinator.timeObserver = player.addPeriodicTimeObserver(
            forInterval: interval, queue: .main) { time in
            context.coordinator.report(position: time.seconds, item: player.currentItem)
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
        let duration: Double?
        let startAt: Double
        var player: AVPlayer?
        var mainItem: AVPlayerItem?
        var timeObserver: Any?
        var onMain = false
        private var endObserver: NSObjectProtocol?
        private var lastSaved: Double = 0

        init(store: Store, ref: Store.PlayRef, duration: Double?, startAt: Double) {
            self.store = store; self.ref = ref; self.duration = duration; self.startAt = startAt
        }

        // When the pre-roll finishes, the queue advances to the feature; seek it
        // to the resume point and start counting progress.
        func observePrerollEnd(_ preroll: AVPlayerItem, player: AVPlayer) {
            endObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime, object: preroll, queue: .main) { [weak self] _ in
                guard let self else { return }
                if self.startAt > 1 {
                    player.seek(to: CMTime(seconds: self.startAt, preferredTimescale: 600))
                }
                self.onMain = true
            }
        }

        func report(position: Double, item: AVPlayerItem?) {
            guard onMain, item === mainItem else { return }        // ignore pre-roll
            guard position.isFinite, position - lastSaved >= 9 else { return }
            lastSaved = position
            let dur = duration ?? item?.duration.seconds
            let total = (dur?.isFinite == true) ? dur : nil
            let watched = (total.map { position / $0 } ?? 0) > 0.92
            Task { await store.saveProgress(ref, position: position, duration: total, watched: watched ? true : nil) }
        }

        func flush(finalPosition: Double?) {
            guard onMain, let p = finalPosition, p.isFinite, p > 1 else { return }
            let total = (duration?.isFinite == true) ? duration : nil
            let watched = (total.map { p / $0 } ?? 0) > 0.92
            Task { await store.saveProgress(ref, position: p, duration: total, watched: watched ? true : nil) }
        }

        func teardown() {
            if let e = endObserver { NotificationCenter.default.removeObserver(e); endObserver = nil }
        }
    }
}
