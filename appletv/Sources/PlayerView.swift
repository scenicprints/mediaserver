import SwiftUI
import AVKit

// Native tvOS video playback via AVPlayerViewController (full transport UI,
// scrubbing, and the tvOS "info" panel for free). Streams the server file over
// ?token=; seeks to the resume point; and reports progress back so Continue
// Watching stays in sync with the web app.
struct PlayerView: UIViewControllerRepresentable {
    let url: URL
    let startAt: Double
    let movieId: Int
    let duration: Double?
    let store: Store

    func makeCoordinator() -> Coordinator { Coordinator(store: store, movieId: movieId, duration: duration) }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let player = AVPlayer(url: url)
        let vc = AVPlayerViewController()
        vc.player = player

        if startAt > 1 {
            player.seek(to: CMTime(seconds: startAt, preferredTimescale: 600))
        }
        player.play()

        // Save progress every 10s while playing.
        let interval = CMTime(seconds: 10, preferredTimescale: 1)
        context.coordinator.timeObserver = player.addPeriodicTimeObserver(
            forInterval: interval, queue: .main) { time in
            context.coordinator.report(position: time.seconds, item: player.currentItem)
        }
        context.coordinator.player = player
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {}

    // On teardown, flush one final progress write.
    static func dismantleUIViewController(_ vc: AVPlayerViewController, coordinator: Coordinator) {
        coordinator.flush(finalPosition: vc.player?.currentTime().seconds)
        if let obs = coordinator.timeObserver { coordinator.player?.removeTimeObserver(obs) }
        vc.player?.pause()
    }

    @MainActor
    final class Coordinator {
        let store: Store
        let movieId: Int
        let duration: Double?
        var player: AVPlayer?
        var timeObserver: Any?
        private var lastSaved: Double = 0

        init(store: Store, movieId: Int, duration: Double?) {
            self.store = store; self.movieId = movieId; self.duration = duration
        }

        func report(position: Double, item: AVPlayerItem?) {
            guard position.isFinite, position - lastSaved >= 9 else { return }
            lastSaved = position
            let dur = duration ?? item?.duration.seconds
            let total = (dur?.isFinite == true) ? dur : nil
            // Mark watched once past ~92% so it drops out of Continue Watching.
            let watched = (total.map { position / $0 } ?? 0) > 0.92
            Task { await store.saveProgress(movieId: movieId, position: position,
                                            duration: total, watched: watched ? true : nil) }
        }

        func flush(finalPosition: Double?) {
            guard let p = finalPosition, p.isFinite, p > 1 else { return }
            let total = (duration?.isFinite == true) ? duration : nil
            let watched = (total.map { p / $0 } ?? 0) > 0.92
            Task { await store.saveProgress(movieId: movieId, position: p,
                                            duration: total, watched: watched ? true : nil) }
        }
    }
}
