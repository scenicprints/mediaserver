' ============================================================
'  Settings (index.html #settings + app.js openSettings and the
'  per-tab handlers), as a signed-in viewer sees it. The admin
'  blocks (folders, engines, accounts, Now Playing, Diagnostics,
'  updates) are display:none for a viewer and are not here.
'
'  Measured: the sheet 902.4 x 442.8 at 28.8,48.6 (94vw, 82vh),
'  padding 26x24, 1px line, panel fill, scrolling inside; the
'  close circle 38px at top 16 / right 18; the account row (panel-2,
'  padding 12x14) then 18 below it the tab strip (15px 600, padding
'  10x18, a 2px underline, signal when active); each block a
'  .sub-account: 22 above, 16 padding, a hairline on top; h3 15px
'  700/24, p.muted 13px/20.8 with 16 below; inputs 35 tall, 8 apart.
' ============================================================

sub openSettings()
    m.modalOpen = "settings"
    if m.setTab = invalid then m.setTab = "general"
    m.setFields = {}
    m.setStatus = {}
    apiGet("/api/settings", onSettingsSheet)
    apiGet("/api/version", onSetVersion)
    apiGet("/api/providers", onSetProviders)
    settingsRender(invalid)
end sub

' loadSources(): the account's streaming sources (per user, server-side).
sub onSetProviders(res as object, ctx as dynamic)
    d = res.data
    if d = invalid or d.providers = invalid then return
    m.setSources = d
    if m.modalOpen = "settings" and m.setTab = "streaming" then settingsRender(settingsFocusKey())
end sub

sub onSettingsSheet(res as object, ctx as dynamic)
    m.setData = res.data
    if m.setData <> invalid
        if m.setData.remote <> invalid then m.isRemoteViewer = isT(m.setData.remote)
        if m.setData.remoteCap <> invalid then m.remoteCap = m.setData.remoteCap
        os = m.setData.openSubtitles
        if os <> invalid and isT(os.configured) then m.setFields["os-user"] = str0(os.username)
    end if
    if m.modalOpen = "settings" then settingsRender(settingsFocusKey())
end sub

sub onSetVersion(res as object, ctx as dynamic)
    v = res.data
    t = "version unavailable"
    if v <> invalid
        if str0(v.sha) <> "" and v.sha <> "unknown"
            t = "version " + v.sha
            if str0(v.date) <> "" then t = t + " · " + v.date
        else
            t = "updates not enabled yet"
        end if
    end if
    m.setVersion = t
    if m.modalOpen = "settings" then settingsRender(settingsFocusKey())
end sub

function settingsFocusKey() as dynamic
    if m.fCur <> invalid and m.fCur.sc = "settings" then return m.fCur.skey
    return invalid
end function

sub closeModal()
    if m.modalOpen = "settings" then stopRequestsPolling()
    m.modalOpen = ""
    clearChildren(m.modalG)
    scReset("settings")
    ' focus.js: the modal hid; focus inside it is gone.
    if m.fCur <> invalid and m.fCur.sc = "settings" then m.fCur = invalid
end sub

