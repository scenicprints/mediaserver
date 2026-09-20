' ============================================================
'  Live TV (app.js renderLiveTv, drawPreview, drawEpg, tuneIn,
'  liveContinuation). The channels and their schedule come from
'  /api/roku/guide (a port of buildChannels / nowOn / programmes);
'  "now" is this Roku's clock, as it is the TV's on Android.
'
'  Measured (TV mode): the preview starts under the 68px bar and
'  is content-sized with a floor of 54% of the space below it;
'  the guide head is 34 tall; rows are 20% of the rows area but
'  never under 40; the channel column is 168 wide; blocks sit 6
'  inside their row with a 3px gap after each.
' ============================================================

sub renderLiveTv()
    heroStop()
    page = pageReset()
    m.ltActive = true
    m.ltSel = 0
    m.ltData = invalid
    m.ltG = uiGroup(page, 0, 0)
    uiText(m.ltG, "Tuning in…", { v: "A400", s: 16, c: m.c.muted, lh: 25.6 }, 38.4, 100)
    liveTvFetch()
    if m.ltTimer = invalid
        m.ltTimer = CreateObject("roSGNode", "Timer")
        m.ltTimer.duration = 30
        m.ltTimer.repeat = true
        m.ltTimer.observeField("fire", "liveTvFetch")
    end if
    m.ltTimer.control = "start"
end sub

sub stopLiveTv()
    m.ltActive = false
    if m.ltTimer <> invalid then m.ltTimer.control = "stop"
end sub

sub liveTvFetch()
    now = nowSec()
    winStart = (now \ 1800) * 1800
    winEnd = winStart + 90 * 60
    m.ltWin = { now: now, start: winStart, finish: winEnd }
    apiGet("/api/roku/guide?at=" + str0(now) + "&from=" + str0(winStart) + "&to=" + str0(winEnd), onGuide)
end sub

sub onGuide(res as object, ctx as dynamic)
    if not isT(m.ltActive) or m.currentView <> "livetv" then return
    if res.data = invalid then return
    m.ltData = res.data.channels
    if m.ltData = invalid or m.ltData.Count() = 0
        clearChildren(m.ltG)
        uiText(m.ltG, "Add some movies or shows to start broadcasting.", { v: "A400", s: 16, c: m.c.muted, lh: 25.6 }, 38.4, 100)
        return
    end if
    if m.ltSel >= m.ltData.Count() then m.ltSel = 0
    liveTvDraw()
end sub

' The programme on air on a channel at `at`, and the one after it.
function ltNowOn(chan as object, at as integer) as object
    progs = chan.programmes
    for i = 0 to progs.Count() - 1
        p = progs[i]
        if at >= p.start and at < p["end"]
            nxt = invalid
            if i + 1 < progs.Count() then nxt = progs[i + 1]
            return { p: p, offset: at - p.start, next: nxt }
        end if
    end for
    return { p: progs[0], offset: 0, next: invalid }
end function

