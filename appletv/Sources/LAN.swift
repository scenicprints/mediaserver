import Foundation
import CryptoKit

// ============================================================================
// Finding the server on the home network. docs/LAN.md is the protocol; every
// client implements the same thing, so change them together.
//
// The app only ever knew https://marqu33.duckdns.org. When the internet went
// down, that name stopped leading anywhere, and the Apple TV could not reach a
// server sitting on the same LAN. So while online, Store learns the server's
// LAN address and a shared key, and this races the two: a LAN probe that must
// prove it is OUR server (an HMAC over a fresh nonce, which a stranger holding
// the same IP cannot produce) against the public address. The first proven LAN
// base wins; otherwise public; otherwise nobody, and the caller keeps what it
// had.
//
// Nothing here sends the session token. A LAN base only receives the token
// after it has passed the proof, and that decision is Store's.
// ============================================================================

enum LANResolver {
    static let lanTimeout: TimeInterval = 2.5
    static let publicTimeout: TimeInterval = 6

    // Its own ephemeral session: no cache (a cached answer proves nothing), no
    // cookies, and it never sits waiting for connectivity, because the whole
    // point of a probe is to find out quickly.
    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForResource = LANResolver.publicTimeout + 2
        return URLSession(configuration: c)
    }()

    private enum Outcome: Sendable { case lan(String, Bool), pub(Bool) }

    /// The base to use, or nil when neither side answered.
    /// A LAN pass wins the moment it arrives. Public only wins once every LAN
    /// probe has failed, so a slow LAN answer is not beaten by a quick internet one.
    static func race(publicBase: String, lanBases: [String], serverId: String, key: String) async -> String? {
        // Without a key and an id there is nothing a LAN answer could be checked
        // against, and an unchecked LAN answer is worth nothing.
        let lans = (serverId.isEmpty || key.isEmpty) ? [] : lanBases
        return await withTaskGroup(of: Outcome.self, returning: String?.self) { g in
            for b in lans {
                g.addTask { .lan(b, await LANResolver.probeLAN(b, serverId: serverId, key: key)) }
            }
            g.addTask { .pub(await LANResolver.probePublic(publicBase)) }

            var lanLeft = lans.count
            var pubOK: Bool? = nil
            while let r = await g.next() {
                switch r {
                case .lan(let b, let ok):
                    if ok { g.cancelAll(); return b }
                    lanLeft -= 1
                    if lanLeft == 0, let p = pubOK { g.cancelAll(); return p ? publicBase : nil }
                case .pub(let ok):
                    pubOK = ok
                    if lanLeft == 0 { g.cancelAll(); return ok ? publicBase : nil }
                }
            }
            return nil
        }
    }

    // GET <lan>/api/lan?nonce=… passes only when it names our app, our server id,
    // and signs the nonce with our key. A wrong or missing proof is a failure.
    static func probeLAN(_ base: String, serverId: String, key: String) async -> Bool {
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        guard let u = URL(string: "\(base)/api/lan?nonce=\(nonce)") else { return false }
        var req = URLRequest(url: u)
        req.timeoutInterval = lanTimeout
        guard let (data, resp) = try? await session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              j["app"] as? String == "marquee",
              j["id"] as? String == serverId,
              let proof = j["proof"] as? String else { return false }
        return proof.lowercased() == LANResolver.proof(key: key, nonce: nonce)
    }

    // GET <public>/api/lan passes on any answer below 500. A server older than
    // the endpoint says 401, which still proves it is up; Caddy says 502 when
    // the Dell is not.
    static func probePublic(_ base: String) async -> Bool {
        guard let u = URL(string: "\(base)/api/lan") else { return false }
        var req = URLRequest(url: u)
        req.timeoutInterval = publicTimeout
        let answer = try? await session.data(for: req)
        guard let http = answer?.1 as? HTTPURLResponse else { return false }
        return http.statusCode < 500
    }

    // Lowercase hex of HMAC-SHA256(key, "marquee-lan:" + nonce). The key is the
    // UTF-8 bytes of the key string as the server sent it, not hex-decoded.
    static func proof(key: String, nonce: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Data("marquee-lan:\(nonce)".utf8),
                                                  using: SymmetricKey(data: Data(key.utf8)))
        return mac.map { String(format: "%02x", $0) }.joined()
    }
}
