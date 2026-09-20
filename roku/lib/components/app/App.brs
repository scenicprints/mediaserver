' ============================================================
'  The app: boot, sign-in gate, layers, views, and the remote.
'  Mirrors public/app.js init() + setView/renderView, with the
'  keys routed the way the Android TV shell routes them (Back is
'  the web's Backspace).
' ============================================================

sub init()
    m.base = ""
    m.token = regRead("token", "")
    if m.token = "" then m.token = invalid
    m.appVersion = "roku"
    m.prefs = {}
    m.user = invalid
    m.currentView = "home"
    m.isRemoteViewer = false
    m.remoteCap = { height: 1080, kbps: 6000 }
    themeInit()
    netInit()
    focusInit()
    teleInit()

    ' Layers, bottom to top (the web's z-order).
    m.bgRect = uiRect(m.top, 0, 0, 960, 540, m.c.bg)
    m.pageG = uiGroup(m.top, 0, 0)         ' the document: hero + rows (scrolls)
    m.navG = uiGroup(m.top, 0, 0)          ' .nav (fixed, z 40)
    m.railG = uiGroup(m.top, 0, 0)         ' .az-rail (fixed, z 30, above page)
    m.detailG = uiGroup(m.top, 0, 0)       ' .detail (fixed overlay, z 60)
    m.modalG = uiGroup(m.top, 0, 0)        ' .modal (z 120)
    m.authG = uiGroup(m.top, 0, 0)         ' .auth-overlay (z 200)
    m.playerG = uiGroup(m.top, 0, 0)       ' the native player (its own activity)
    m.toastG = uiGroup(m.top, 0, 0)        ' Android toasts

    page = scAdd("page", m.pageG, "page", 0, 540, 112)
    page.onScroll = navOnPageScroll
    nav = scAdd("nav", m.navG, "nav", 0, 540)
    nav.fixed = true
    m.onNavMode = navOnMode

    ' Rotation seed: ((Date.now() / 4h) | 0) ^ random32, once per launch.
    a = nowSec() \ 14400
    r = Rnd(2147483646)
    m.rotationSeed = xorInt(a, r)
end sub

function xorInt(a as integer, b as integer) as integer
    return (a or b) and not (a and b)
end function

sub onBase()
    m.base = m.top.base
    ' Test hook: a pinned rotation seed, so a harness can compare these rows
    ' against the web app's (whose Math.random it pins the same way).
    la = m.top.launchArgs
    if la <> invalid and la.mqseed <> invalid then m.rotationSeed = Int(Val(str0(la.mqseed)))
    if la <> invalid and la.mqfreeze <> invalid then m.freezeHero = true
    tele("nav", { view: "boot" })
    teleBoot()
    teleVitalsInit()
    apiGet("/roku/version.json", onLibVersion)
    boot()
end sub

sub onLibVersion(res as object, ctx as dynamic)
    if res.data <> invalid
        m.appVersion = "roku " + str0(res.data.lib) + " / shell " + str0(m.top.shellVersion)
        shellUpdateCheck(res.data)
    end if
end sub

sub boot()
    loginInit()
    ' The ribbon is static HTML on the web: it is there behind the sign-in card.
    navBuild()
    if m.token = invalid
        showAuth()
        return
    end if
    apiGet("/api/me", onMe)
end sub

sub onMe(res as object, ctx as dynamic)
    if res.code = 200 and res.data <> invalid and res.data.user <> invalid
        m.user = res.data.user
        hideAuth()
        startApp()
    else if res.code = 0
        ' Server unreachable: say so on the sign-in card rather than a blank page.
        showAuth()
        authError("Could not reach the server.")
    else
        showAuth()
    end if
end sub

sub startApp()
    navBuild()
    loadAll(startAppLoaded)
end sub

sub startAppLoaded()
    renderView()
end sub

' app.js loadAll(): prefs (server-side, per account) and the viewer's
' remote/cap flags. The rows themselves come from /api/roku/browse.
sub loadAll(done as dynamic)
    m.loadDone = done
    m.loadLeft = 3
    apiGet("/api/prefs", onPrefs)
    apiGet("/api/settings", onSettingsLoaded)
    ' refreshPreroll(): prefetch the movie pre-roll's availability.
    apiGet("/api/preroll", onPreroll)
end sub

sub onPrefs(res as object, ctx as dynamic)
    if res.data <> invalid and type(res.data) = "roAssociativeArray" then m.prefs = res.data
    loadStep()
end sub

sub onSettingsLoaded(res as object, ctx as dynamic)
    s = res.data
    if s <> invalid
        if s.remote <> invalid then m.isRemoteViewer = isT(s.remote)
        if s.remoteCap <> invalid then m.remoteCap = s.remoteCap
        m.settingsData = s
    end if
    loadStep()