sub liveTvDraw()
    g = m.ltG
    clearChildren(g)
    ' Page-level items are rebuilt: drop the old Tune In from the focus list.
    kept = []
    for each it in m.fItems["page"]
        if not isT(it.lt) then kept.Push(it)
    end for
    m.fItems["page"] = kept
    if m.fCur <> invalid and isT(m.fCur.lt) then m.fCur.hidden = true
    now = nowSec()
    chan = m.ltData[m.ltSel]
    on = ltNowOn(chan, now)
    it = on.p.item
    isEp = (it.kind = "episode")
    ' ---- the preview ("marquee") ----
    bodyX = 38.4
    ' 62ch: measure the 62 zeros as one run (a single glyph's width comes back
    ' rounded to a device pixel, and 62 of those drift ~6px short).
    chW = measure(String(62, "0"), "A400", 15)
    titleSt = { v: "A600", s: 32, c: m.c.onDark, lh: 33.6 }
    bodyW = maxf(chW, 520)
    tw = textWidth(it.title, titleSt)
    if tw > bodyW then bodyW = minf(tw, 683.2)
    tl = wrapLines(it.title, titleSt, bodyW)
    chips = []
    if isEp
        epLabel = "S" + str0(it.season) + "·E" + padEp(it.episode)
        if str0(it.epTitle) <> "" then epLabel = epLabel + " · " + it.epTitle
        chips.Push({ t: epLabel })
    else if it.year <> invalid
        chips.Push({ t: str0(it.year) })
    end if
    if it.rating <> invalid and num(it.rating, 0) <> 0 then chips.Push({ t: "★ " + fixed1(it.rating) })
    chips.Push({ t: chan.sub })
    overText = ""
    if isEp then overText = str0(it.epTitle)
    if overText = "" then overText = str0(it.overview)
    overSt = { v: "A400", s: 15, c: "0xDFE3EEFF", lh: 24 }
    ol = []
    if overText <> "" then ol = wrapLines(overText, overSt, bodyW, 2)
    ' Heights, top to bottom, then bottom-aligned in the preview.
    contentH = 30 + 9 + tl.Count() * 33.6 + 8 + 27.2 + 7 + ol.Count() * 24 + 10 + 4 + 5 + 36.8 + 8 + 31 + 18
    prevH = maxf(contentH, 0.54 * (540 - 68))
    top = 68
    art = str0(it.still)
    if art = "" then art = str0(it.backdrop)
    if art = "" then art = str0(it.poster)
    ' background-size: cover, position center 30%.
    pc = uiGroup(g, 0, top)
    pc.clippingRect = [0, 0, pxs(960), pxs(prevH)]
    if art <> "" then ltCoverImage(pc, art, prevH)
    fin = "black"
    if m.finish = "white" then fin = "white"
    uiImage(g, "grad/ltfade_" + fin + ".png", 0, top, 960, prevH)
    y = top + prevH - contentH
    ' Channel badge: number chip, NAME, ● LIVE.
    ns = { v: "A600", s: 15, c: "0xFFFFFFFF", lh: 24 }
    nw = textWidth(str0(chan.number), ns) + 24
    uiRect(g, bodyX, y, nw, 30, m.c.accent)
    uiText(g, str0(chan.number), ns, bodyX + 12, y + 3)
    nameSt = { v: "A600t14", s: 14, c: "0xEAF0FFFF", lh: 22.4 }
    nx = bodyX + nw + 12
    uiText(g, chan.name, nameSt, nx, y + 3.8)
    ox = nx + textWidth(chan.name, nameSt) + 12
    uiLiveDot(g, ox, y + 10.5, m.c.accent)
    uiText(g, "LIVE", { v: "A600t10", s: 11, c: m.c.accent, lh: 17.6 }, ox + 15, y + 6.2)
    y = y + 30 + 9
    for i = 0 to tl.Count() - 1
        uiText(g, tl[i], titleSt, bodyX, y + i * 33.6)
    end for
    y = y + tl.Count() * 33.6 + 8
    cx = bodyX
    cst = { v: "A500t10", s: 12, c: m.c.onDark, lh: 19.2, upper: true }
    for each c in chips
        w = textWidth(c.t, cst) + 20
        uiFrame(g, cx, y, w, 27.2, 1, "0xFFFFFF59")
        uiText(g, c.t, cst, cx + 10, y + 4)
        cx = cx + w + 10
    end for
    y = y + 27.2 + 7
    for i = 0 to ol.Count() - 1
        uiText(g, ol[i], overSt, bodyX, y + i * 24)
    end for
    y = y + ol.Count() * 24 + 10
    dur = on.p["end"] - on.p.start
    pct = 0
    if dur > 0 then pct = minf(100, on.offset / dur * 100)
    uiRect(g, bodyX, y, 520, 4, "0xFFFFFF38")
    uiRect(g, bodyX, y, 520 * pct / 100, 4, m.c.accent)
    y = y + 4 + 5
    uiText(g, "▶ " + str0(Int(on.offset / 60 + 0.5)) + " min in", { v: "A600", s: 11.5, c: m.c.onDark, lh: 18.4 }, bodyX, y)
    if on.next <> invalid
        upT = "Up next " + clockTime(on.next.start) + " · " + str0(on.next.item.title)
        ust = { v: "A600", s: 13, c: "0xEFEEE9B8", lh: 20.8 }
        uw = minf(textWidth(upT, ust), 520 - 16 - measure("▶ 00 min in", "A600", 11.5))
        uiText(g, upT, { v: "A600", s: 13, c: "0xEFEEE9B8", lh: 20.8, w: uw }, bodyX + 520 - uw, y)
    end if
    y = y + 36.8 + 8
    ' .lt-actions .btn is 8x16 padding in TV mode: 31 tall.
    tune = uiBtn(g, bodyX, y, "▶ Tune In", { primary: true, sm: true, padX: 16 })
    btnItem(tune, "page", ltTuneSelect, { lt: true })
    ' ---- the guide ----
    epgTop = top + prevH
    uiRect(g, 0, epgTop, 960, 540 - epgTop, m.c.bg2)
    uiRect(g, 0, epgTop, 960, 1, m.c.line)
    headTop = epgTop + 1
    uiRect(g, 0, headTop, 960, 34, "0x0D0F15FF")
    uiRect(g, 0, headTop + 33, 960, 1, m.c.line)
    uiRect(g, 167, headTop, 1, 33, m.c.line)
    uiLiveDot(g, 16, headTop + 12.2, m.c.accent)
    uiText(g, "GUIDE", { v: "A600t10", s: 12, c: "0xEAF0FFFF", lh: 19.2 }, 32, headTop + 7)
    win = m.ltWin
    span = win.finish - win.start
    trackX = 168
    trackW = 960 - 168
    t = win.start
    while t < win.finish
        lx = trackX + (t - win.start) / span * trackW + 8
        uiText(g, clockTime(t), { v: "A600", s: 12, c: m.c.muted, lh: 19.2 }, lx, headTop + 9)
        t = t + 1800
    end while
    nowX = trackX + (now - win.start) / span * trackW
    uiRect(g, nowX, headTop, 2, 33, m.c.accent)
    rowsTop = headTop + 34
    rowsH = 540 - rowsTop
    rowH = maxf(40, 0.2 * rowsH)
    ' Scroll the rows so the selected one is visible (block: nearest).
    if m.ltRowScroll = invalid then m.ltRowScroll = 0
    selTop = m.ltSel * rowH
    if selTop < m.ltRowScroll then m.ltRowScroll = selTop
    if selTop + rowH > m.ltRowScroll + rowsH then m.ltRowScroll = selTop + rowH - rowsH
    rc = uiGroup(g, 0, rowsTop)
    rc.clippingRect = [0, 0, pxs(960), pxs(rowsH)]
    rows = uiGroup(rc, 0, -m.ltRowScroll)
    for i = 0 to m.ltData.Count() - 1
        ltRow(rows, m.ltData[i], i, i * rowH, rowH, now, win)
    end for
