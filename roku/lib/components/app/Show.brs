' ============================================================
'  Show and episode pages (app.js openShow, openEpisodeDetail,
'  playEpisodeAt, episodeSub).
'
'  Measured: "Seasons" 17px 700 26 below the overview; season
'  cards 128 wide (poster 128x192 with a 2px border, signal when
'  active), 14 apart; the season tools row 20 below the cards; the
'  episode rows (panel, 1px line, padding 10x14, gap 14) 8 apart:
'  a 132x74.25 still, the "1·01" number (16px, 34 min), title
'  14.5px 600 with the qualities, a 2-line 12.5px overview, and
'  a 28px watched circle. Episode title 34.56px/1.05.
' ============================================================

function episodeSub(ep as object) as string
    t = "S" + str0(ep.season) + "·E" + padEp(ep.episode)
    if str0(ep.title) <> "" then t = t + " · " + ep.title
    return t
end function

function seasonLabel(s as dynamic) as string
    if num(s, 0) = 0 then return "Specials"
    return "Season " + str0(s)
end function

sub openShow(id as dynamic, autoEpId as dynamic, autoplay as boolean)
    m.sReq = { id: id, autoEpId: autoEpId, autoplay: autoplay, left: 2, show: invalid, extra: { seasons: [] } }
    apiGet("/api/shows/" + str0(id), onShowData, m.sReq)
    apiGet("/api/shows/" + str0(id) + "/extra", onShowExtra, m.sReq)
end sub

sub onShowData(res as object, req as object)
    req.show = res.data
    req.left = req.left - 1
    if req.left = 0 then showBuild(req)
end sub

sub onShowExtra(res as object, req as object)
    if res.data <> invalid and type(res.data) = "roAssociativeArray" then req.extra = res.data
    req.left = req.left - 1
    if req.left = 0 then showBuild(req)
end sub

sub showBuild(req as object)
    if m.sReq = invalid or req.id <> m.sReq.id then return
    show = req.show
    if show = invalid then return
    seasons = show.seasons
    if seasons = invalid then seasons = []
    seasonPoster = {}
    if req.extra.seasons <> invalid
        for each s in req.extra.seasons
            seasonPoster[str0(s.season)] = s.poster
        end for
    end if
    flat = []
    for si = 0 to seasons.Count() - 1
        for each ep in seasons[si].episodes
            flat.Push({ ep: ep, si: si })
        end for
    end for
    sp = { show: show, seasons: seasons, flat: flat, seasonPoster: seasonPoster }
    m.sPage = sp
    detailOpenLayer()
    g = m.detailContent
    art = show.backdrop
    if str0(art) = "" then art = show.poster
    spl = detailSplash(art, show.poster)
    x = spl.x
    y = detailTitle(show.title, x, spl.heroTop)
    y = y + 18
    meta = []
    if show.year <> invalid then meta.Push({ text: str0(show.year) })
    if show.rating <> invalid and num(show.rating, 0) <> 0 then meta.Push({ text: "★ " + fixed1(show.rating), kind: "rating" })
    n = num(show.episodeCount, 0)
    epw = " episodes"
    if n = 1 then epw = " episode"
    meta.Push({ text: str0(n) + epw })
    y = detailMeta(meta, x, y)
    y = y + 20
    play = uiBtn(g, x, y, "▶ Play", { primary: true })
    btnItem(play, "detail", showPlayFirst, { hg: "dp-actions" })
    sp.watchedBtn = uiBtn(g, x + play.w + 10, y, showWatchedLabel())
    btnItem(sp.watchedBtn, "detail", showWatchedToggle, { hg: "dp-actions" })
    heroBottom = maxf(y + 43, spl.heroTop + 285)
    by = heroBottom + 4
    ov = str0(show.overview)
    oh = 0
    if ov <> ""
        o = uiPara(g, ov, { v: "A400", s: 17, c: m.c.text2, lh: 27.2 }, 38.4, by, 681.9)
        oh = o.h
    end if
    by = by + oh + 26
    uiText(g, "Seasons", { v: "A600", s: 17, c: m.c.text, lh: 27.2 }, 38.4, by)
    by = by + 27.2 + 12
    ' Season cards: a carousel.
    clip = uiGroup(g, 28.4, by - 16)
    row = uiGroup(clip, 0, 0)
    tid = "seasons"
    t = trackAdd(tid, "detail", row, 28.4, by - 16, 903.2)
    ns = seasons.Count()
    t.contentW = 10 + ns * 128 + maxf(ns - 1, 0) * 14 + 10
    clip.clippingRect = [0, 0, pxs(903.2), pxs(240.8 + 32)]
    sp.cards = []
    for i = 0 to ns - 1
        s = seasons[i]
        cx = 10 + i * 142
        cg = uiGroup(row, cx, 16)
        c = { g: cg, s: s, idx: i }
        sp.cards.Push(c)
        seasonCardPaint(c, false)
        fAdd({ sc: "detail", track: tid, x: cx, y: 16, w: 128, h: 240.8, kind: "season", hg: tid, carousel: tid, sc0: c, onFocus: seasonFocus, onBlur: seasonBlur, onSelect: seasonSelect })
    end for
    sp.activeIdx = 0
    sp.toolsY = by + 240.8 + 20
    sp.listG = uiGroup(g, 0, 0)
    if ns > 0
        showRenderSeason(0)
    else
        detailFinish(by + 70)
    end if
    fReseat()
    if req.autoEpId <> invalid
        fi = -1
        for k = 0 to flat.Count() - 1
            if str0(flat[k].ep.id) = str0(req.autoEpId) then fi = k
        end for
        if fi >= 0 then playEpisodeAt(show, flat, fi, {})
    else if req.autoplay and flat.Count() > 0
        playEpisodeAt(show, flat, firstUnwatched(flat), {})
    end if
