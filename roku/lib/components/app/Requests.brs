' ============================================================
'  Requests (app.js buildRequestsUI and friends), in Settings >
'  Requests: on a TV the ribbon tab is hidden, so this is the way in.
'
'  Measured (embedded): the title 22px 800/35.2, the sub line 13px
'  muted; the search field 15px (the WebView's input font), padding
'  12x16, 42.7 tall; an unconfigured server shows the centred
'  "Requests need Radarr and/or Sonarr." block with ⚙ Open Settings.
' ============================================================

sub stopRequestsPolling()
    if m.reqQueueTimer <> invalid then m.reqQueueTimer.control = "stop"
    m.reqPolling = false
end sub

' Builds into the settings sheet. Returns the y after it. The live parts
' (status, results, queue) arrive later and redraw the sheet.
function buildRequestsUI(g as object, x as dynamic, y as dynamic, w as dynamic, sc as string) as dynamic
    if m.req = invalid then m.req = { status: invalid, q: "", results: invalid, searching: false, queue: [], profiles: invalid, movieProfile: invalid, tvProfile: invalid, loaded: false }
    r = m.req
    if not r.loaded
        r.loaded = true
        apiGet("/api/requests/status", onReqStatus)
    end if
    uiText(g, "Request something", { v: "A600", s: 22, c: m.c.text, lh: 35.2 }, x, y)
    y = y + 35.2 + 4
    radarrOk = r.status <> invalid and r.status.radarr <> invalid and isT(r.status.radarr.ok)
    sonarrOk = r.status <> invalid and r.status.sonarr <> invalid and isT(r.status.sonarr.ok)
    sub1 = "Can't find a movie or show? Search for it — it'll be sent to your downloaders and show up when it's ready."
    if radarrOk or sonarrOk
        names = []
        if radarrOk then names.Push("Radarr (movies)")
        if sonarrOk then names.Push("Sonarr (TV)")
        sub1 = "Connected to " + joinArr(names, " and ") + ". Search below."
    end if
    p = uiPara(g, sub1, { v: "A400", s: 13, c: m.c.muted, lh: 20.8 }, x, y, w)
    y = y + p.h + 16
    ' Controls: the search box (+ quality groups beside it when configured).
    qg = invalid
    if (radarrOk or sonarrOk) and r.profiles <> invalid then qg = reqQualityGroups(r, radarrOk, sonarrOk)
    iw = w - 12
    fx = x
    fy = y
    fg = uiGroup(g, fx, fy)
    f = { g: fg, w: iw }
    reqInputPaint(f, false)
    enabled = radarrOk or sonarrOk
    ' Unconfigured, the field is disabled, but the focus engine still lands on
    ' it (it doesn't filter disabled); Enter just does nothing.
    f.disabled = not enabled
    setItem({ x: fx, y: fy, w: iw, h: 43, kind: "input", input: true, skey: "req-input", field: f, onFocus: reqInputFocus, onBlur: reqInputBlur, onSelect: reqInputEdit })
    y = y + 43
    if qg <> invalid
        y = y + 12
        y = reqDrawQuality(g, qg, x, y, w)
    end if
    ' Queue. .req-head's 20 bottom margin, the queue's 22/8 collapse: with the
    ' queue empty, 22 between the field and the results.
    if r.queue.Count() > 0
        y = reqDrawQueue(g, r.queue, x, y + 22, w)
    else
        y = y + 22
    end if
    ' Results / empty states.
    if r.status <> invalid and not enabled
        both = r.status.radarr
        so = r.status.sonarr
        detail = "Not set up yet."
        if (both <> invalid and isT(both.configured)) or (so <> invalid and isT(so.configured)) then detail = "Configured, but the server can't reach them right now. Check the URLs/keys in Settings."
        y = y + 40
        bw = measure("Requests need Radarr and/or Sonarr.", "A600", 16)
        uiText(g, "Requests need Radarr and/or Sonarr.", { v: "A600", s: 16, c: m.c.text, lh: 25.6 }, x + (w - bw) / 2, y)
        y = y + 25.6 + 10
        dp = uiPara(g, detail, { v: "A400", s: 13, c: m.c.muted, lh: 20.8, align: "center" }, x + 10, y, w - 20)
        y = y + dp.h + 10
        b = uiBtn(invalid, 0, 0, "⚙ Open Settings", { primary: true, play: false, flat: true })
        btnPlace(g, b, x + (w - b.w) / 2, y)
        setBtnItem(b, "req-open-settings", reqOpenSettings, "")
        y = y + 41 + 40
    else if r.searching
        y = y + 40
        uiText(g, "Searching…", { v: "A400", s: 13, c: m.c.muted, lh: 20.8, w: w, align: "center" }, x, y)
        y = y + 20.8 + 40
    else if r.results <> invalid
        if type(r.results) = "roString" or type(r.results) = "String"
            y = y + 40
            uiText(g, r.results, { v: "A400", s: 13, c: m.c.muted, lh: 20.8, w: w, align: "center" }, x, y)
            y = y + 20.8 + 40
        else
            for each it in r.results
                y = reqCard(g, it, x, y, w) + 12
            end for
        end if
    end if
    if enabled and not isT(m.reqPolling)
        m.reqPolling = true
        reqPollQueue()
    end if
    return y + 4
