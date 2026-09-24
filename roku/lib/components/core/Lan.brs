' ============================================================
'  Finding the server on the home network (docs/LAN.md).
'
'  The server has a public name and a LAN address. While online
'  and signed in the app learns the LAN address and the server's
'  key, and keeps them in the MarqueeLan registry section, which
'  the shell reads at launch to race the two. Here the app races
'  them again when the address it is using stops answering, and,
'  when an older shell loaded it from the public name, once at
'  startup, so those Rokus are on the LAN before an outage too.
'  A LAN base is only used after it proves it holds the key
'  (LanProbe), so the token never goes to a stranger.
' ============================================================

sub lanInit()
    m.lanFails = 0
    m.lanBusy = false
    ' No new race before this time (nowMs), and how long to wait after a race
    ' that found nothing; it doubles up to two minutes through a long outage.
    m.lanNext = 0
    m.lanGap = 15000
    m.publicBase = ""
end sub

' The shell's public base, worked out the way the shell does it (its registry
' override, else its manifest), because an older shell only passes the base it
' loaded from. The library runs inside the shell's channel, so both are
' readable here.
function lanPublicBase() as string
    reg = CreateObject("roRegistrySection", "MarqueeShell")
    if reg.Exists("server") then return reg.Read("server")
    s = CreateObject("roAppInfo").GetValue("marquee_server")
    if s <> "" then return s
    return m.base
end function

' What was learned: { bases, id, key }, or invalid when there is nothing
' usable to race with. The shell reads the same section (ShellScene.brs).
function lanCache() as dynamic
    reg = CreateObject("roRegistrySection", "MarqueeLan")
    if not reg.Exists("key") or not reg.Exists("id") or not reg.Exists("lan") then return invalid
    key = reg.Read("key")
    id = reg.Read("id")
    list = ParseJson(reg.Read("lan"))
    if key = "" or id = "" or list = invalid or type(list) <> "roArray" then return invalid
    bases = []
    for each b in list
        s = str0(b)
        if s <> "" then bases.Push(s)
    end for
    if bases.Count() = 0 then return invalid
    return { bases: bases, id: id, key: key }
end function

' ------------------------------------------------------------ learning
' Whenever signed in. m.base is the public name or a LAN base that has already
' proved itself, so the token only goes somewhere trusted. This skips api() on
' purpose: a server from before /api/lan answers 404 or 401, and neither should
' reach the sign-in gate or Diagnostics. Nothing is learned and that is all.
sub lanLearn()
    if m.token = invalid or m.base = "" then return
    t = newNode("Http")
    t.url = m.base + "/api/lan"
    t.token = m.token
    t.timeoutMs = 10000
    t.observeField("result", "onLanLearned")
    m.lanLearnTask = t
    t.control = "RUN"
end sub

sub onLanLearned(ev as object)
    m.lanLearnTask = invalid
    res = ev.getData()
    d = res.data
    if res.code <> 200 or d = invalid or type(d) <> "roAssociativeArray" then return
    if str0(d.app) <> "marquee" or str0(d.id) = "" or str0(d.key) = "" then return
    bases = []
    if type(d.lan) = "roArray"
        for each b in d.lan
            s = str0(b)
            if Left(s, 7) = "http://" or Left(s, 8) = "https://" then bases.Push(s)
        end for
    end if
    lan = FormatJson(bases)
    reg = CreateObject("roRegistrySection", "MarqueeLan")
    ' Most launches learn exactly what is already there; skip the flash write.
    if reg.Read("id") = str0(d.id) and reg.Read("key") = str0(d.key) and reg.Read("lan") = lan then return
    reg.Write("id", str0(d.id))
    reg.Write("key", str0(d.key))
    reg.Write("lan", lan)
    reg.Flush()
end sub

' ------------------------------------------------------------ resolving
' Races the cached LAN bases, and the public base unless pub is "", then calls
' done(winner) on this thread; winner is "" when nothing answered. False (and
' no call) when nothing has been learned, since then there is nothing to race.
function lanResolve(pub as string, done as dynamic) as boolean
    c = lanCache()
    if c = invalid then return false
    t = newNode("LanProbe")
    if t = invalid then return false
    t.publicBase = pub
    t.lanBases = c.bases
    t.serverId = c.id
    t.key = c.key
    m.lanDone = done
    m.lanTask = t
    m.lanBusy = true
    t.observeField("result", "onLanResolved")
    t.control = "RUN"
    return true
end function

sub onLanResolved(ev as object)
    r = ev.getData()
    m.lanBusy = false
    m.lanTask = invalid
    d = m.lanDone
    m.lanDone = invalid
    base = ""
    if r <> invalid then base = str0(r.base)
    if d <> invalid then d(base)
end sub

' At startup, before anything else is fetched. A new shell has already raced
' (it sets lanResolved); an older one only knows the public name, so try the
' LAN alone here. Public needs no probe: it just served this library. True
' when a probe is running and will call bootGo() itself.
function lanStartup() as boolean
    if isT(m.top.lanResolved) then return false
    c = lanCache()
    if c = invalid then return false
    for each b in c.bases
        if b = m.base then return false
    end for
    return lanResolve("", lanOnStartup)
end function

sub lanOnStartup(base as string)
    if base <> "" then m.base = base
    bootGo()
end sub

' Every API answer from the active base comes through here (Net.brs). Two in a
' row with no HTTP answer at all (code 0) mean the base itself has gone, e.g.
' the internet dropped while on the public name, or the TV moved off the LAN:
' race again, with the public name in it.
sub lanNote(code as dynamic)
    if num(code, 0) > 0
        m.lanFails = 0
        return
    end if
    m.lanFails = m.lanFails + 1
    if m.lanFails < 2 or m.lanBusy or nowMs() < m.lanNext then return
    if lanResolve(m.publicBase, lanOnReresolved) then m.lanFails = 0
end sub

sub lanOnReresolved(base as string)
    if base = ""
        ' Nothing answered: stay put (the screens already say they can't reach
        ' the server), and don't race again every few seconds through an outage.
        m.lanNext = nowMs() + m.lanGap
        m.lanGap = m.lanGap * 2
        if m.lanGap > 120000 then m.lanGap = 120000
        return
    end if
    m.lanGap = 15000
    if base <> m.base then lanSwitch(base)
end sub

' Everything that builds a URL reads m.base at the moment it builds it (api,
' absUrl, artUrl, the player, Live TV), so switching is one assignment. What is
' already on screen still points at the old host (art URLs in the JSON follow
' the host of the request), so the current screen loads again from the new one.
' An open player, detail or modal is left alone rather than yanked away; the
' next thing it fetches goes to the new base.
sub lanSwitch(base as string)
    old = m.base
    m.base = base
    m.lanFails = 0
    tele("native", { type: "lan-switch", stack: old + " > " + base })
    if m.user = invalid
        ' Still at the sign-in gate because the server couldn't be reached:
        ' check the session again on the new base. Signed out, the next sign-in
        ' just goes there.
        if m.token <> invalid then apiGet("/api/me", onMe)
        return
    end if
    if isT(m.playerOpen) or isT(m.detailOpen) or isT(m.authOpen) then return
    if m.modalOpen <> invalid and m.modalOpen <> "" then return
    renderView()
end sub
