import XCTest
import AVFoundation

// ---------------------------------------------------------------------------
// HLS format matrix — runs on the tvOS SIMULATOR in CI, no Apple TV needed.
//
// Feeds AVPlayer every candidate stream shape (fMP4 default, fMP4+CMAF, TS;
// master with/without CODECS; media playlist direct) from a local HTTP server
// the workflow starts on 127.0.0.1:8791 (fixtures are ffmpeg-synthesized 4K
// HDR10 HEVC + E-AC-3, matching the library's real files' parameters).
//
// The test never fails the build — it PRINTS one "HLSMATRIX ..." line per
// variant (status / error / track counts / presentation size) that we read
// from the CI log. This reproduces the on-device "-12927 after init" and
// "TS = audio but no video" behaviors where they can be iterated freely.
// ---------------------------------------------------------------------------
final class HLSFormatTests: XCTestCase {
    private let base = "http://127.0.0.1:8791"

    func testMatrix() {
        let variants: [(String, String)] = [
            ("fmp4_master_codecs", "/fmp4/master-codecs.m3u8"),
            ("fmp4_master_plain",  "/fmp4/master-plain.m3u8"),
            ("fmp4_media_direct",  "/fmp4/media.m3u8"),
            ("cmaf_master_codecs", "/cmaf/master-codecs.m3u8"),
            ("cmaf_master_plain",  "/cmaf/master-plain.m3u8"),
            ("ts_master_plain",    "/ts/master-plain.m3u8"),
            ("ts_media_direct",    "/ts/media.m3u8"),
        ]
        for (name, path) in variants { run(name: name, path: path) }
    }

    private func run(name: String, path: String) {
        guard let url = URL(string: base + path) else { return }
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        player.isMuted = true

        let exp = expectation(description: name)
        var done = false
        let obs = item.observe(\.status, options: [.new]) { it, _ in
            if it.status != .unknown && !done { done = true; exp.fulfill() }
        }
        player.play()
        _ = XCTWaiter().wait(for: [exp], timeout: 30)
        obs.invalidate()

        // Give a ready item a moment to select tracks and expose sizes.
        if item.status == .readyToPlay { RunLoop.current.run(until: Date().addingTimeInterval(3)) }

        var video = 0, audio = 0
        for t in item.tracks {
            if t.assetTrack?.mediaType == .video { video += 1 }
            if t.assetTrack?.mediaType == .audio { audio += 1 }
        }
        let err = (item.error as NSError?).map { "\($0.domain):\($0.code)" } ?? "none"
        let logEv = item.errorLog()?.events.last.map { "\($0.errorStatusCode)/\($0.errorDomain)" } ?? "-"
        print("HLSMATRIX \(name) status=\(item.status.rawValue) error=\(err) errlog=\(logEv) videoTracks=\(video) audioTracks=\(audio) size=\(Int(item.presentationSize.width))x\(Int(item.presentationSize.height))")
        player.pause()
        player.replaceCurrentItem(with: nil)
    }
}
