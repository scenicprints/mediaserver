import Foundation
import SwiftUI

// ============================================================================
// Offline downloads.
//
// A download on Apple TV is a CACHE, and the app says so. tvOS gives an app
// 500 KB of persistent storage and no Documents directory; everything else goes
// in Library/Caches, which the system deletes whenever it wants the space back.
// So: the manifest is small and lives in UserDefaults (it survives), the media
// file lives in Caches (it may not), and anything tvOS reclaimed shows as
// "Removed by tvOS" with one press to fetch it again. Nothing here pretends a
// downloaded film is permanent on this platform, because it isn't.
//
// The transfer is a background URLSession, so it keeps going while you browse
// and while the app is suspended. The source is the ordinary /api/stream URL,
// the same bytes the player streams, so the server needs nothing new.
// ============================================================================

struct DownloadItem: Codable, Identifiable, Hashable {
    enum State: String, Codable { case queued, downloading, ready, failed }
    struct Sub: Codable, Hashable { var label: String; var file: String }

    let kind: String            // "movie" | "episode"
    let fileId: Int             // the file id, what /api/stream takes
    let refId: Int              // movie / episode id, for progress and artwork
    var title: String
    var subtitle: String?       // "S1E04 . The Wire" on an episode
    var poster: String?
    var duration: Double?
    var file: String            // name inside the downloads folder
    var subs: [Sub] = []        // subtitle sidecars pulled down with it
    var bytes: Int64 = 0
    var expected: Int64 = 0
    var state: State = .queued
    var error: String?
    var addedAt: Double = Date().timeIntervalSince1970

    var id: String { "\(kind)-\(fileId)" }
    var pct: Int {
        guard expected > 0 else { return 0 }
        return Int(min(Double(bytes) / Double(expected), 1) * 100)
    }
    var sizeText: String {
        let b = Double(state == .ready ? bytes : expected)
        guard b > 0 else { return "-" }
        let gb = b / 1_000_000_000
        return gb >= 1 ? String(format: "%.1f GB", gb) : String(format: "%.0f MB", b / 1_000_000)
    }
}

@MainActor
final class DownloadManager: NSObject, ObservableObject {
    static let shared = DownloadManager()

    @Published private(set) var items: [DownloadItem] = []
    // Ready items whose file tvOS has since reclaimed. Kept apart from `state`
    // so the manifest still knows what it was, and one press re-fetches it.
    @Published private(set) var evicted: Set<String> = []

    private static let storeKey = "downloads.v1"
    private static let sessionId = "com.scenicprints.marqueetv.downloads"
    private var session: URLSession!
    private weak var store: Store?
    private var lastSave = Date.distantPast

    private override init() {
        super.init()
        let cfg = URLSessionConfiguration.background(withIdentifier: DownloadManager.sessionId)
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = false
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        load()
    }

    // The app hands us the Store once, so a transfer that finishes after a
    // relaunch can still fetch its subtitle sidecars.
    func attach(_ store: Store) { self.store = store }