end function

sub onReqStatus(res as object, ctx as dynamic)
    st = res.data
    if st = invalid then st = {}
    m.req.status = st
    ok = (st.radarr <> invalid and isT(st.radarr.ok)) or (st.sonarr <> invalid and isT(st.sonarr.ok))
    if ok
        apiGet("/api/requests/profiles", onReqProfiles)
    else
        reqRedraw()
    end if
end sub

sub onReqProfiles(res as object, ctx as dynamic)
    if res.data <> invalid then m.req.profiles = res.data
    ' tvSeat(input): once connected, the remote's focus is put on the field.
    if m.modalOpen = "settings" and m.setTab = "requests" then settingsRender("req-input")
end sub

sub reqRedraw()
    if m.modalOpen = "settings" and m.setTab = "requests" then settingsRender(settingsFocusKey())
end sub

sub reqOpenSettings(it as object)
    m.setTab = "general"
    settingsRender("tab:general")
end sub

' .req-input: panel, 1px line (signal while editing), 15px, padding 12x16.
sub reqInputPaint(f as object, focused as boolean)
    g = f.g
    clearChildren(g)
    if focused and not (isT(m.kbOpen) and m.kbFor = "req")
        gl = glowNode(g, 0, 0, f.w, 42.7)
        gl.visible = true
    end if
    uiRect(g, 0, 0, f.w, 42.7, m.c.panel)
    bc = m.c.line
    if isT(m.kbOpen) and m.kbFor = "req" then bc = m.c.accent
    uiFrame(g, 0, 0, f.w, 42.7, 1, bc)
    q = m.req.q
    if q = ""
        uiText(g, "Search for a movie or TV show to request…", { v: "R400", s: 15, c: "0x757575FF", lh: 17.6, w: f.w - 34 }, 17, 12.5)
    else
        uiText(g, q, { v: "R400", s: 15, c: m.c.text, lh: 17.6, w: f.w - 34 }, 17, 12.5)
    end if
end sub

sub reqInputFocus(it as object)
    reqInputPaint(it.field, true)
end sub

sub reqInputBlur(it as object)
    reqInputPaint(it.field, false)
end sub

sub reqInputEdit(it as object)
    if isT(it.field.disabled) then return
    m.reqField = it.field
    openKeyboard("req", "Search for a movie or TV show to request…", m.req.q, false, reqTyped, reqTyped)
end sub