' (Re)draw the whole sheet; keep focus on the control with skey `keep`.
sub settingsRender(keep as dynamic)
    g = m.modalG
    clearChildren(g)
    oldScroll = 0
    if m.sc["settings"] <> invalid then oldScroll = m.sc["settings"].scrollY
    scReset("settings")
    uiRect(g, 0, 0, 960, 540, "0x06070AE6")
    ' .sheet: 902.4 wide, as tall as its content up to max-height 82vh (442.8),
    ' centred in the modal. The content is built first, then the sheet is sized
    ' and placed around it.
    sx = 28.8
    sw = 902.4
    shMax = 442.8
    clip = uiGroup(g, sx + 1, 0)
    content = uiGroup(clip, -(sx + 1), 0)
    s = scAdd("settings", content, "modal", 0, shMax - 2, 0)
    s.nodeTop = 0
    m.setContent = content
    x = sx + 1 + 24
    w = sw - 2 - 48
    ' Content coordinates are relative to the sheet's inner top (the scroller).
    y = 26
    ' The close circle.
    cg = uiGroup(content, sx + sw - 1 - 18 - 38, 16)
    setClosePaint(cg, false)
    setItem({ x: sx + sw - 1 - 18 - 38, y: 16, w: 38, h: 38, kind: "close", skey: "close", cg: cg, onFocus: setCloseFocus, onBlur: setCloseBlur, onSelect: setCloseSelect })
    ' Account row.
    rowH = 12 + 43 + 12 + 2
    uiRect(content, x, y, w, rowH, m.c.panel2)
    uiFrame(content, x, y, w, rowH, 1, m.c.line)
    name = "…"
    if m.user <> invalid then name = str0(m.user.username)
    t1 = "Signed in as "
    uiText(content, t1, { v: "A400", s: 16, c: m.c.text, lh: 25.6 }, x + 15, y + (rowH - 25.6) / 2)
    uiText(content, name, { v: "A600", s: 16, c: m.c.text, lh: 25.6 }, x + 15 + measure(t1, "A400", 16), y + (rowH - 25.6) / 2)
    lo = uiBtn(invalid, 0, 0, "Log out")
    btnPlace(content, lo, x + w - 15 - lo.w, y + 13)
    setBtnItem(lo, "logout", setLogout, "")
    y = y + rowH + 18
    ' Tabs.
    tabs = [{ k: "general", l: "General" }, { k: "display", l: "Display" }, { k: "audio", l: "Audio" }, { k: "streaming", l: "Streaming" }, { k: "requests", l: "Requests" }]
    tx = x
    tst = { v: "A600", s: 15 }
    for each t in tabs
        tw = measure(t.l, "A600", 15) + 36
        tg = uiGroup(content, tx, y)
        tb = { g: tg, w: tw, l: t.l, active: (t.k = m.setTab) }
        setTabPaint(tb, false)
        setItem({ x: tx, y: y, w: tw, h: 38, kind: "tab", hg: "settabs", skey: "tab:" + t.k, tab: tb, k: t.k, onFocus: setTabFocus, onBlur: setTabBlur, onSelect: setTabSelect })
        tx = tx + tw + 4
    end for
    uiRect(content, x, y + 37, w, 1, m.c.line)
    y = y + 38
    ' The panel.
    if m.setTab = "general"
        y = setGeneral(content, x, y, w)
    else if m.setTab = "display"
        y = setDisplay(content, x, y, w)
    else if m.setTab = "audio"
        y = setAudio(content, x, y, w)
    else if m.setTab = "streaming"
        y = setStreaming(content, x, y, w)
    else if m.setTab = "requests"
        y = setRequests(content, x, y, w)
    end if
    ' Footer: 22 above, 16 padding, hairline; the version (Check for updates is admin-only).
    y = y + 22
    uiRect(content, x, y, w, 1, m.c.line)
    vt = m.setVersion
    if vt = invalid then vt = "version …"
    uiText(content, vt, { v: "A400", s: 13, c: m.c.muted, lh: 20.8 }, x, y + 1 + 16)
    ' The version line's 16px bottom margin stays inside the footer.
    y = y + 1 + 16 + 20.8 + 16
    innerH = y + 26
    sh = minf(innerH + 2, shMax)
    sy = (540 - sh) / 2
    g.insertChild(popShadow(invalid, sx, sy, sw, sh), 1)
    g.insertChild(uiRect(invalid, sx, sy, sw, sh, m.c.panel), 2)
    clip.translation = [pxs(sx + 1), pxs(sy + 1)]
    clip.clippingRect = [0, 0, pxs(sw - 2), pxs(sh - 2)]
    uiFrame(g, sx, sy, sw, sh, 1, m.c.line)
    s.viewTop = sy + 1
    s.viewH = sh - 2
    s.contentH = maxf(innerH, sh - 2)
    ' .close is position:absolute, so it paints above the account row it overlaps.
    content.removeChild(cg)
    content.appendChild(cg)
    scSetScroll(s, oldScroll)
    ' Seat focus.
    if keep <> invalid
        for each it in m.fItems["settings"]
            if it.skey = keep
                m.fCur = invalid
                fSet(it)
                return
            end if
        end for
    end if
    fReseat()
end sub

function setItem(it as object) as object
    it.sc = "settings"
    return fAdd(it)
end function

sub btnPlace(parent as object, b as object, x as dynamic, y as dynamic)
    b.x = x
    b.y = y
    b.node.translation = [pxs(x), pxs(y)]
    parent.appendChild(b.node)
end sub