end sub

sub onPreroll(res as object, ctx as dynamic)
    m.prerollInfo = invalid
    if res.data <> invalid and isT(res.data.available) then m.prerollInfo = res.data
    loadStep()
end sub

sub loadStep()
    m.loadLeft = m.loadLeft - 1
    if m.loadLeft <= 0 and m.loadDone <> invalid
        d = m.loadDone
        m.loadDone = invalid
        d()
    end if
end sub

function getPref(key as string) as dynamic
    return m.prefs[key]
end function

sub setPref(key as string, value as dynamic)
    if value = invalid or str0(value) = ""
        m.prefs.Delete(key)
        apiPost("/api/prefs", { key: key, value: invalid })
    else
        m.prefs[key] = str0(value)
        apiPost("/api/prefs", { key: key, value: value })
    end if
end sub

' ------------------------------------------------------------ views
sub setView(view as string)
    stopActivePlayer()
    tele("nav", { view: view })
    m.currentView = view
    navSetActive(view)
    m.searchText = ""
    navPaintSearch()
    scSetScroll(m.sc["page"], 0)
    m.sc["page"].pendingScroll = invalid
    renderView()
end sub

sub renderView()
    if m.currentView <> "livetv" then stopLiveTv()
    stopRequestsPolling()
    railClear()
    v = m.currentView
    if v = "library"
        renderLibrary()
    else if v = "collections"
        renderCollections()
    else if v = "livetv"
        renderLiveTv()
    else
        renderBrowse(v)
    end if
end sub

' The page (document) is rebuilt for each view.
' The web only scrolls to the top on a tab change (setView) and when a grid
' opens; every other re-render keeps window.scrollY, clamped by the browser to
' the new document height. So the scroll is carried over the rebuild and put
' back once the new height is known (pageSetHeight).
function pageReset() as object
    clearChildren(m.pageG)
    scReset("page")
    s = m.sc["page"]
    if s.pendingScroll = invalid then s.pendingScroll = s.scrollY
    s.contentH = 540
    scSetScroll(s, 0)
    m.heroTimerStop = true
    heroStop()
    return m.pageG
end function

sub pageSetHeight(h as dynamic)
    s = m.sc["page"]
    s.contentH = maxf(h, 540)
    y = s.scrollY
    if s.pendingScroll <> invalid then y = s.pendingScroll
    s.pendingScroll = invalid
    scSetScroll(s, y)
end sub

' ------------------------------------------------------------ remote
function onKeyEvent(key as string, press as boolean) as boolean
    if isT(m.debug) and press then print "[key] "; key
    if isT(m.playerOpen) then return playerKey(key, press)
    if not press then return true
    if isT(m.kbOpen) then return false
    ' A few layers own their own keys, as their web handlers capture first.
    if m.chooserKey <> invalid
        f = m.chooserKey
        if f(key) then return true
    end if
    if m.currentView = "livetv" and not isT(m.detailOpen) and (m.modalOpen = invalid or m.modalOpen = "") and not isT(m.authOpen)
        if liveTvKey(key) then return true
    end if
    if key = "up"
        fMove("up")
    else if key = "down"
        fMove("down")
    else if key = "left"
        fMove("left")
    else if key = "right"
        fMove("right")
    else if key = "OK"
        if m.fCur <> invalid then fActivate()
    else if key = "back"
        appBack()
    end if
    ' Back never leaves the app, as on Android TV (Home does that).
    return true
end function

' focus.js back().
sub appBack()
    if isT(m.authOpen) then return
    if m.modalOpen <> invalid and m.modalOpen <> ""
        closeModal()
        return
    end if
    if isT(m.detailOpen)
        closeDetail()
        return
    end if
    if isT(m.gridBackActive)
        gridBack()
        return
    end if
    if m.fCur <> invalid and m.fCur.sc = "nav" then return
    fToRibbon()
end sub

' ------------------------------------------------------------ toast
' Android's Toast.makeText(..., LENGTH_LONG): bottom-centre, 3.5s.
sub toast(text as string)
    clearChildren(m.toastG)
    st = { v: "R400", s: 14, c: "0xFFFFFFFF", lh: 20 }
    w = textWidth(text, st) + 32
    g = uiGroup(m.toastG, (960 - w) / 2, 460)
    uiRect(g, 0, 0, w, 36, "0x323232E6")
    uiText(g, text, st, 16, 8)
    if m.toastTimer = invalid
        m.toastTimer = CreateObject("roSGNode", "Timer")
        m.toastTimer.duration = 3.5
        m.toastTimer.observeField("fire", "toastHide")
    end if
    m.toastTimer.control = "start"
end sub

sub toastHide()
    clearChildren(m.toastG)
end sub