' The input handler: under 2 characters clears; otherwise search after 350ms.
sub reqTyped(text as string)
    m.req.q = text
    if m.reqField <> invalid then reqInputPaint(m.reqField, true)
    q = text.Trim()
    if Len(q) < 2
        m.req.results = invalid
        m.req.searching = false
        reqRedraw()
        return
    end if
    if m.reqDebounce = invalid
        m.reqDebounce = CreateObject("roSGNode", "Timer")
        m.reqDebounce.duration = 0.35
        m.reqDebounce.observeField("fire", "reqSearchNow")
    end if
    m.reqDebounce.control = "stop"
    m.reqDebounce.control = "start"
end sub

sub reqSearchNow()
    q = m.req.q.Trim()
    m.req.searching = true
    m.req.results = invalid
    reqRedraw()
    apiGet("/api/requests/search?q=" + enc(q), onReqSearch, q)
end sub

sub onReqSearch(res as object, q as string)
    if m.req.q.Trim() <> q then return
    m.req.searching = false
    if res.code <> 200
        msg = "Search failed."
        if res.data <> invalid and str0(res.data.error) <> "" then msg = res.data.error
        m.req.results = msg
    else if res.data = invalid or res.data.Count() = 0
        m.req.results = "No matches found."
    else
        m.req.results = res.data
    end if
    reqRedraw()
end sub

' Quality: segmented .btn rows, one per configured service.
function reqQualityGroups(r as object, radarrOk as boolean, sonarrOk as boolean) as object
    out = []
    if r.movieProfile = invalid and r.profiles.radarr <> invalid then r.movieProfile = r.profiles.radarr.default
    if r.tvProfile = invalid and r.profiles.sonarr <> invalid then r.tvProfile = r.profiles.sonarr.default
    if radarrOk and r.profiles.radarr <> invalid and r.profiles.radarr.profiles <> invalid then out.Push({ label: "Movie quality", role: "movie", data: r.profiles.radarr, cur: r.movieProfile })
    if sonarrOk and r.profiles.sonarr <> invalid and r.profiles.sonarr.profiles <> invalid then out.Push({ label: "Show quality", role: "tv", data: r.profiles.sonarr, cur: r.tvProfile })
    return out
end function

function reqDrawQuality(g as object, groups as object, x as dynamic, y as dynamic, w as dynamic) as dynamic
    for each grp in groups
        uiText(g, grp.label, { v: "A600t04", s: 11, c: m.c.muted, lh: 17.6, upper: true }, x, y)
        y = y + 17.6 + 6
        cx = x
        for each p in grp.data.profiles
            sel = (str0(p.id) = str0(grp.cur))
            b = uiBtn(invalid, 0, 0, p.name, { primary: sel, flat: sel, h: 43, play: false, padX: 14 })
            if cx + b.w > x + w and cx > x
                cx = x
                y = y + 43 + 8
            end if
            btnPlace(g, b, cx, y)
            setBtnItem(b, "rq:" + grp.role + ":" + str0(p.id), reqQualityPick, "rq-" + grp.role, { role: grp.role, pid: p.id })
            cx = cx + b.w + 8
        end for
        y = y + 43 + 12
    end for
    return y
end function

sub reqQualityPick(it as object)
    if it.role = "movie"
        m.req.movieProfile = it.pid
    else
        m.req.tvProfile = it.pid
    end if
    settingsRender(it.skey)
end sub

' The queue: every 8s while this UI is on screen.
sub reqPollQueue()
    if not isT(m.reqPolling) then return
    if not (m.modalOpen = "settings" and m.setTab = "requests")
        m.reqPolling = false
        return
    end if
    apiGet("/api/requests/queue", onReqQueue)
    if m.reqQueueTimer = invalid
        m.reqQueueTimer = CreateObject("roSGNode", "Timer")
        m.reqQueueTimer.duration = 8
        m.reqQueueTimer.observeField("fire", "reqPollQueue")
    end if
    m.reqQueueTimer.control = "start"
end sub