function setBtnItem(b as object, skey as string, fn as dynamic, hg as string, extra = invalid as dynamic) as object
    ex = { skey: skey, hg: hg }
    if extra <> invalid then ex.Append(extra)
    return btnItem(b, "settings", fn, ex)
end function

' .close: a 38px circle, panel-2, 1px line, ✕ 15px.
sub setClosePaint(cg as object, focused as boolean)
    clearChildren(cg)
    if focused then circleGlowNode(cg, -1, -1)
    uiImage(cg, "icons/disc.png", 0, 0, 38, 38, m.c.panel2)
    uiImage(cg, "icons/ring80.png", 0, 0, 38, 38, m.c.line)
    uiText(cg, "✕", { v: "A400", s: 15, c: m.c.text, lh: 38, w: 38, align: "center" }, 0, 0)
end sub

sub setCloseFocus(it as object)
    setClosePaint(it.cg, true)
end sub

sub setCloseBlur(it as object)
    setClosePaint(it.cg, false)
end sub

sub setCloseSelect(it as object)
    closeModal()
end sub

' .settings-tabs .tab: 15px 600, padding 10x18, a 2px bottom border.
sub setTabPaint(tb as object, focused as boolean)
    g = tb.g
    clearChildren(g)
    if focused
        gl = glowNode(g, 0, 0, tb.w, 38)
        gl.visible = true
    end if
    ink = m.c.muted
    if tb.active then ink = m.c.text
    uiText(g, tb.l, { v: "A600", s: 15, c: ink, lh: 16.3 }, 18, 10)
    if tb.active then uiRect(g, 0, 36, tb.w, 2, m.c.accent)
end sub

sub setTabFocus(it as object)
    setTabPaint(it.tab, true)
end sub

sub setTabBlur(it as object)
    setTabPaint(it.tab, false)
end sub

sub setTabSelect(it as object)
    stopRequestsPolling()
    m.setTab = it.k
    sset = m.sc["settings"]
    if sset <> invalid then sset.scrollY = 0
    settingsRender("tab:" + it.k)
end sub

' A .sub-account block head. Returns y after the paragraph (its 16px margin
' included). first: the panel's first block (Audio/Streaming drop the rule).
function setBlockHead(g as object, x as dynamic, y as dynamic, w as dynamic, title as dynamic, para as dynamic, rule as boolean) as dynamic
    if rule
        y = y + 22
        uiRect(g, x, y, w, 1, m.c.line)
        y = y + 1 + 16
    end if
    if title <> invalid
        if type(title) = "roArray"
            uiRich(g, title, { v: "A600", s: 15, c: m.c.text, lh: 24 }, x, y)
        else
            uiText(g, title, { v: "A600", s: 15, c: m.c.text, lh: 24 }, x, y)
        end if
        y = y + 24 + 6
    end if
    if para <> invalid
        st = { v: "A400", vb: "A600", s: 13, c: m.c.muted, lh: 20.8 }
        if type(para) = "roArray"
            h = uiRuns(g, para, st, x, y, w)
        else
            p = uiPara(g, para, st, x, y, w)
            h = p.h
        end if
        y = y + h + 16
    end if
    return y
end function

' .sa-input: panel-2, 1px line, padding 9x12, Roboto 13.33px (the WebView's
' input font). A focused one has no ring: .sa-input is not in the focus
' styles, only its :focus border when actually editing.
function setInput(g as object, key as string, placeholder as string, secure as boolean, x as dynamic, y as dynamic, w as dynamic) as object
    fg = uiGroup(g, x, y)
    f = { g: fg, key: key, ph: placeholder, secure: secure, w: w }
    setInputPaint(f)
    setItem({ x: x, y: y, w: w, h: 35, kind: "input", input: true, skey: "in:" + key, field: f, onSelect: setInputEdit })
    return f
end function

sub setInputPaint(f as object)
    g = f.g
    clearChildren(g)
    editing = isT(m.kbOpen) and m.kbFor = "set:" + f.key
    uiRect(g, 0, 0, f.w, 35, m.c.panel2)
    bc = m.c.line
    if editing then bc = m.c.accent
    uiFrame(g, 0, 0, f.w, 35, 1, bc)
    v = m.setFields[f.key]
    if v = invalid then v = ""
    if v = ""
        uiText(g, f.ph, { v: "R400", s: 13.33, c: "0x757575FF", lh: 15.6, w: f.w - 26 }, 13, 9.7)
    else
        shown = v
        if f.secure
            shown = ""
            for i = 1 to Len(v)
                shown = shown + "•"
            end for
        end if
        uiText(g, shown, { v: "R400", s: 13.33, c: m.c.text, lh: 15.6, w: f.w - 26 }, 13, 9.7)
    end if