    // ---- where the files live ----
    nonisolated static var dir: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }
    private var dir: URL { DownloadManager.dir }

    // ---- manifest ----
    private func load() {
        if let d = UserDefaults.standard.data(forKey: DownloadManager.storeKey),
           let rows = try? JSONDecoder().decode([DownloadItem].self, from: d) {
            items = rows
        }
        // A transfer that was mid-flight when the app died has no task any more.
        for i in items.indices where items[i].state == .downloading || items[i].state == .queued {
            items[i].state = .failed
            items[i].error = "Interrupted."
        }
        reconcile()
        // Unless the background session still has it, in which case the task
        // reattaches here and the row goes back to downloading.
        session.getAllTasks { tasks in
            let live = Set(tasks.compactMap { $0.taskDescription?.components(separatedBy: "\n").first })
            Task { @MainActor in
                guard !live.isEmpty else { return }
                for i in self.items.indices where live.contains(self.items[i].id) {
                    self.items[i].state = .downloading
                    self.items[i].error = nil
                }
                self.save(force: true)
            }
        }
    }

    private func save(force: Bool = false) {
        // Progress ticks are frequent; the manifest only needs to be durable at
        // transitions. 500 KB is the whole budget on tvOS, so keep it lean.
        if !force && Date().timeIntervalSince(lastSave) < 5 { return }
        lastSave = Date()
        if let d = try? JSONEncoder().encode(items) {
            UserDefaults.standard.set(d, forKey: DownloadManager.storeKey)
        }
    }

    /// Which ready files has tvOS taken back?
    func reconcile() {
        var gone: Set<String> = []
        for it in items where it.state == .ready {
            if !FileManager.default.fileExists(atPath: dir.appendingPathComponent(it.file).path) {
                gone.insert(it.id)
            }
        }
        evicted = gone
    }

    // ---- lookups the rest of the app uses ----
    func item(kind: String, fileId: Int) -> DownloadItem? {
        items.first { $0.kind == kind && $0.fileId == fileId }
    }
    /// The playable local file, or nil if it was never downloaded or tvOS took it.
    func localURL(kind: String, fileId: Int) -> URL? {
        guard let it = item(kind: kind, fileId: fileId), it.state == .ready else { return nil }
        let u = dir.appendingPathComponent(it.file)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }
    func localSubs(kind: String, fileId: Int) -> [PlaySession.LocalSub] {
        guard let it = item(kind: kind, fileId: fileId) else { return [] }
        return it.subs.compactMap { s in
            let u = dir.appendingPathComponent(s.file)
            guard FileManager.default.fileExists(atPath: u.path) else { return nil }
            return PlaySession.LocalSub(label: s.label, url: u)
        }
    }
    var totalBytes: Int64 {
        items.filter { $0.state == .ready && !evicted.contains($0.id) }.reduce(0) { $0 + $1.bytes }
    }
    var totalText: String {
        let gb = Double(totalBytes) / 1_000_000_000
        return gb >= 1 ? String(format: "%.1f GB", gb)
                       : String(format: "%.0f MB", Double(totalBytes) / 1_000_000)
    }

    /// The one line a control row shows for this file.
    func statusText(kind: String, fileId: Int) -> String {
        guard let it = item(kind: kind, fileId: fileId) else { return "Download" }
        if evicted.contains(it.id) { return "Removed by tvOS" }
        switch it.state {
        case .queued:      return "Queued"
        case .downloading: return it.expected > 0 ? "\(it.pct)%" : "Downloading"
        case .ready:       return "On this Apple TV"
        case .failed:      return it.error ?? "Failed"
        }
    }

    // ---- start / cancel / remove ----
    func start(kind: String, file: MovieFile, refId: Int, title: String,
               subtitle: String? = nil, poster: String? = nil, duration: Double? = nil,
               store: Store) {
        self.store = store
        guard let url = kind == "episode" ? store.episodeStreamURL(fileId: file.id)
                                          : store.streamURL(fileId: file.id) else { return }
        let id = "\(kind)-\(file.id)"
        let ext = ((file.filename ?? "") as NSString).pathExtension.lowercased()
        let name = "\(id).\(ext.isEmpty ? "mkv" : ext)"

        var it = item(kind: kind, fileId: file.id)
            ?? DownloadItem(kind: kind, fileId: file.id, refId: refId, title: title,
                            subtitle: subtitle, poster: poster, duration: duration, file: name)
        it.title = title
        it.subtitle = subtitle
        it.poster = poster
        it.duration = duration
        it.file = name
        it.state = .downloading
        it.error = nil
        it.bytes = 0
        it.expected = Int64(file.size ?? 0)
        it.subs = []
        upsert(it)
        evicted.remove(id)

        let task = session.downloadTask(with: url)
        // The delegate runs off the main actor and must move the temp file
        // before it returns, so it carries what it needs on the task itself.
        task.taskDescription = "\(id)\n\(name)"
        task.resume()
        save(force: true)
    }

    func cancel(_ id: String) {
        session.getAllTasks { tasks in
            for t in tasks where t.taskDescription?.hasPrefix(id + "\n") == true { t.cancel() }
        }
        if let i = items.firstIndex(where: { $0.id == id }) {
            items[i].state = .failed
            items[i].error = "Cancelled."
        }
        save(force: true)
    }

    func remove(_ id: String) {
        cancel(id)
        if let it = items.first(where: { $0.id == id }) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(it.file))
            for s in it.subs {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(s.file))
            }
        }
        items.removeAll { $0.id == id }
        evicted.remove(id)
        save(force: true)
    }
    func removeAll() { for it in items { remove(it.id) } }

    private func upsert(_ it: DownloadItem) {
        if let i = items.firstIndex(where: { $0.id == it.id }) { items[i] = it }
        else { items.append(it) }
    }

    // ---- called back from the session delegate ----
    fileprivate func progress(_ id: String, written: Int64, expected: Int64) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].bytes = written
        if expected > 0 { items[i].expected = expected }
        items[i].state = .downloading
        save()
    }
    fileprivate func finished(_ id: String, bytes: Int64) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].state = .ready
        items[i].bytes = bytes
        items[i].expected = bytes
        items[i].error = nil
        evicted.remove(id)
        save(force: true)
        let it = items[i]
        Task { await fetchSubs(for: it) }
    }
    fileprivate func failed(_ id: String, message: String) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].state = .failed
        items[i].error = message
        save(force: true)
    }

    // Subtitle sidecars, pulled once the film is down. A downloaded film with no
    // captions is half a download, and the player's track URLs are remote.
    private func fetchSubs(for it: DownloadItem) async {
        guard let store else { return }
        let tracks = await store.subtitleTracks(kind: it.kind, fileId: it.fileId)
        var saved: [DownloadItem.Sub] = []
        for t in tracks {
            guard let u = store.subtitleURL(kind: it.kind, fileId: it.fileId, idx: t.idx),
                  let (data, resp) = try? await URLSession.shared.data(from: u),
                  let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode)
            else { continue }
            let name = "\(it.id).\(t.idx).vtt"
            do {
                try data.write(to: DownloadManager.dir.appendingPathComponent(name))
                saved.append(DownloadItem.Sub(label: t.label, file: name))
            } catch { continue }
        }
        if let i = items.firstIndex(where: { $0.id == it.id }) {
            items[i].subs = saved
            save(force: true)
        }
    }
}