end sub

function firstUnwatched(flat as object) as integer
    for i = 0 to flat.Count() - 1
        if num(flat[i].ep.watched, 0) = 0 then return i
    end for
    return 0
end function

sub showPlayFirst(it as object)
    sp = m.sPage
    playEpisodeAt(sp.show, sp.flat, firstUnwatched(sp.flat), {})
end sub

function showAllWatched() as boolean
    sp = m.sPage
    if sp.flat.Count() = 0 then return false
    for each f in sp.flat
        if num(f.ep.watched, 0) = 0 then return false
    end for
    return true
end function

function showWatchedLabel() as string
    if showAllWatched() then return "✓ Show watched"
    return "Mark show watched"
end function

sub showWatchedToggle(it as object)
    nxt = 1
    if showAllWatched() then nxt = 0
    apiPost("/api/shows/" + str0(m.sPage.show.id) + "/watched", { watched: nxt }, onShowWatched, nxt)
end sub

sub onShowWatched(res as object, nxt as integer)
    sp = m.sPage
    for each f in sp.flat
        f.ep.watched = nxt
        if nxt = 1 then f.ep.resume_position = 0
    end for
    btnSetLabel(sp.watchedBtn, showWatchedLabel())
    showRenderSeason(sp.activeIdx)
end sub

' .season-card: poster 128x192 in a 2px border (signal when active), label
' 13.5px 600 (signal when active), count 12px muted. Focus: the ink frame
' under the art and the 6px signal bar 10 below the card.
sub seasonCardPaint(c as object, focused as boolean)
    sp = m.sPage
    clearChildren(c.g)
    s = c.s
    active = (sp.activeIdx = c.idx)
    poster = sp.seasonPoster[str0(s.season)]
    if str0(poster) = "" then poster = sp.show.poster
    uiRect(c.g, 0, 0, 128, 192, m.c.sunk)
    if focused then uiFrame(c.g, 2, 2, 124, 188, 3, m.c.text)
    if str0(poster) <> ""
        uiPoster(c.g, poster, 2, 2, 124, 188)
    else
        uiText(c.g, seasonLabel(s.season), { v: "A600", s: 13, c: m.c.muted, lh: 192, w: 128, align: "center" }, 0, 0)
    end if
    bc = "0x00000000"
    if active then bc = m.c.accent
    uiFrame(c.g, 0, 0, 128, 192, 2, bc)
    lc = m.c.text
    if active then lc = m.c.accent
    uiText(c.g, seasonLabel(s.season), { v: "A600", s: 13.5, c: lc, lh: 21.6, w: 128 }, 0, 200)
    uiText(c.g, str0(s.episodes.Count()) + " ep", { v: "A400", s: 12, c: m.c.muted, lh: 19.2, w: 128 }, 0, 221.6)
    if focused then uiRect(c.g, 0, 240.8 + 4, 128, 6, m.c.accent)
end sub

