' Load the app from the server as a SceneGraph component library, then hand the
' screen to it. If the server can't be reached, say so and keep trying: the
' shell must never sit on a blank screen, and it must never need changing to
' fix the app.

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
    m.shellVersion = Val(ai.GetValue("build_version"))
    m.attempt = 0
    m.retry = CreateObject("roSGNode", "Timer")
    m.retry.duration = 5
    m.retry.observeField("fire", "loadLib")
    loadLib()
end sub

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
    m.lib.uri = m.server + "/roku/marquee.zip?t=" + dt.AsSeconds().ToStr()
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
        main.base = m.server
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
