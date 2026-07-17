import SwiftUI
import UIKit
import VLCKitSPM

// A fully-resolved playback request: URL picked, context for the admin monitor,
// and the resume point. Views resolve one of these, then present PlayerView.
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

// Playback via **VLCKit** (libVLC), not AVPlayer. libVLC decodes/demuxes
// everything itself (MKV, hev1-tagged HEVC, E-AC-3, …), so the app points
// straight at the server's raw byte-range stream (/api/stream) and never needs a
// server-side remux — the Plex/Infuse model. We give up AVPlayerViewController's
// native tvOS chrome, so this hosts libVLC in a plain UIViewController and draws a
// minimal transport OSD + Siri-remote handling on top. Kept from the AVPlayer
// version: resume, 5s progress save, ~10s admin heartbeat, and an optional
// pre-roll that can never wedge the feature (hard watchdog).
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

    @Environment(\.dismiss) private var dismiss

    private var kind: String { if case .episode = ref { return "episode" }; return "movie" }

    func makeUIViewController(context: Context) -> VLCPlayerViewController {
        let vc = VLCPlayerViewController()
        vc.configure(mainURL: url, prerollURL: prerollURL, startAt: startAt,
                     store: store, ref: ref, kind: kind, declaredDuration: duration,
                     title: title, subtitle: subtitle, fileId: fileId, live: live,
                     onExit: { dismiss() })
        return vc
    }

    func updateUIViewController(_ vc: VLCPlayerViewController, context: Context) {}
}

// MARK: - VLCKit host controller

@MainActor
final class VLCPlayerViewController: UIViewController, VLCMediaPlayerDelegate {
    private let player = VLCMediaPlayer()
    private let videoView = UIView()

    // Playback inputs
    private var mainURL: URL!
    private var prerollURL: URL?
    private var startAt: Double = 0
    private var onExit: (() -> Void)?

    // Reporting context
    private weak var store: Store?
    private var ref: Store.PlayRef!
    private var kind = "movie"
    private var declaredDuration: Double?
    private var title = ""
    private var subtitle: String?
    private var fileId: Int?
    private var live = false
    private let sessionId = UUID().uuidString

    // State
    private var onMain = false        // false while the pre-roll plays
    private var seekedToStart = false
    private var lastSaved: Double = 0
    private var lastBeat: Double = -100
    private var finished = false

    // OSD
    private let osd = UIView()
    private let scrubber = UIProgressView(progressViewStyle: .default)
    private let elapsedLabel = UILabel()
    private let titleLabel = UILabel()
    private var osdHide: DispatchWorkItem?