sub seasonFocus(it as object)
    it.sc0.focused = true
    seasonCardPaint(it.sc0, true)
end sub

sub seasonBlur(it as object)
    it.sc0.focused = false
    seasonCardPaint(it.sc0, false)
end sub

sub seasonSelect(it as object)
    showRenderSeason(it.sc0.idx)
end sub

' app.js renderSeason(): the tools row and the episode list, rebuilt.
sub showRenderSeason(idx as integer)
    sp = m.sPage
    prev = sp.activeIdx
    sp.activeIdx = idx
    for each c in sp.cards
        seasonCardPaint(c, isT(c.focused))
    end for
    s = sp.seasons[idx]
    g = m.detailContent
    ' Drop the old rows/tools from the page and the focus list. If focus sat on
    ' one of them it is now gone, as when the web swaps the innerHTML.
    kept = []
    for each it in m.fItems["detail"]
        if not isT(it.epRow) then kept.Push(it)
    end for
    m.fItems["detail"] = kept
    if m.fCur <> invalid and isT(m.fCur.epRow) then m.fCur.hidden = true
    g.removeChild(sp.listG)
    sp.listG = uiGroup(g, 0, 0)
    lg = sp.listG
    y = sp.toolsY
    all = s.episodes.Count() > 0
    for each ep in s.episodes
        if num(ep.watched, 0) = 0 then all = false
    end for
    lbl = seasonLabel(s.season) + " · " + str0(s.episodes.Count()) + " episodes"
    ' .episode-tools: space-between, centred on the 31px button.
    uiText(lg, lbl, { v: "A600", s: 13, c: m.c.muted, lh: 20.8 }, 38.4, y + (31 - 20.8) / 2)
    tl = "Mark season watched"
    if all then tl = "✓ Season watched"
    b = uiBtn(invalid, 0, 0, tl, { sm: true })
    bx = 38.4 + 883.2 - b.w
    b.x = bx
    b.y = y
    b.node.translation = [pxs(bx), pxs(y)]
    lg.appendChild(b.node)
    btnItem(b, "detail", seasonWatchedToggle, { epRow: true, seasonAll: all })
    y = y + 31 + 12
    for each ep in s.episodes
        y = episodeRow(lg, ep, y) + 8
    end for
    detailFinishKeep(y - 8 + 70)
end sub

' Re-measure the page without moving the scroll or the focus.
sub detailFinishKeep(contentH as dynamic)
    s = m.sc["detail"]
    s.contentH = maxf(contentH, 540)
    scSetScroll(s, s.scrollY)
end sub

function episodeRow(g as object, ep as object, y as dynamic) as dynamic
    sp = m.sPage
    tst = { v: "A600", s: 14.5, c: m.c.text, lh: 23.2 }
    ost = { v: "A400", s: 12.5, c: m.c.muted, lh: 20 }
    bodyW = 883.2 - 2 - 28 - 132 - 14 - 34 - 14 - 14 - 28
    quals = []
    if ep.files <> invalid
        for each f in ep.files
            q = str0(f.quality)
            if q <> ""
                dup = false
                for each x in quals
                    if x = q then dup = true
                end for
                if not dup then quals.Push(q)
            end if
        end for
    end if
    title = str0(ep.title)
    if title = "" then title = "Episode " + str0(ep.episode)
    if quals.Count() > 0 then title = title + " · " + joinArr(quals, "/")
    tl = wrapLines(title, tst, bodyW)
    olines = []
    if str0(ep.overview) <> "" then olines = wrapLines(ep.overview, ost, bodyW, 2)
    bodyH = tl.Count() * 23.2
    if olines.Count() > 0 then bodyH = bodyH + 3 + olines.Count() * 20
    innerH = maxf(74.25, bodyH)
    h = innerH + 20 + 2
    rg = uiGroup(g, 38.4, y)
    row = { g: rg, ep: ep, h: h, tl: tl, ol: olines, innerH: innerH, bodyH: bodyH, bodyW: bodyW }
    episodeRowPaint(row, false)
    fi = -1
    for k = 0 to sp.flat.Count() - 1
        if sp.flat[k].ep.id = ep.id then fi = k
    end for
    row.fi = fi
    fAdd({ sc: "detail", x: 38.4, y: y, w: 883.2, h: h, kind: "episode", epRow: true, row: row, onFocus: epRowFocus, onBlur: epRowBlur, onSelect: epRowSelect })
    return y + h
end function

