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
    enum Decision { case deciding, vlc, hdr }

    var body: some View {
        switch decision {
        case .deciding:
            ZStack { Color.black.ignoresSafeArea(); ProgressView().tint(.white).scaleEffect(1.6) }
                .task { await decide() }
        case .vlc:
            PlayerView(session: session, store: store)
        case .hdr:
            PlayerView(session: session, store: store, useAVPlayer: true)
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