end sub

sub setInputEdit(it as object)
    f = it.field
    m.setEditing = f
    v = m.setFields[f.key]
    openKeyboard("set:" + f.key, f.ph, v, f.secure, invalid, setInputDone)
    setInputPaint(f)
end sub

sub setInputDone(text as string)
    f = m.setEditing
    if f = invalid then return
    m.setFields[f.key] = text
    setInputPaint(f)
end sub

' ------------------------------------------------------------ General
function setGeneral(g as object, x as dynamic, y as dynamic, w as dynamic) as dynamic
    os = invalid
    if m.setData <> invalid then os = m.setData.openSubtitles
    configured = os <> invalid and isT(os.configured)
    st = m.setStatus["os"]
    if st = invalid
        if configured
            st = "✓ Subtitle search is on"
            if str0(os.username) <> "" then st = st + " (" + os.username + ")"
            st = st + "."
        else
            st = "Add your free OpenSubtitles account to enable subtitle search."
        end if
    end if
    y = setBlockHead(g, x, y, w, "Your subtitle account (OpenSubtitles)", st, true)
    ' Inputs: 8px margins, collapsing into the paragraph's 16.
    setInput(g, "os-key", "API key", false, x, y, w)
    y = y + 35 + 8
    setInput(g, "os-user", "Username", false, x, y, w)
    y = y + 35 + 8
    setInput(g, "os-pass", "Password", true, x, y, w)
    y = y + 35 + 8
    svOpts = { primary: true, play: false, flat: true }
    ' In the flex row beside Disconnect it stretches to that button's 43.
    if configured then svOpts.h = 43
    sv = uiBtn(invalid, 0, 0, "Save subtitle account", svOpts)
    btnPlace(g, sv, x, y)
    setBtnItem(sv, "os-save", setOsSave, "os-row")
    if configured
        dc = uiBtn(invalid, 0, 0, "Disconnect")
        btnPlace(g, dc, x + sv.w + 10, y)
        setBtnItem(dc, "os-clear", setOsClear, "os-row")
    end if
    y = y + sv.h
    pst = m.setStatus["pw"]
    if pst = invalid then pst = "Changing it signs you out on your other devices. This one stays signed in."
    y = setBlockHead(g, x, y, w, "Your password", pst, true)
    y = y + 8
    half = (w - 8) / 2
    setInput(g, "pw-current", "Current password", true, x, y, half)
    setInput(g, "pw-new", "New password", true, x + half + 8, y, half)
    y = y + 35 + 8
    pb = uiBtn(invalid, 0, 0, "Change password", { primary: true, play: false, flat: true })
    btnPlace(g, pb, x, y)
    setBtnItem(pb, "pw-save", setPwSave, "")
    return y + 41
end function

sub setOsSave(it as object)
    body = { apiKey: str0(m.setFields["os-key"]).Trim(), username: str0(m.setFields["os-user"]).Trim(), password: str0(m.setFields["os-pass"]) }
    btnSetLabel(it.btn, "Saving…")
    apiPost("/api/settings/opensubtitles", body, onOsSaved)
end sub

sub onOsSaved(res as object, ctx as dynamic)
    d = res.data
    if d = invalid then d = {}
    if m.setData <> invalid then m.setData.openSubtitles = d
    m.setStatus.Delete("os")
    m.setFields["os-key"] = ""
    m.setFields["os-pass"] = ""
    if str0(d.username) <> "" then m.setFields["os-user"] = d.username
    settingsRender("os-save")
end sub

sub setOsClear(it as object)
    confirmDialog("Disconnect your OpenSubtitles account? Subtitle search turns off until you add it again.", setOsClearYes)
end sub

sub setOsClearYes()
    apiPost("/api/settings/opensubtitles", { clear: true }, onOsCleared)
end sub