sub episodeRowPaint(row as object, focused as boolean)
    g = row.g
    clearChildren(g)
    ep = row.ep
    h = row.h
    bg = m.c.panel
    border = m.c.line
    ink = m.c.text
    if focused
        gl = glowNode(g, 0, 0, 883.2, h, "ring2")
        gl.visible = true
        bg = "0x1B2130FF"
        border = m.c.accent
        ink = m.c.onDark
    end if
    uiRect(g, 0, 0, 883.2, h, bg)
    uiFrame(g, 0, 0, 883.2, h, 1, border)
    cy = 1 + 10
    mid = cy + row.innerH / 2
    ' Still.
    uiRect(g, 15, mid - 74.25 / 2, 132, 74.25, "0x0D0F15FF")
    if str0(ep.still) <> "" then uiPoster(g, ep.still, 15, mid - 74.25 / 2, 132, 74.25)
    ' Number.
    uiText(g, str0(ep.season) + "·" + padEp(ep.episode), { v: "A600", s: 16, c: m.c.muted, lh: 25.6 }, 15 + 132 + 14, mid - 12.8)
    ' Body.
    bx = 15 + 132 + 14 + 34 + 14
    by = mid - row.bodyH / 2
    for i = 0 to row.tl.Count() - 1
        uiText(g, row.tl[i], { v: "A600", s: 14.5, c: ink, lh: 23.2 }, bx, by + i * 23.2)
    end for
    oy = by + row.tl.Count() * 23.2 + 3
    for i = 0 to row.ol.Count() - 1
        uiText(g, row.ol[i], { v: "A400", s: 12.5, c: m.c.muted, lh: 20 }, bx, oy + i * 20)
    end for
    ' Watched circle.
    wx = 883.2 - 1 - 14 - 28
    wy = mid - 14
    if num(ep.watched, 0) = 1
        uiImage(g, "icons/disc.png", wx, wy, 28, 28, "0x2E9D63FF")
        uiText(g, "✓", { v: "A400", s: 13, c: "0xFFFFFFFF", lh: 28, w: 28, align: "center" }, wx, wy)
    else
        uiImage(g, "icons/ring56.png", wx, wy, 28, 28, m.c.line)
        uiText(g, "○", { v: "A400", s: 13, c: m.c.muted, lh: 28, w: 28, align: "center" }, wx, wy)
    end if
    ' Resume bar.
    pct = 0
    if num(ep.duration, 0) > 0 and num(ep.resume_position, 0) > 0 then pct = minf(100, ep.resume_position / ep.duration * 100)
    if pct > 1 then uiRect(g, 0, h - 3, 883.2 * pct / 100, 3, m.c.accent)
end sub

sub epRowFocus(it as object)
    episodeRowPaint(it.row, true)
end sub

sub epRowBlur(it as object)
    episodeRowPaint(it.row, false)
end sub

sub epRowSelect(it as object)
    sp = m.sPage
    openEpisodeDetail(sp.show, sp.flat, it.row.fi)
end sub

sub seasonWatchedToggle(it as object)
    sp = m.sPage
    s = sp.seasons[sp.activeIdx]
    nxt = 1
    if isT(it.seasonAll) then nxt = 0
    apiPost("/api/shows/" + str0(sp.show.id) + "/watched", { watched: nxt, season: s.season }, onSeasonWatched, nxt)
end sub

sub onSeasonWatched(res as object, nxt as integer)
    sp = m.sPage
    s = sp.seasons[sp.activeIdx]
    for each ep in s.episodes
        ep.watched = nxt
        if nxt = 1 then ep.resume_position = 0
    end for
    showRenderSeason(sp.activeIdx)
    btnSetLabel(sp.watchedBtn, showWatchedLabel())
end sub

' ------------------------------------------------------------ episode page
sub openEpisodeDetail(show as object, flat as object, i as integer)
    ep = flat[i].ep
    m.eReq = { show: show, flat: flat, i: i, ep: ep }
    apiGet("/api/episodes/" + str0(ep.id) + "/extra", onEpisodeExtra, m.eReq)
end sub