// The transfer callbacks arrive off the main actor. `didFinishDownloadingTo`
// hands over a temp file that is deleted the moment the method returns, so the
// move happens HERE, synchronously; only the bookkeeping hops to the main actor.
extension DownloadManager: URLSessionDownloadDelegate {
    nonisolated func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask,
                                didWriteData bytesWritten: Int64,
                                totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription?.components(separatedBy: "\n").first else { return }
        Task { @MainActor in
            self.progress(id, written: totalBytesWritten, expected: totalBytesExpectedToWrite)
        }
    }

    nonisolated func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask,
                                didFinishDownloadingTo location: URL) {
        let parts = (downloadTask.taskDescription ?? "").components(separatedBy: "\n")
        guard parts.count == 2 else { return }
        let id = parts[0], name = parts[1]

        if let code = (downloadTask.response as? HTTPURLResponse)?.statusCode,
           !(200..<300).contains(code) {
            Task { @MainActor in self.failed(id, message: "Server said \(code).") }
            return
        }
        let dest = DownloadManager.dir.appendingPathComponent(name)
        do {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: location, to: dest)
        } catch {
            Task { @MainActor in
                self.failed(id, message: "Couldn't save the file. The Apple TV may be full.")
            }
            return
        }
        let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path)
        let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
        Task { @MainActor in self.finished(id, bytes: size) }
    }

    nonisolated func urlSession(_ s: URLSession, task: URLSessionTask,
                                didCompleteWithError error: Error?) {
        guard let error, let id = task.taskDescription?.components(separatedBy: "\n").first else { return }
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled { return }   // cancel() already wrote the row
        Task { @MainActor in self.failed(id, message: ns.localizedDescription) }
    }
}