sub onOsCleared(res as object, ctx as dynamic)
    d = res.data
    if d = invalid then d = {}
    if m.setData <> invalid then m.setData.openSubtitles = d
    m.setStatus.Delete("os")
    m.setFields["os-key"] = ""
    m.setFields["os-user"] = ""
    m.setFields["os-pass"] = ""
    settingsRender("os-save")
end sub

sub setPwSave(it as object)
    cur = str0(m.setFields["pw-current"])
    nxt = str0(m.setFields["pw-new"])
    if cur = "" or nxt = "" then return
    apiPost("/api/me/password", { currentPassword: cur, newPassword: nxt }, onPwSaved)
end sub

sub onPwSaved(res as object, ctx as dynamic)
    if res.code >= 200 and res.code < 300
        m.setFields["pw-current"] = ""
        m.setFields["pw-new"] = ""
        m.setStatus["pw"] = "Password changed. Your other devices have been signed out."
    else
        msg = "Could not change the password."
        if res.data <> invalid and str0(res.data.error) <> "" then msg = res.data.error
        m.setStatus["pw"] = msg
    end if
    settingsRender("pw-save")
end sub

sub setLogout(it as object)
    apiPost("/api/logout", invalid, onLoggedOut)
end sub

' location.reload(): back to a signed-out start.
sub onLoggedOut(res as object, ctx as dynamic)
    closeModal()
    m.token = invalid
    regWrite("token", invalid)
    m.user = invalid
    ' A fresh page: Home, the ribbon as it loads (not in remote mode), no rows.
    heroStop()
    clearChildren(m.pageG)
    scReset("page")
    m.fCur = invalid
    m.navMode = false
    m.currentView = "home"
    navBuild()
    showAuth()
end sub

' ------------------------------------------------------------ Display
function setDisplay(g as object, x as dynamic, y as dynamic, w as dynamic) as dynamic
    y = setBlockHead(g, x, y, w, "Finish", "White is the daytime housing. Black is the same system for a dark room. Saved for this device, because it depends on this room and this screen. The player is always black either way.", true)
    opts = [{ v: "auto", l: "Match the device" }, { v: "white", l: "White" }, { v: "black", l: "Black" }]
    y = setSeg(g, x, y, w, opts, m.finish, "finish", setFinishPick, "active")
    return y - 18
end function

' An .add-row.seg of buttons (gap 10, wrapping, 18 below). selStyle "active"
' fills the chosen one with ink; "primary" fills it with the signal.
function setSeg(g as object, x as dynamic, y as dynamic, w as dynamic, opts as object, current as dynamic, group as string, fn as dynamic, selStyle as string) as dynamic
    cx = x
    cy = y
    for each o in opts
        parts = o.parts
        if parts = invalid then parts = [o.l]
        sel = (str0(o.v) = str0(current))
        bopts = { parts: parts, play: false }
        if sel and selStyle = "primary"
            ' .btn.primary: borderless, stretched to the row's 43.
            bopts.primary = true
            bopts.flat = true
            bopts.h = 43
        end if
        b = uiBtn(invalid, 0, 0, o.l, bopts)
        if sel and selStyle = "active"
            b.selected = true
            btnPaint(b, false)
        end if
        if cx + b.w > x + w and cx > x
            cx = x
            cy = cy + 43 + 10
        end if
        btnPlace(g, b, cx, cy)
        setBtnItem(b, group + ":" + str0(o.v), fn, group, { segVal: o.v })
        cx = cx + b.w + 10
    end for
    return cy + 43 + 18
end function

sub setFinishPick(it as object)
    regWrite("finish", it.segVal)
    themeApply(it.segVal)
    ' Every surface takes the new tokens: redraw the app under the sheet.
    m.bgRect.color = m.c.bg
    navBuild()
    m.fontCache = m.fontCache
    renderView()
    settingsRender("finish:" + it.segVal)
end sub

' ------------------------------------------------------------ Audio
' Per device (registry), like the web's localStorage audio prefs.
function audioGet(k as string) as string
    defs = { audioMode: "stereo", dboost: "normal", night: "0", norm: "0" }
    return regRead(k, defs[k])
end function

function deviceType() as string
    t = regRead("devtype", "auto")
    if t = "auto" then return "roku"
    return t
end function

