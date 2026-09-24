' Every cached LAN base is asked to prove it holds the server's key, and the
' public base is asked for any answer at all, all at once. The first LAN base
' with a good proof wins straight away (LAN is preferred); public wins only once
' every LAN probe has failed or run out of time. A LAN base that answers without
' the right proof is some other machine that took the address, so it fails.
' Nothing secret is sent: the probes carry no token.

sub init()
    m.top.functionName = "probeRun"
end sub

sub probeRun()
    port = CreateObject("roMessagePort")
    live = {}
    lanLeft = 0
    key = m.top.key
    sid = m.top.serverId
    bases = m.top.lanBases
    if key <> "" and sid <> "" and bases <> invalid
        for each b in bases
            nonce = probeNonce()
            x = probeStart(port, b + "/api/lan?nonce=" + nonce)
            if x <> invalid
                live[x.GetIdentity().ToStr()] = { x: x, lan: true, base: b, nonce: nonce }
                lanLeft = lanLeft + 1
            end if
        end for
    end if
    pub = "failed"
    pubBase = m.top.publicBase
    if pubBase <> ""
        x = probeStart(port, pubBase + "/api/lan")
        if x <> invalid
            live[x.GetIdentity().ToStr()] = { x: x, lan: false, base: pubBase }
            pub = "waiting"
        end if
    end if
    lanMs = m.top.lanTimeoutMs
    pubMs = m.top.publicTimeoutMs
    clock = CreateObject("roTimespan")
    winner = ""
    while true
        if lanLeft = 0 and pub <> "waiting"
            if pub = "passed" then winner = pubBase
            exit while
        end if
        el = clock.TotalMilliseconds()
        if lanLeft > 0 and el >= lanMs
            ' Out of time on the LAN: every probe still open there has failed.
            probeCancel(live, true)
            lanLeft = 0
        else if pub = "waiting" and el >= pubMs
            probeCancel(live, false)
            pub = "failed"
        else
            wake = 0
            if lanLeft > 0 then wake = lanMs
            if pub = "waiting" and (wake = 0 or pubMs < wake) then wake = pubMs
            waitMs = wake - el
            if waitMs < 1 then waitMs = 1
            msg = wait(waitMs, port)
            if type(msg) = "roUrlEvent" and msg.GetInt() = 1
                id = msg.GetSourceIdentity().ToStr()
                p = live[id]
                if p <> invalid
                    live.Delete(id)
                    code = msg.GetResponseCode()
                    if p.lan
                        lanLeft = lanLeft - 1
                        if code = 200 and probeProven(msg.GetString(), p.nonce, sid, key)
                            winner = p.base
                            exit while
                        end if
                    else if code > 0 and code < 500
                        ' Any answer proves the server is up: one from before
                        ' /api/lan existed says 401, and that counts.
                        pub = "passed"
                    else
                        pub = "failed"
                    end if
                end if
            end if
        end if
    end while
    probeCancel(live, invalid)
    m.top.result = { base: winner }
end sub

function probeStart(port as object, url as string) as dynamic
    x = CreateObject("roUrlTransfer")
    x.SetMessagePort(port)
    x.SetUrl(url)
    if LCase(Left(url, 5)) = "https"
        x.SetCertificatesFile("common:/certs/ca-bundle.crt")
        x.InitClientCertificates()
    end if
    x.EnableEncodings(true)
    x.RetainBodyOnError(true)
    if x.AsyncGetToString() then return x
    return invalid
end function

' Cancels the probes still open: the LAN ones (lan true), the public one
' (false) or all of them (invalid).
sub probeCancel(live as object, lan as dynamic)
    ids = []
    for each id in live
        p = live[id]
        if lan = invalid or p.lan = lan then ids.Push(id)
    end for
    for each id in ids
        live[id].x.AsyncCancel()
        live.Delete(id)
    end for
end sub

function probeProven(text as string, nonce as string, sid as string, key as string) as boolean
    if text = "" then return false
    j = ParseJson(text)
    if j = invalid or type(j) <> "roAssociativeArray" then return false
    if probeStr(j.app) <> "marquee" or probeStr(j.id) <> sid then return false
    proof = LCase(probeStr(j.proof))
    if proof = "" then return false
    return proof = probeHmac(key, "marquee-lan:" + nonce)
end function

' Lowercase hex HMAC-SHA256. The key is the key string's own bytes (it is hex
' text, and is not decoded), as the server computes it.
function probeHmac(key as string, msg as string) as string
    hmac = CreateObject("roHMAC")
    k = CreateObject("roByteArray")
    k.FromAsciiString(key)
    if hmac.Setup("sha256", k) <> 0 then return ""
    b = CreateObject("roByteArray")
    b.FromAsciiString(msg)
    out = hmac.Process(b)
    if out = invalid then return ""
    return LCase(out.ToHexString())
end function

' A fresh nonce per probe, so an old proof can't be replayed.
function probeNonce() as string
    return CreateObject("roDeviceInfo").GetRandomUUID().Replace("-", "")
end function

function probeStr(v as dynamic) as string
    t = type(v)
    if t = "roString" or t = "String" then return v
    return ""
end function