end sub

sub ltCoverImage(parent as object, url as string, h as dynamic)
    ' background-size: cover; background-position: center 30%. scaleToZoom
    ' would centre the crop, so the bitmap's size is read once it loads and the
    ' cover box is placed by hand: 50% of the horizontal overflow, 30% of the
    ' vertical.
    p = CreateObject("roSGNode", "Poster")
    p.visible = false
    p.addFields({ boxW: 960.0, boxH: h * 1.0 })
    p.observeField("loadStatus", "onLtCoverLoaded")
    p.uri = artUrl(url)
    parent.appendChild(p)
end sub

sub onLtCoverLoaded(ev as object)
    p = ev.getRoSGNode()
    if p.loadStatus <> "ready" then return
    bw = p.bitmapWidth
    bh = p.bitmapHeight
    if bw <= 0 or bh <= 0 then return
    W = pxs(p.boxW)
    H = pxs(p.boxH)
    sc = maxf(W / bw, H / bh)
    w = bw * sc
    hh = bh * sc
    p.width = w
    p.height = hh
    p.translation = [(W - w) * 0.5, (H - hh) * 0.3]
    p.visible = true
end sub

sub ltRow(g as object, chan as object, i as integer, y as dynamic, h as dynamic, now as integer, win as object)
    sel = (i = m.ltSel)
    if sel then uiRect(g, 0, y, 960, h, "0xDE5F101A")
    uiRect(g, 0, y + h - 1, 960, 1, "0x262B3899")
    ' Channel cell.
    uiRect(g, 0, y, 168, h - 1, "0x10131AFF")
    if sel
        uiImage(g, "grad/ltchansel.png", 0, y, 167, h - 1)
        uiRect(g, 0, y, 3, h - 1, m.c.accent)
    end if
    uiRect(g, 167, y, 1, h - 1, m.c.line)
    numC = m.c.muted
    if sel then numC = m.c.onDark
    nst = { v: "A600", s: 18, c: numC, lh: 28.8 }
    uiText(g, str0(chan.number), nst, 12, y + (h - 1 - 28.8) / 2)
    nx = 12 + textWidth(str0(chan.number), nst) + 10
    nmSt = { v: "A600t04", s: 11.5, c: "0xC7CCDAFF", lh: 13.225 }
    lines = wrapLines(chan.name, nmSt, 168 - 12 - nx)
    ny = y + (h - 1 - lines.Count() * 13.225) / 2
    for k = 0 to lines.Count() - 1
        uiText(g, lines[k], nmSt, nx, ny + k * 13.225)
    end for
    ' Track.
    span = win.finish - win.start
    tx = 168
    tw = 960 - 168
    for each p in chan.programmes
        lp = maxf(0, (p.start - win.start) / span)
        rp = minf(1, (p["end"] - win.start) / span)
        w = maxf(0, rp - lp) * tw
        if w > 0 and p.start < win.finish
            bx = tx + lp * tw
            bw = maxf(0, w - 3)
            live = (now >= p.start and now < p["end"])
            by = y + 6
            bh = h - 1 - 12
            if live
                if sel
                    gl = glowNode(g, bx, by, bw, bh, "ring2")
                    gl.visible = true
                end if
                uiImage(g, "grad/ltlive.png", bx, by, bw, bh)
                bc = "0xDE5F1080"
                if sel then bc = m.c.accent
                uiFrame(g, bx, by, bw, bh, 1, bc)
            else
                uiRect(g, bx, by, bw, bh, m.c.panel)
                uiFrame(g, bx, by, bw, bh, 1, m.c.line)
            end if
            tw2 = bw - 24 - 2
            if tw2 > 4 then uiText(g, str0(p.item.title), { v: "A600", s: 13, c: m.c.text, lh: 20.8, w: tw2 }, bx + 13, by + (bh - 20.8) / 2)
        end if
    end for
    uiRect(g, 168 + (now - win.start) / span * tw, y, 2, h - 1, m.c.accent)