function setAudio(g as object, x as dynamic, y as dynamic, w as dynamic) as dynamic
    st = { v: "A400", vb: "A600", s: 13, c: m.c.muted, lh: 20.8 }
    ' The panel's first paragraph sits right on the tab bar (measured).
    h = uiRuns(g, [{ t: "These settings are saved for " }, { t: "this device", b: true }, { t: " (they depend on this screen's speakers) and take effect the next time you start something." }], st, x, y, w)
    y = y + h + 16
    ' The TV player engine block: shown in the Android app (its native player
    ' exists). Classic there is the web player; here it is the server stream.
    y = setBlockHead(g, x, y, w, "TV player engine", "The native player plays every format directly on the TV — no server conversion, best quality. Switch to Classic (the old web player) only if something misbehaves.", false)
    cur = "native"
    if regRead("classicPlayer", "0") = "1" then cur = "classic"
    y = setSeg(g, x, y, w, [{ v: "native", l: "⚡ Native (recommended)", parts: [{ e: "26a1" }, " Native (recommended)"] }, { v: "classic", l: "🌐 Classic", parts: [{ e: "1f310" }, " Classic"] }], cur, "tvplayer", setTvPlayerPick, "primary")
    ' The row's 18px bottom margin collapses through the block and still
    ' separates it from the next (which has no margin of its own).
    ' What are you watching on?
    y = setBlockHead(g, x, y, w, "What are you watching on?", "Different devices understand different audio formats — an Apple TV can't decode DTS at all, a Roku can't decode TrueHD. Tell Marquee what this is and it will pick a soundtrack the device can actually play, instead of making the server convert one on the fly.", false)
    dev = [{ v: "auto", l: "Detect" }, { v: "appletv", l: "Apple TV" }, { v: "androidtv", l: "Android / Google TV" }, { v: "roku", l: "Roku" }, { v: "vava", l: "VAVA projector" }, { v: "browser", l: "Browser" }]
    y = setSeg(g, x, y, w, dev, regRead("devtype", "auto"), "devtype", setDevPick, "primary")
    labels = { appletv: "Apple TV", androidtv: "Android / Google TV", roku: "Roku", vava: "VAVA projector", browser: "Browser" }
    codecs = { appletv: "AAC, AC3, EAC3, MP3, ALAC", androidtv: "AAC, AC3, EAC3, MP3, OPUS, VORBIS, FLAC", roku: "AAC, AC3, EAC3, MP3", vava: "AAC, AC3, EAC3", browser: "AAC, MP3, OPUS, VORBIS, FLAC" }
    t = deviceType()
    note = "Treating this as " + labels[t]
    if regRead("devtype", "auto") = "auto" then note = note + " (detected)"
    note = note + ". It can play: " + codecs[t] + "."
    p = uiPara(g, note, { v: "A400", s: 13, c: m.c.muted, lh: 20.8 }, x, y, w)
    y = y + p.h
    ' Audio output.
    y = setBlockHead(g, x, y, w, "Audio output", [{ t: "If dialogue sometimes goes silent while music and effects keep playing, choose " }, { t: "Stereo", b: true }, { t: " — TVs have two speakers, so the server folds surround (5.1) down to stereo correctly and keeps dialogue out front. " }, { t: "Surround", b: true }, { t: " sends the original track untouched, for a real surround system." }], true)
    y = setSeg(g, x, y, w, [{ v: "stereo", l: "🔉 Stereo (recommended)", parts: [{ e: "1f509" }, " Stereo (recommended)"] }, { v: "surround", l: "🔊 Surround (original)", parts: [{ e: "1f50a" }, " Surround (original)"] }], audioGet("audioMode"), "audioMode", setAudioPick, "primary")
    h = uiRuns(g, [{ t: "This is about your " }, { t: "speakers", b: true }, { t: ", not the device — a projector with a receiver attached wants Surround even though its own speakers are stereo." }], st, x, y, w)
    y = y + h
    y = setBlockHead(g, x, y, w, "Dialogue boost", [{ t: "How far to push spoken dialogue forward while folding surround down. " }, { t: "Strong", b: true }, { t: " is best if voices are still hard to hear. Only affects surround (5.1) sources played in Stereo." }], true)
    y = setSeg(g, x, y, w, [{ v: "off", l: "Off" }, { v: "normal", l: "Normal" }, { v: "strong", l: "Strong" }], audioGet("dboost"), "dboost", setAudioPick, "primary") - 18
    y = setBlockHead(g, x, y, w, "Night mode", "Evens out loud and quiet parts so explosions don't blow out dialogue at low volume — good for late-night watching.", true)
    y = setSeg(g, x, y, w, [{ v: "0", l: "Off" }, { v: "1", l: "On" }], audioGet("night"), "night", setAudioPick, "primary") - 18
    y = setBlockHead(g, x, y, w, "Loudness normalization", "Keeps the overall volume consistent from one title to the next, so you're not reaching for the remote between films.", true)
    y = setSeg(g, x, y, w, [{ v: "0", l: "Off" }, { v: "1", l: "On" }], audioGet("norm"), "norm", setAudioPick, "primary") - 18
    return y