sub onEpisodeExtra(res as object, req as object)
    if m.eReq = invalid or m.eReq.ep.id <> req.ep.id then return
    extra = res.data
    if extra = invalid or type(extra) <> "roAssociativeArray" then extra = {}
    show = req.show
    ep = req.ep
    files = ep.files
    if files = invalid then files = []
    d = { show: show, flat: req.flat, i: req.i, ep: ep, files: files, current: preferredFile(files, "e" + str0(ep.id)), extra: extra }
    d.resumeAt = 0
    if num(ep.resume_position, 0) > 5 then d.resumeAt = ep.resume_position
    m.ePage = d
    detailOpenLayer()
    g = m.detailContent
    still = extra.still
    if str0(still) = "" then still = ep.still
    if str0(still) = "" then still = show.backdrop
    if str0(still) = "" then still = show.poster
    posterArt = ep.still
    if str0(posterArt) = "" then posterArt = show.poster
    spl = detailSplash(still, posterArt)
    x = spl.x
    y = spl.heroTop
    back = uiBtn(g, x, y, "‹ " + str0(show.title), { sm: true })
    btnItem(back, "detail", epBack, {})
    y = y + 31 + 14
    tp = uiPara(g, episodeSub(ep), { v: "A500n01", s: 34.56, c: m.c.text, lh: 36.288 }, x, y, 640)
    y = y + tp.h + 18
    meta = []
    if str0(extra.airDate) <> "" then meta.Push({ text: extra.airDate })
    if extra.rating <> invalid and num(extra.rating, 0) <> 0 then meta.Push({ text: "★ " + fixed1(extra.rating), kind: "rating" })
    if extra.runtime <> invalid and num(extra.runtime, 0) <> 0 then meta.Push({ text: str0(extra.runtime) + "m" })
    if d.current <> invalid and str0(d.current.quality) <> "" then meta.Push({ text: d.current.quality, kind: "q" })
    if meta.Count() > 0
        y = detailMeta(meta, x, y) + 20
    else
        y = y + 2
    end if
    m.eActionsX = x
    m.eActionsY = y
    epActions()
    heroBottom = maxf(m.eActionsBottom, spl.heroTop + 285)
    by = heroBottom + 4
    ov = str0(extra.overview)
    if ov = "" then ov = str0(ep.overview)
    if ov = "" then ov = "No description."
    o = uiPara(g, ov, { v: "A400", s: 17, c: m.c.text2, lh: 27.2 }, 38.4, by, 681.9)
    by = by + o.h
    people = extra.people
    if people <> invalid and people.Count() > 0 then by = detailPeople(people, by)
    detailFinish(by + 70)
end sub

sub epActions()
    d = m.ePage
    g = m.detailContent
    if m.eActionsG <> invalid then g.removeChild(m.eActionsG)
    kept = []
    for each it in m.fItems["detail"]
        if not isT(it.eAction) then kept.Push(it)
    end for
    m.fItems["detail"] = kept
    m.eActionsG = uiGroup(g, 0, 0)
    ag = m.eActionsG
    x = m.eActionsX
    y = m.eActionsY
    items = []
    if d.resumeAt > 0
        items.Push({ label: "▶ Resume", primary: true, fn: eResume })
        items.Push({ label: "↺ From beginning", fn: eBegin })
    else
        items.Push({ label: "▶ Play", primary: true, fn: ePlay })
    end if
    if num(d.ep.watched, 0) = 1
        items.Push({ label: "✓ Watched", fn: eWatched })
    else
        items.Push({ label: "Mark watched", fn: eWatched })
    end if
    cx = x
    cy = y
    for each a in items
        b = uiBtn(invalid, 0, 0, a.label, { primary: isT(a.primary) })
        if cx + b.w > x + 640 and cx > x
            cx = x
            cy = cy + 53
        end if
        b.x = cx
        b.y = cy
        b.node.translation = [pxs(cx), pxs(cy)]
        ag.appendChild(b.node)
        btnItem(b, "detail", a.fn, { eAction: true, hg: "dp-actions" })
        cx = cx + b.w + 10
    end for
    lst = { v: "A400", s: 12.5, c: m.c.muted, lh: 20 }
    if d.files.Count() > 1
        lw = textWidth("Version", lst)
        idx = 0
        for i = 0 to d.files.Count() - 1
            if d.current <> invalid and d.files[i].id = d.current.id then idx = i
        end for
        selText = versionLabel(d.files[idx], idx)
        sw = textWidth(selText, { v: "A600", s: 13 }) + 46
        w = 4 + lw + 8 + sw
        if cx + w > x + 640 and cx > x
            cx = x
            cy = cy + 53
        end if
        uiText(ag, "Version", lst, cx + 4, cy + 11.5)
        sx = cx + 4 + lw + 8
        sy = cy + 3.85
        sel = { g: uiGroup(ag, sx, sy), w: sw, text: selText }
        selectPaint(sel, false)
        fAdd({ sc: "detail", x: sx, y: sy, w: sw, h: 35.3, kind: "select", eAction: true, hg: "dp-actions", sel: sel, onFocus: selectFocus, onBlur: selectBlur, onSelect: eVersionPick })
    else if d.current <> invalid
        t = versionLabel(d.current, 0)
        w = 4 + textWidth(t, lst)
        if cx + w > x + 640 and cx > x
            cx = x
            cy = cy + 53
        end if
        uiText(ag, t, lst, cx + 4, cy + 11.5)
    end if
    m.eActionsBottom = cy + 43