end sub

' ltState.onKey: the guide owns Up/Down/Enter unless the ribbon has focus.
function liveTvKey(key as string) as boolean
    if not isT(m.ltActive) or m.ltData = invalid then return false
    onRibbon = (m.fCur <> invalid and m.fCur.sc = "nav" and not m.fCur.hidden)
    if onRibbon
        ' focus.js runs first and moves off the ribbon; then the guide handler
        ' sees no ribbon focus and takes the same Down.
        if key = "down"
            fMove("down")
            ltStep(1)
            return true
        end if
        return false
    end if
    if key = "down"
        ltStep(1)
        return true
    else if key = "up"
        if m.ltSel = 0
            fToRibbon()
        else
            m.ltSel = m.ltSel - 1
            liveTvDraw()
        end if
        return true
    else if key = "OK"
        tuneIn(m.ltSel)
        return true
    else if key = "back"
        ' focus.js back(): lift to the ribbon.
        return false
    end if
    ' Left/Right: nobody handles them on the guide.
    return true
end function

sub ltStep(d as integer)
    n = m.ltData.Count()
    m.ltSel = (m.ltSel + d + n) mod n
    liveTvDraw()
end sub

sub ltTuneSelect(it as object)
    tuneIn(m.ltSel)
end sub

' app.js tuneIn(): drop in at the live offset; nothing here writes progress.
sub tuneIn(chanIdx as integer)
    if m.ltData = invalid then return
    chan = m.ltData[chanIdx]
    if chan = invalid then return
    on = ltNowOn(chan, nowSec())
    offset = Int(on.offset)
    it = on.p.item
    cont = { kind: "live", chanIdx: chanIdx }
    if it.kind = "episode"
        m.ltTune = { chain: cont, offset: offset, epId: it.epId }
        apiGet("/api/shows/" + str0(it.showId), onTuneShow, m.ltTune)
    else
        m.ltTune = { chain: cont, offset: offset }
        apiGet("/api/movies/" + str0(it.id), onTuneMovie, m.ltTune)
    end if
end sub

sub onTuneMovie(res as object, req as object)
    mv = res.data
    if mv = invalid then return
    files = mv.files
    if files = invalid or files.Count() = 0
        openDetail(mv.id, false)
        return
    end if
    f = preferredFile(files, "m" + str0(mv.id))
    openPlayer({
        title: mv.title, subtitle: "", files: files, startFileId: f.id, verKey: "m" + str0(mv.id),
        streamBase: "/api/stream/", subtitleBase: "/api/subtitle/", searchKind: "movie",
        startAt: req.offset, progressUrl: invalid, live: true, autoAdvance: true, chain: req.chain
    })
end sub

sub onTuneShow(res as object, req as object)
    show = res.data
    if show = invalid then return
    ep = invalid
    if show.seasons <> invalid
        for each s in show.seasons
            for each e in s.episodes
                if str0(e.id) = str0(req.epId) then ep = e
            end for
        end for
    end if
    if ep = invalid then return
    files = ep.files
    if files = invalid or files.Count() = 0 then return
    f = preferredFile(files, "e" + str0(ep.id))
    openPlayer({
        title: show.title, subtitle: episodeSub(ep), files: files, startFileId: f.id, verKey: "e" + str0(ep.id),
        streamBase: "/api/stream/episode/", subtitleBase: "/api/subtitle/episode/", searchKind: "episode",
        startAt: req.offset, progressUrl: invalid, live: true, autoAdvance: true, chain: req.chain
    })
end sub