sub onReqQueue(res as object, ctx as dynamic)
    q = res.data
    if q = invalid or type(q) <> "roArray" then return
    changed = FormatJson(q) <> FormatJson(m.req.queue)
    m.req.queue = q
    if changed then reqRedraw()
end sub

' "Downloading now N", then a row per item: badge, title, bar, % and state.
function reqDrawQueue(g as object, q as object, x as dynamic, y as dynamic, w as dynamic) as dynamic
    uiText(g, "Downloading now", { v: "A600t04", s: 15, c: m.c.text, lh: 24 }, x, y)
    uiText(g, str0(q.Count()), { v: "A600", s: 13, c: m.c.muted, lh: 24 }, x + measure("Downloading now", "A600t04", 15) + 8, y)
    y = y + 24 + 12
    for each d in q
        h = 12 + 44 + 12 + 2
        uiRect(g, x, y, w, h, m.c.panel)
        uiFrame(g, x, y, w, h, 1, m.c.line)
        bt = "TV"
        bc = "0x7A3D17FF"
        if d.type = "movie"
            bt = "MOVIE"
            bc = "0x24408FFF"
        end if
        bst = { v: "A600t04", s: 9.5, c: "0xFFFFFFFF", lh: 15.2 }
        bw = textWidth(bt, bst) + 12
        uiRect(g, x + 15, y + (h - 19.2) / 2, bw, 19.2, bc)
        uiText(g, bt, bst, x + 21, y + (h - 19.2) / 2 + 2)
        bodyX = x + 15 + bw + 14
        metaW = 120
        bodyW = w - (bodyX - x) - 14 - metaW - 15
        uiText(g, str0(d.title), { v: "A600", s: 14, c: m.c.text, lh: 22.4, w: bodyW }, bodyX, y + 13)
        pct = Int(num(d.progress, 0) + 0.5)
        uiRect(g, bodyX, y + 13 + 22.4 + 8, bodyW, 6, "0xFFFFFF24")
        uiRect(g, bodyX, y + 13 + 22.4 + 8, bodyW * pct / 100, 6, m.c.accent)
        mx = x + w - 15 - metaW
        uiText(g, str0(pct) + "%", { v: "A600", s: 15, c: m.c.text, lh: 24, w: metaW, align: "right" }, mx, y + 13)
        if str0(d.errorMessage) <> ""
            stt = "⚠ " + d.errorMessage
            sc = m.c.accent
        else
            stt = str0(d.state)
            if stt = "" then stt = "queued"
            if str0(d.timeleft) <> "" then stt = stt + " · " + d.timeleft
            if str0(d.quality) <> "" then stt = stt + " · " + d.quality
            sc = m.c.muted
        end if
        uiText(g, stt, { v: "A400", s: 11.5, c: sc, lh: 18.4, w: metaW, align: "right" }, mx, y + 13 + 24)
        y = y + h + 8
    end for
    return y
end function

' .req-card: panel, 1px line, padding 12, gap 16: an 80px poster with the
' MOVIE/TV badge, then name (+ year), a 2-line overview and the button.
function reqCard(g as object, it as object, x as dynamic, y as dynamic, w as dynamic) as dynamic
    owned = isT(it.inLibrary) or isT(it.hasFile)
    infoX = x + 13 + 80 + 16
    infoW = w - 13 - 80 - 16 - 13
    ol = wrapLines(str0(it.overview), { v: "A400", s: 13 }, infoW, 2)
    infoH = 25.6 + 4 + ol.Count() * 20.8 + 10 + 43
    h = maxf(120, infoH) + 24 + 2
    cg = uiGroup(g, x, y)
    card = { g: cg, it: it, w: w, h: h, owned: owned, ol: ol, infoW: infoW, state: str0(it.rqState) }
    if owned then card.state = "✓ Already in library"
    reqCardPaint(card, false)
    fAdd({ sc: "settings", x: x, y: y, w: w, h: h, kind: "req-card", skey: "rc:" + str0(it.tmdbId) + str0(it.tvdbId), card: card, onFocus: reqCardFocus, onBlur: reqCardBlur, onSelect: reqCardSelect })
    return y + h
