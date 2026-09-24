' Load the app from the server as a SceneGraph component library, then hand the
' screen to it. If the server can't be reached, say so and keep trying: the
' shell must never sit on a blank screen, and it must never need changing to
' fix the app.
'
' The server has two addresses: its public name, and its address on the home
' network, which the app learns while online (docs/LAN.md) and keeps in the
' MarqueeLan registry section. When that is known the shell races the two and
' loads from whichever answers, so the app still starts when the internet is
' down but the server in the house is up.

sub init()
    m.top.backgroundColor = "0x141416FF"
    m.top.backgroundUri = ""
    brand = CreateObject("roSGNode", "Font")
    brand.uri = "pkg:/fonts/A600t30.ttf"
    brand.size = 68
    m.top.findNode("brand").font = brand
    small = CreateObject("roSGNode", "Font")
    small.uri = "pkg:/fonts/A600t16.ttf"
    small.size = 24
    m.status = m.top.findNode("status")
    m.status.font = small
    ai = CreateObject("roAppInfo")
    m.server = ai.GetValue("marquee_server")
    ' A registry override, for pointing a test device at another server.
    reg = CreateObject("roRegistrySection", "MarqueeShell")
    if reg.Exists("server") then m.server = reg.Read("server")
    ' Where the app is loaded from this time: the public name unless the race
    ' finds the server on the LAN.
    m.base = m.server
    m.shellVersion = Val(ai.GetValue("build_version"))
    m.attempt = 0
    m.retry = CreateObject("roSGNode", "Timer")
    m.retry.duration = 5
    m.retry.observeField("fire", "resolveAndLoad")
    resolveAndLoad()
end sub

' With nothing learned yet this is just loadLib() from the public name, as it
' always was. It runs again before every retry, so an outage that starts after
' launch still finds the LAN.
sub resolveAndLoad()
    lan = lanCache()
    if lan = invalid
        loadLib()
        return
    end if
    if m.probe <> invalid then m.probe.unobserveField("result")
    m.probe = CreateObject("roSGNode", "ShellLanProbe")
    m.probe.publicBase = m.server
    m.probe.lanBases = lan.bases
    m.probe.serverId = lan.id
    m.probe.key = lan.key
    m.probe.observeField("result", "onResolved")
    m.probe.control = "RUN"
end sub

' Neither answering keeps the last base; the load then fails and says so.
sub onResolved()
    r = m.probe.result
    if r <> invalid and r.base <> invalid and r.base <> "" then m.base = r.base
    loadLib()
end sub

' What the app learned: { bases, id, key }, or invalid when there is nothing
' usable to race with.
function lanCache() as dynamic
    reg = CreateObject("roRegistrySection", "MarqueeLan")
    if not reg.Exists("key") or not reg.Exists("id") or not reg.Exists("lan") then return invalid
    key = reg.Read("key")
    id = reg.Read("id")
    list = ParseJson(reg.Read("lan"))
    if key = "" or id = "" or list = invalid or type(list) <> "roArray" then return invalid
    bases = []
    for each b in list
        t = type(b)
        if t = "roString" or t = "String"
            if b <> "" then bases.Push(b)
        end if
    end for
    if bases.Count() = 0 then return invalid
    return { bases: bases, id: id, key: key }
end function

sub loadLib()
    if m.lib <> invalid
        m.lib.unobserveField("loadStatus")
        m.top.removeChild(m.lib)
    end if
    m.attempt = m.attempt + 1
    m.lib = m.top.createChild("ComponentLibrary")
    m.lib.id = "MarqueeLib"
    m.lib.observeField("loadStatus", "onLoadStatus")
    ' A fresh URL per launch, so a Roku never runs yesterday's cached app.
    dt = CreateObject("roDateTime")
    m.lib.uri = m.base + "/roku/marquee.zip?t=" + dt.AsSeconds().ToStr()
end sub

sub onLoadStatus()
    st = m.lib.loadStatus
    if st = "ready"
        app = m.top.findNode("app")
        main = app.createChild("MarqueeLib:Main")
        if main = invalid
            fail("The app downloaded but would not start.")
            return
        end if
        main.shellVersion = m.shellVersion
        if m.top.launchArgs <> invalid then main.launchArgs = m.top.launchArgs
        ' The race is done, so the app need not run its own at startup (an app
        ' loaded by an older shell does). Set before base, which starts it.
        if main.hasField("lanResolved") then main.lanResolved = true
        main.base = m.base
        m.top.findNode("splash").visible = false
        main.setFocus(true)
        m.main = main
        m.top.observeField("inputArgs", "onInput")
    else if st = "failed"
        fail("Can't reach the Marquee server.")
    end if
end sub

sub fail(why as string)
    m.status.text = UCase(why) + "  TRYING AGAIN…"
    m.retry.control = "start"
end sub

sub onInput()
    if m.main <> invalid then m.main.inputArgs = m.top.inputArgs
end sub