end function

sub setTvPlayerPick(it as object)
    v = "0"
    if it.segVal = "classic" then v = "1"
    regWrite("classicPlayer", v)
    tele("nav", { view: "settings:tvplayer=" + it.segVal })
    settingsRender(it.skey)
end sub

sub setDevPick(it as object)
    regWrite("devtype", it.segVal)
    settingsRender(it.skey)
end sub

sub setAudioPick(it as object)
    regWrite(it.hg, it.segVal)
    settingsRender(it.skey)
end sub

' ------------------------------------------------------------ Streaming
function setStreaming(g as object, x as dynamic, y as dynamic, w as dynamic) as dynamic
    y = y + 4
    ' h3 with the "beta" tag.
    uiText(g, "Streaming services", { v: "A600", s: 15, c: m.c.text, lh: 24 }, x, y)
    bx = x + measure("Streaming services", "A600", 15) + 6
    tagSt = { v: "A600t04", s: 11, c: m.c.accent, lh: 17.6, upper: true }
    tw = textWidth("beta", tagSt) + 18
    uiFrame(g, bx, y + 2.2, tw, 19.6, 1, m.c.line)
    uiText(g, "beta", tagSt, bx + 9, y + 3.2)
    y = y + 24 + 6
    st = { v: "A400", vb: "A600", s: 13, c: m.c.muted, lh: 20.8 }
    h = uiRuns(g, [{ t: "Merge your streaming services into Movies & TV Shows. Streaming titles get a provider badge and open that service when you select them — they can't play in-app (that's DRM). Tap a source to show or hide it:" }], st, x, y, w)
    ' p margin-bottom 16 and the list's margin-top 10 collapse to 16.
    y = y + h + 16
    d = m.setSources
    if d = invalid then return y
    ' .sources-list: wrapping flex row, gap 8. .src-chip: 14px 600, padding
    ' 8x16, 1px border; a row stretches to its tallest chip (the 📁 one is 37,
    ' text-only 33). On: the provider's colour, white text. Off: panel-2 at 72%.
    enabled = {}
    if d.enabled <> invalid
        for each e in d.enabled
            enabled[str0(e)] = true
        end for
    end if
    chips = [{ id: "local", parts: [{ e: "1f4c1" }, " Local library"], color: m.c.accent, on: not (d.local <> invalid and not isT(d.local)), tall: true }]
    for each pv in d.providers
        chips.Push({ id: str0(pv.id), parts: [str0(pv.name)], color: rgba(str0(pv.color), 1.0), on: isT(enabled[str0(pv.id)]), tall: false })
    end for
    st = { v: "A600", s: 14, lh: 17 }
    ' Lay out rows first (each row's height is its tallest chip).
    rows = []
    row = { items: [], tall: false }
    cx = x
    for each c in chips
        c.w = richWidth(c.parts, st) + 34
        if cx + c.w > x + w and row.items.Count() > 0
            rows.Push(row)
            row = { items: [], tall: false }
            cx = x
        end if
        c.x = cx
        row.items.Push(c)
        if c.tall then row.tall = true
        cx = cx + c.w + 8
    end for
    rows.Push(row)
    for each r in rows
        rh = 33
        if r.tall then rh = 37
        for each c in r.items
            c.y0 = y
            cg = uiGroup(g, c.x, y)
            ch = { g: cg, c: c, w: c.w, h: rh, st: st }
            srcChipPaint(ch, false)
            setItem({ x: c.x, y: y, w: c.w, h: rh, kind: "btn", skey: "src:" + c.id, hg: "sources", chip: ch, onFocus: srcChipFocus, onBlur: srcChipBlur, onSelect: srcChipSelect })
        end for
        y = y + rh + 8
    end for
    return y - 8