end sub

sub eVersionPick(it as object)
    d = m.ePage
    labels = []
    sel = 0
    for i = 0 to d.files.Count() - 1
        labels.Push(versionLabel(d.files[i], i))
        if d.current <> invalid and d.files[i].id = d.current.id then sel = i
    end for
    m.eSelItem = it
    choiceDialog(labels, sel, eVersionChosen)
end sub

sub eVersionChosen(idx as integer)
    d = m.ePage
    f = d.files[idx]
    if f = invalid then return
    d.current = f
    rememberVersion("e" + str0(d.ep.id), f)
    it = m.eSelItem
    if it <> invalid
        it.sel.text = versionLabel(f, idx)
        selectPaint(it.sel, m.fCur <> invalid and m.fCur.fid = it.fid)
    end if
end sub

sub ePlay(it as object)
    d = m.ePage
    playEpisodeAt(d.show, d.flat, d.i, { fileId: d.current.id, startAt: 0 })
end sub

sub eResume(it as object)
    d = m.ePage
    playEpisodeAt(d.show, d.flat, d.i, { fileId: d.current.id, startAt: d.resumeAt })
end sub

sub eBegin(it as object)
    d = m.ePage
    playEpisodeAt(d.show, d.flat, d.i, { fileId: d.current.id, startAt: 0 })
end sub

sub eWatched(it as object)
    d = m.ePage
    nxt = 1
    if num(d.ep.watched, 0) = 1 then nxt = 0
    apiPost("/api/episodes/" + str0(d.ep.id) + "/watched", { watched: nxt }, onEWatched, nxt)
end sub

sub onEWatched(res as object, nxt as integer)
    d = m.ePage
    d.ep.watched = nxt
    if nxt = 1
        d.resumeAt = 0
        d.ep.resume_position = 0
    end if
    was = m.fCur
    epActions()
    if was <> invalid
        for each it in m.fItems["detail"]
            if isT(it.eAction) and it.btn <> invalid
                l = it.btn.parts[0]
                if l = "✓ Watched" or l = "Mark watched"
                    m.fCur = invalid
                    fSet(it)
                end if
            end if
        end for
    end if
end sub

sub epBack(it as object)
    openShow(m.ePage.show.id, invalid, false)
end sub

' ------------------------------------------------------------ the chain
' app.js playEpisodeAt(): plays flat[i]; when it ends, the next one (the
' native player's `ended` -> web onEnded).
sub playEpisodeAt(show as object, flat as object, i as integer, opts as object)
    if i < 0 or i >= flat.Count() then return
    ep = flat[i].ep
    files = ep.files
    if files = invalid or files.Count() = 0 then return
    fileId = opts.fileId
    if fileId = invalid then fileId = preferredFile(files, "e" + str0(ep.id)).id
    startAt = opts.startAt
    if startAt = invalid
        startAt = 0
        if num(ep.resume_position, 0) > 5 then startAt = ep.resume_position
    end if
    hasNext = (i + 1 < flat.Count())
    ctx = {
        title: show.title, subtitle: episodeSub(ep), files: files, startFileId: fileId, verKey: "e" + str0(ep.id),
        streamBase: "/api/stream/episode/", subtitleBase: "/api/subtitle/episode/", searchKind: "episode",
        startAt: startAt, progressUrl: "/api/episodes/" + str0(ep.id) + "/progress",
        autoAdvance: isT(opts.autoAdvance), live: false, hasNext: hasNext
    }
    if hasNext then ctx.chain = { kind: "episode", show: show, flat: flat, i: i + 1 }
    openPlayer(ctx)
end sub