end function

sub reqCardPaint(c as object, focused as boolean)
    g = c.g
    clearChildren(g)
    it = c.it
    w = c.w
    h = c.h
    uiRect(g, 0, 0, w, h, m.c.panel)
    bc = m.c.line
    if focused then bc = m.c.text
    uiFrame(g, 0, 0, w, h, 1, bc)
    ' The Braun focus: an inset 3px ink frame.
    if focused then uiFrame(g, 0, 0, w, h, 3, m.c.text)
    py = (h - 120) / 2
    uiRect(g, 13, py, 80, 120, m.c.sunk)
    if str0(it.poster) <> "" then uiPoster(g, it.poster, 13, py, 80, 120)
    bt = "TV"
    bcol = "0x7A3D17FF"
    if it.type = "movie"
        bt = "MOVIE"
        bcol = "0x24408FFF"
    end if
    bst = { v: "A600t04", s: 9.5, c: "0xFFFFFFFF", lh: 15.2 }
    bw = textWidth(bt, bst) + 12
    uiRect(g, 18, py + 5, bw, 19.2, bcol)
    uiText(g, bt, bst, 24, py + 7)
    ix = 13 + 80 + 16
    ih = 25.6 + 4 + c.ol.Count() * 20.8 + 10 + 43
    iy = (h - ih) / 2
    nm = str0(it.title)
    uiText(g, nm, { v: "A600", s: 16, c: m.c.text, lh: 25.6 }, ix, iy)
    if it.year <> invalid then uiText(g, "(" + str0(it.year) + ")", { v: "A400", s: 13, c: m.c.muted, lh: 25.6 }, ix + measure(nm, "A600", 16) + 4, iy)
    oy = iy + 25.6 + 4
    for i = 0 to c.ol.Count() - 1
        uiText(g, c.ol[i], { v: "A400", s: 13, c: m.c.muted, lh: 20.8 }, ix, oy + i * 20.8)
    end for
    by = oy + c.ol.Count() * 20.8 + 10
    label = "＋ Request"
    if c.state <> "" then label = c.state
    primary = not c.owned and c.state = ""
    b = uiBtn(g, ix, by, label, { primary: primary, flat: primary, play: false })
end sub

sub reqCardFocus(it as object)
    reqCardPaint(it.card, true)
end sub

sub reqCardBlur(it as object)
    reqCardPaint(it.card, false)
end sub

sub reqCardSelect(it as object)
    c = it.card
    if c.owned or (c.state <> "" and not isT(c.retry)) then return
    c.retry = false
    c.state = "Requesting…"
    c.it.rqState = c.state
    reqCardPaint(c, true)
    d = c.it
    pid = m.req.tvProfile
    if d.type = "movie" then pid = m.req.movieProfile
    m.reqCard = c
    apiPost("/api/requests/add", { type: d.type, tmdbId: d.tmdbId, tvdbId: d.tvdbId, qualityProfileId: pid }, onReqAdded, c)
end sub

sub onReqAdded(res as object, c as object)
    if res.code >= 200 and res.code < 300
        if res.data <> invalid and isT(res.data.already)
            c.state = "✓ Already requested"
        else
            c.state = "✓ Requested — searching"
        end if
        c.it.rqState = c.state
        apiGet("/api/requests/queue", onReqQueue)
    else
        e = "Failed"
        if res.data <> invalid and str0(res.data.error) <> "" then e = res.data.error
        c.state = "⚠ " + e
        c.it.rqState = ""
        c.retry = true
    end if
    reqCardPaint(c, m.fCur <> invalid and m.fCur.card <> invalid and m.fCur.card.it.title = c.it.title)
end sub