end function

sub srcChipPaint(ch as object, focused as boolean)
    g = ch.g
    clearChildren(g)
    c = ch.c
    ' .src-chip.tv-focus: the ring and the 1px lift.
    dy = 0
    if focused then dy = -1
    g.translation = [pxs(c.x), pxs(c.y0 + dy)]
    if focused
        gl = glowNode(g, 0, 0, ch.w, ch.h)
        gl.visible = true
    end if
    if c.on
        uiRect(g, 0, 0, ch.w, ch.h, c.color)
        ink = "0xFFFFFFFF"
        g.opacity = 1
    else
        uiRect(g, 0, 0, ch.w, ch.h, m.c.panel2)
        uiFrame(g, 0, 0, ch.w, ch.h, 1, m.c.line)
        ink = m.c.text
        g.opacity = 0.72
    end if
    st = ch.st
    st.c = ink
    uiRich(g, c.parts, st, 17, (ch.h - 17) / 2)
end sub

sub srcChipFocus(it as object)
    srcChipPaint(it.chip, true)
end sub

sub srcChipBlur(it as object)
    srcChipPaint(it.chip, false)
end sub

' Toggle, save the account's sources, then re-merge and repaint browse.
sub srcChipSelect(it as object)
    c = it.chip.c
    c.on = not c.on
    d = m.setSources
    if c.id = "local"
        d.local = c.on
    else
        en = []
        if d.enabled = invalid then d.enabled = []
        for each e in d.enabled
            if str0(e) <> c.id then en.Push(e)
        end for
        if c.on then en.Push(c.id)
        d.enabled = en
    end if
    srcChipPaint(it.chip, true)
    localOn = true
    if d.local <> invalid then localOn = isT(d.local)
    apiPost("/api/providers", { local: localOn, enabled: d.enabled }, onSrcSaved)
end sub

sub onSrcSaved(res as object, ctx as dynamic)
    loadAll(renderView)
end sub

' ------------------------------------------------------------ Requests
function setRequests(g as object, x as dynamic, y as dynamic, w as dynamic) as dynamic
    return buildRequestsUI(g, x, y + 14, w, "settings")
end function

' ------------------------------------------------------------ confirm()
' The WebView's confirm(): Android's two-button dialog.
sub confirmDialog(text as string, onOk as dynamic)
    m.confirm = { text: text, onOk: onOk, idx: 1 }
    if m.confirmG = invalid then m.confirmG = uiGroup(m.top, 0, 0)
    confirmPaint()
    m.chooserKey = confirmKey
end sub

sub confirmPaint()
    g = m.confirmG
    clearChildren(g)
    c = m.confirm
    uiRect(g, 0, 0, 960, 540, "0x00000099")
    w = 420
    lines = wrapLines(c.text, { v: "R400", s: 15 }, w - 48)
    h = 24 + lines.Count() * 22 + 24 + 40 + 8
    x = (960 - w) / 2
    y = (540 - h) / 2
    uiRect(g, x, y, w, h, "0x2E2E30FF")
    for i = 0 to lines.Count() - 1
        uiText(g, lines[i], { v: "R400", s: 15, c: "0xFFFFFFE6", lh: 22 }, x + 24, y + 24 + i * 22)
    end for
    by = y + h - 8 - 40
    labels = ["CANCEL", "OK"]
    bx = x + w - 16
    for i = 1 to 0 step -1
        bw = measure(labels[i], "R700", 14) + 32
        bx = bx - bw
        if c.idx = i then uiRect(g, bx, by, bw, 40, "0xFFFFFF1F")
        uiText(g, labels[i], { v: "R700", s: 14, c: "0x80CBC4FF", lh: 40, w: bw, align: "center" }, bx, by)
        bx = bx - 8
    end for
end sub

function confirmKey(key as string) as boolean
    c = m.confirm
    if key = "left" or key = "right"
        c.idx = 1 - c.idx
        confirmPaint()
    else if key = "OK"
        ok = (c.idx = 1)
        f = c.onOk
        confirmClose()
        if ok then f()
    else if key = "back"
        confirmClose()
    end if
    return true
end function

sub confirmClose()
    m.chooserKey = invalid
    if m.confirmG <> invalid then clearChildren(m.confirmG)
end sub
