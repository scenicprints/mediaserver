import SwiftUI

// ---------------------------------------------------------------------------
// Player routing: HDR → the AVPlayer engine, everything else → VLCKit — but BOTH
// render the exact same web-styled HUD (see PlayerView / PlayerModel, which is
// now dual-engine). AVPlayer is the only tvOS pipeline that outputs real HDR and
// lights the TV's badge; it's fed the server's HLS remux (src/hls.js, a lossless
// container copy that keeps the HEVC HDR bitstream). VLCKit direct-plays every
// other container/codec (as SDR). So HDR titles now get the badge AND Skip Intro
// / Up Next / AI subs / pre-roll, all in one player.
//
// We pick the engine by probing the file's real color info (/api/mediainfo).
// ---------------------------------------------------------------------------
struct PlayerRouter: View {
    let session: PlaySession
    let store: Store
    @State private var decision: Decision = .deciding
    // A version picked in the player's menu. It replaces `session` for the rest
    // of this viewing, and nothing outside the player ever hears of it.
    @State private var switched: PlaySession?
    enum Decision { case deciding, vlc, hdr }

    private var current: PlaySession { switched ?? session }

    var body: some View {
        switch decision {
        case .deciding:
            ZStack { Color.black.ignoresSafeArea(); ProgressView().tint(.white).scaleEffect(1.6) }
                .task { await decide() }
        case .vlc:
            PlayerView(session: current, store: store, onSwitchVersion: { reopen($0) })
                .id(current.id)
        case .hdr:
            PlayerView(session: current, store: store, useAVPlayer: true, onSwitchVersion: { reopen($0) })
                .id(current.id)
        }
    }

    // Another version: back through .deciding, exactly as a first open goes.
    // Passing through it removes the old player first (its onDisappear saves
    // progress and stops the engine) and probes the NEW file, so a 4K HDR to
    // 1080p SDR switch lands on VLCKit and the reverse on AVPlayer. The cover
    // stays up the whole time, so the detail page never flashes past.
    private func reopen(_ next: PlaySession) {
        switched = next
        decision = .deciding
    }

    @MainActor
    private func decide() async {
        let session = current
        // Live TV, a file with no id, and anything already on disk stay on the
        // universal VLCKit path. A downloaded copy must not wait on /api/mediainfo:
        // the server may be unreachable, and that probe would hang the open.
        guard let fid = session.fileId, !session.live, !session.url.isFileURL else { decision = .vlc; return }
        let hdr = (await store.mediaInfo(kind: session.kindString, fileId: fid))?.isHDR == true
        decision = hdr ? .hdr : .vlc
    }
}

extension PlaySession {
    var kindString: String { if case .episode = ref { return "episode" }; return "movie" }
}
