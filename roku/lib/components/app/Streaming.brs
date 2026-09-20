' ============================================================
'  Streaming services (app.js STREAM_PROVIDERS / openService and
'  the Android shell's openExternal): a streaming title opens the
'  service's own app. On Android that is an intent to the service's
'  TV package; on a Roku it is the service's channel, launched
'  through the device's External Control Protocol on 127.0.0.1:8060.
'  Not installed: Android's toast, word for word.
' ============================================================

function streamProvider(slug as dynamic) as dynamic
    p = {
        netflix: { name: "Netflix", color: "#e50914", roku: "12" },
        prime: { name: "Prime Video", color: "#1399ff", roku: "13" },
        disney: { name: "Disney+", color: "#0a63e6", roku: "291097" },
        hulu: { name: "Hulu", color: "#1ce783", roku: "2285" },
        max: { name: "Max", color: "#a05cff", roku: "61322" },
        appletv: { name: "Apple TV+", color: "#7d7d7d", roku: "551012" },
        paramount: { name: "Paramount+", color: "#0064ff", roku: "31440" },
        peacock: { name: "Peacock", color: "#00b7eb", roku: "593099" }
    }
    return p[str0(slug)]
end function

sub openService(slug as dynamic, title as dynamic)
    p = streamProvider(slug)
    if p = invalid then return
    tele("deeplink", { service: str0(slug), title: str0(title), native: true })
    m.svc = { slug: str0(slug), id: p.roku, title: str0(title) }
    t = newNode("Http")
    t.url = "http://127.0.0.1:8060/query/apps"
    t.raw = true
    t.observeField("result", "onSvcApps")
    m.svcTask = t
    t.control = "RUN"
end sub

sub onSvcApps(ev as object)
    res = ev.getData()
    s = m.svc
    if s = invalid then return
    if res.code = 200 and Instr(1, str0(res.text), "id=""" + s.id + """") > 0
        ' Android opens the service's SEARCH URL inside its own app first, so the
        ' app lands on the title; only if that fails does it just launch the app.
        ' The Roku equivalent is an ECP search launched into that provider.
        t = newNode("Http")
        t.url = "http://127.0.0.1:8060/search/browse?keyword=" + enc(s.title) + "&provider-id=" + s.id + "&launch=true"
        t.method = "POST"
        t.body = " "
        t.raw = true
        t.observeField("result", "onSvcSearched")
        m.svcTask = t
        t.control = "RUN"
    else
        tele("deeplink", { result: "none:notinstalled" })
        toast("That app isn't installed on this TV")
    end if
end sub

' The search didn't take: fall back to opening the app itself.
sub onSvcSearched(ev as object)
    res = ev.getData()
    if res.code >= 200 and res.code < 300
        tele("deeplink", { result: "search:" + m.svc.id })
        return
    end if
    t = newNode("Http")
    t.url = "http://127.0.0.1:8060/launch/" + m.svc.id
    t.method = "POST"
    t.body = " "
    t.raw = true
    t.observeField("result", "onSvcLaunched")
    m.svcTask = t
    t.control = "RUN"
end sub

sub onSvcLaunched(ev as object)
    res = ev.getData()
    if res.code >= 200 and res.code < 300
        tele("deeplink", { result: "launch:" + m.svc.id })
    else
        tele("deeplink", { result: "none:ecp" + str0(res.code) })
        toast("That app isn't installed on this TV")
    end if
end sub