    func configure(mainURL: URL, prerollURL: URL?, startAt: Double, store: Store,
                   ref: Store.PlayRef, kind: String, declaredDuration: Double?,
                   title: String, subtitle: String?, fileId: Int?, live: Bool,
                   onExit: @escaping () -> Void) {
        self.mainURL = mainURL; self.prerollURL = prerollURL; self.startAt = startAt
        self.store = store; self.ref = ref; self.kind = kind
        self.declaredDuration = declaredDuration; self.title = title
        self.subtitle = subtitle; self.fileId = fileId; self.live = live
        self.onExit = onExit
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        videoView.frame = view.bounds
        videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(videoView)
        setupOSD()

        player.delegate = self
        player.drawable = videoView

        // Pre-roll first (if any), then the feature; otherwise straight to the feature.
        if let pre = prerollURL {
            player.media = VLCMedia(url: pre)
            // Hard watchdog: no matter what the pre-roll does, the feature starts.
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in self?.switchToMain() }
        } else {
            onMain = true
            player.media = VLCMedia(url: mainURL)
        }
        player.play()
        flashOSD()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        finish(save: true)
    }

    // MARK: Siri remote

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for p in presses {
            switch p.type {
            case .menu: onExit?(); handled = true
            case .playPause, .select: togglePlay(); handled = true
            case .leftArrow: player.jumpBackward(10); flashOSD(); handled = true
            case .rightArrow: player.jumpForward(10); flashOSD(); handled = true
            default: break
            }
        }
        if !handled { super.pressesBegan(presses, with: event) }
    }

    private func togglePlay() {
        if player.isPlaying { player.pause() } else { player.play() }
        flashOSD()
    }

    // MARK: Pre-roll → feature

    private func switchToMain() {
        guard !onMain else { return }
        onMain = true
        seekedToStart = false
        player.media = VLCMedia(url: mainURL)
        player.play()
    }

    // MARK: VLCMediaPlayerDelegate

    func mediaPlayerStateChanged(_ aNotification: Notification!) {
        switch player.state {
        case .playing:
            // Resume: seek once, after the feature is actually decoding.
            if onMain, !seekedToStart, startAt > 1 {
                seekedToStart = true
                player.time = VLCTime(int: Int32(startAt * 1000))
            }
        case .ended:
            if onMain { finish(save: true); onExit?() } else { switchToMain() }
        case .error:
            finish(save: false); onExit?()
        default:
            break
        }
    }

    func mediaPlayerTimeChanged(_ aNotification: Notification!) {
        guard onMain else { return }
        let pos = Double(player.time?.intValue ?? 0) / 1000.0
        updateOSD(position: pos)
        report(position: pos)
    }

    // MARK: Progress + heartbeat (mirrors the old AVPlayer coordinator)

    private var totalDuration: Double? {
        if let d = declaredDuration, d.isFinite, d > 0 { return d }
        let len = Double(player.media?.length.intValue ?? 0) / 1000.0
        return len > 0 ? len : nil
    }

    private func report(position: Double) {
        guard position.isFinite else { return }
        if position - lastBeat >= 10 { lastBeat = position; heartbeat(position: position) }
        guard position - lastSaved >= 8 else { return }
        lastSaved = position
        if live { return }
        let total = totalDuration
        let watched = (total.map { position / $0 } ?? 0) > 0.92
        if let store, let ref { Task { await store.saveProgress(ref, position: position, duration: total, watched: watched ? true : nil) } }
    }

    private func heartbeat(position: Double) {
        let paused = !player.isPlaying
        let dur = totalDuration
        if let store {
            Task {
                await store.sessionHeartbeat(sessionId: sessionId, kind: live ? "live" : kind,
                                             fileId: fileId, title: title, subtitle: subtitle,
                                             mode: "direct", position: position, duration: dur,
                                             paused: paused, live: live)
            }
        }
    }

    private func finish(save: Bool) {
        guard !finished else { return }
        finished = true
        let sid = sessionId
        if let store { Task { await store.sessionEnd(sessionId: sid) } }
        let pos = Double(player.time?.intValue ?? 0) / 1000.0
        if save, onMain, !live, pos > 1 {
            let total = totalDuration
            let watched = (total.map { pos / $0 } ?? 0) > 0.92
            if let store, let ref { Task { await store.saveProgress(ref, position: pos, duration: total, watched: watched ? true : nil) } }
        }
        player.stop()
    }

    // MARK: Minimal OSD

    private func setupOSD() {
        osd.frame = view.bounds
        osd.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        osd.isUserInteractionEnabled = false

        let bar = UIView()
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.backgroundColor = UIColor(white: 0, alpha: 0.55)
        bar.layer.cornerRadius = 10
        osd.addSubview(bar)

        titleLabel.text = title
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: 30, weight: .semibold)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(titleLabel)

        scrubber.progressTintColor = .white
        scrubber.trackTintColor = UIColor(white: 1, alpha: 0.25)
        scrubber.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(scrubber)

        elapsedLabel.textColor = .white
        elapsedLabel.font = .monospacedDigitSystemFont(ofSize: 22, weight: .regular)
        elapsedLabel.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(elapsedLabel)

        view.addSubview(osd)
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: osd.leadingAnchor, constant: 80),
            bar.trailingAnchor.constraint(equalTo: osd.trailingAnchor, constant: -80),
            bar.bottomAnchor.constraint(equalTo: osd.bottomAnchor, constant: -70),
            bar.heightAnchor.constraint(equalToConstant: 130),

            titleLabel.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 30),
            titleLabel.topAnchor.constraint(equalTo: bar.topAnchor, constant: 20),

            scrubber.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 30),
            scrubber.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -30),
            scrubber.bottomAnchor.constraint(equalTo: bar.bottomAnchor, constant: -35),

            elapsedLabel.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -30),
            elapsedLabel.bottomAnchor.constraint(equalTo: scrubber.topAnchor, constant: -10),
        ])
    }

    private func updateOSD(position: Double) {
        if let total = totalDuration, total > 0 {
            scrubber.progress = Float(min(1, max(0, position / total)))
            elapsedLabel.text = "\(clock(position)) / \(clock(total))"
        } else {
            elapsedLabel.text = clock(position)
        }
    }

    private func flashOSD() {
        osd.isHidden = false
        osd.alpha = 1
        osdHide?.cancel()
        let work = DispatchWorkItem { [weak self] in
            UIView.animate(withDuration: 0.4) { self?.osd.alpha = 0 }
        }
        osdHide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: work)
    }

    private func clock(_ s: Double) -> String {
        guard s.isFinite, s >= 0 else { return "0:00" }
        let t = Int(s), h = t / 3600, m = (t % 3600) / 60, sec = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }
}
