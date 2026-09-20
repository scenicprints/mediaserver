' ============================================================
'  The detail overlay (#detail) and the movie page (app.js
'  openDetail), plus the shared pieces the show, episode and
'  collection pages use.
'
'  Measured at 960x540: the art is a band 883.2 x 370.9 (42% of
'  the content width) with a hairline frame, 94 from the top; the
'  hero grid below it starts 28 lower: a 190x285 poster, 32 gap,
'  a 640-wide info column. Title Archivo 500 44.16px/1.05, -0.01em.
'  Meta is an instrument panel: hairlines above and below, equal
'  cells of mono 12px caps, padding 14/16/13. Genres 12.5px with a
'  faint outline. Actions 20 below. Body text 17px text-2 at 70ch.
'  The close button is fixed at 890,22 (44px circle).
' ============================================================

sub detailOpenLayer()
    stopActivePlayer()
    m.detailOpen = true
    m.detailG.visible = true
    clearChildren(m.detailG)
    uiRect(m.detailG, 0, 0, 960, 540, m.c.bg)
    m.detailContent = uiGroup(m.detailG, 0, 0)
    s = scAdd("detail", m.detailContent, "detail", 0, 540, 24)
    ' .detail-close: fixed, above everything in the overlay.
    m.detailCloseG = uiGroup(m.detailG, 890, 22)
    detailClosePaint(false)
    fAdd({ sc: "detail", x: 890, y: 22, w: 44, h: 44, kind: "close", fixed: true, onFocus: detailCloseFocus, onBlur: detailCloseBlur, onSelect: detailCloseSelect })
end sub

sub detailClosePaint(focused as boolean)
    clearChildren(m.detailCloseG)
    if focused then circleGlowNode(m.detailCloseG, 2, 2)
    uiImage(m.detailCloseG, "icons/disc.png", 0, 0, 44, 44, "0x0A0C12B3")
    uiText(m.detailCloseG, "✕", { v: "A400", s: 18, c: "0xFFFFFFFF", lh: 44, w: 44, align: "center" }, 0, 0)
end sub

sub detailCloseFocus(it as object)
    detailClosePaint(true)
end sub

sub detailCloseBlur(it as object)
    detailClosePaint(false)
end sub

sub detailCloseSelect(it as object)
    closeDetail()
end sub

' Called once the page is built: set its height, open at the top, seat focus.
sub detailFinish(contentH as dynamic)
    s = m.sc["detail"]
    s.contentH = maxf(contentH, 540)
    scSetScroll(s, 0)
    fReseat()
end sub

' app.js closeDetail(): tear down any player, hide, then reload and re-render.
sub closeDetail()
    stopActivePlayer()
    m.detailOpen = false
    m.detailG.visible = false
    clearChildren(m.detailG)
    scReset("detail")
    if m.fCur <> invalid and m.fCur.sc = "detail" then m.fCur = invalid
    loadAll(renderView)
end sub

' The art band + the hero grid. Returns { y: where .dp-info content starts,
' info: the group for it, top: splash top }.
function detailSplash(art as dynamic, poster as dynamic) as object
    g = m.detailContent
    artUrl0 = str0(art)
    top = 94
    if artUrl0 <> ""
        bandH = 883.2 * 0.42
        uiRect(g, 38.4, top, 883.2, bandH, m.c.sunk)
        uiPoster(g, artUrl0, 38.4, top, 883.2, bandH)
        uiFrame(g, 38.4, top, 883.2, bandH, 1, m.c.line)
        heroTop = top + bandH + 28
    else
        heroTop = top + 28
    end if
    ' .dp-poster: box-shadow var(--shadow-pop); the later Braun rule makes its
    ' border 1px var(--line). No background of its own.
    popShadow(g, 38.4, heroTop, 190, 285)
    if str0(poster) <> "" then uiPoster(g, poster, 39.4, heroTop + 1, 188, 283)
    uiFrame(g, 38.4, heroTop, 190, 285, 1, m.c.line)
    return { heroTop: heroTop, x: 260.4, w: 640 }
end function

function detailTitle(text as dynamic, x as dynamic, y as dynamic) as dynamic
    st = { v: "A500n01", s: 44.16, c: m.c.text, lh: 46.368 }
    p = uiPara(m.detailContent, text, st, x, y, 640)
    return y + p.h
end function

' .dp-meta: a hairline band of equal cells. items: [{ text, kind }]
function detailMeta(items as object, x as dynamic, y as dynamic) as dynamic
    g = m.detailContent
    n = items.Count()
    if n = 0 then return y
    cellW = 640 / n
    h = 1 + 14 + 19.2 + 13 + 1
    uiRect(g, x, y, 640, 1, m.c.line)
    for i = 0 to n - 1
        it = items[i]
        cx = x + i * cellW
        border = m.c.line
        ink = m.c.text2
        if it.kind = "rating"
            border = "0xFFD76A4D"
            ink = "0xFFD76AFF"
        else if it.kind = "q"
            border = "0x5082FF59"
            ink = "0xCFE0FFFF"
        end if
        uiFrame(g, cx, y + 1, cellW, h, 1, border)
        uiText(g, it.text, { v: "M500t10", s: 12, c: ink, lh: 19.2, upper: true, w: cellW - 34 }, cx + 17, y + 1 + 1 + 14)
    end for
    uiRect(g, x, y + 1 + h, 640, 1, m.c.line)
    return y + h + 2
end function

' .dp-genres: 12.5px, #cfd4e2, 1px rgba(255,255,255,.18) outline, padding 3x11, gap 6.
function detailGenres(genres as object, x as dynamic, y as dynamic) as dynamic
    if genres = invalid or genres.Count() = 0 then return y
    g = m.detailContent
    st = { v: "A400", s: 12.5, c: "0xCFD4E2FF", lh: 20 }
    cx = x
    cy = y
    for each name in genres
        w = textWidth(name, st) + 24
        if cx + w > x + 640 and cx > x
            cx = x
            cy = cy + 28 + 6
        end if
        uiFrame(g, cx, cy, w, 28, 1, "0xFFFFFF2E")
        uiText(g, name, st, cx + 12, cy + 4)
        cx = cx + w + 6
    end for
    return cy + 28
end function

' ------------------------------------------------------------ files
function fmtSize(n as dynamic) as string
    v = num(n, 0)
    if v = 0 then return ""
    gb = v / 1e9
    if gb >= 1 then return fixed1(gb) + " GB"
    return str0(Int(v / 1e6 + 0.5)) + " MB"
end function

function fileTags(name as dynamic) as object
    s = LCase(str0(name))
    t = []
    rx = function(p as string, s as string) as boolean
        return CreateObject("roRegex", p, "i").IsMatch(s)
    end function
    if rx("x ?265|h ?265|hevc", s)
        t.Push("HEVC")
    else if rx("x ?264|h ?264|avc", s)
        t.Push("H.264")
    end if
    if rx("blu-?ray|bdrip|brrip", s)
        t.Push("BluRay")
    else if rx("web-?dl|webrip|\bweb\b", s)
        t.Push("WEB")
    else if rx("hdtv", s)
        t.Push("HDTV")
    else if rx("dvd", s)
        t.Push("DVD")
    end if
    if rx("hdr|dolby ?vision|dovi", s) then t.Push("HDR")
    if rx("atmos|truehd|\bdts\b", s) then t.Push("Surround")
    return t
end function

function versionLabel(f as object, i as integer) as string
    q = str0(f.quality)
    if q = "" then q = "Version " + str0(i + 1)
    parts = [q]
    sz = fmtSize(f.size)
    if sz <> "" then parts.Push(sz)
    tags = fileTags(f.filename)
    if tags.Count() > 0 then parts.Push(joinArr(tags, " · "))
    return joinArr(parts, "   ·   ")
end function

' app.js preferredFile(): an explicit choice wins; a remote viewer gets the
' smallest version at or under the cap; then the last quality picked; then the first.
function preferredFile(files as object, key as dynamic) as dynamic
    if files = invalid or files.Count() = 0 then return invalid
    if key <> invalid
        want = getPref("verid:" + key)
        if want <> invalid
            for each f in files
                if str0(f.id) = str0(want) then return f
            end for
        end if
    end if
    if m.isRemoteViewer and files.Count() > 1
        ranked = []
        for each f in files
            ranked.Push(f)
        end for
        ' Stable sort by size, ascending (Array.sort with a numeric comparator).
        for i = 1 to ranked.Count() - 1
            j = i
            while j > 0 and num(ranked[j - 1].size, 0) > num(ranked[j].size, 0)
                tmp = ranked[j - 1]
                ranked[j - 1] = ranked[j]
                ranked[j] = tmp
                j = j - 1
            end while
        end for
        capH = num(m.remoteCap.height, 1080)
        if capH = 0 then capH = 1080
        for each f in ranked
            if f.height = invalid or num(f.height, 0) = 0 or num(f.height, 0) <= capH
                m.lastAutoVersion = f.id
                return f
            end if
        end for
        m.lastAutoVersion = ranked[0].id
        return ranked[0]
    end if
    pq = getPref("pq")
    if pq <> invalid
        for each f in files
            if str0(f.quality) = str0(pq) then return f
        end for
    end if
    return files[0]
end function

sub rememberVersion(key as dynamic, f as object)
    if f = invalid then return
    if key <> invalid then setPref("verid:" + key, f.id)
    if str0(f.quality) <> "" then setPref("pq", f.quality)
end sub

' ------------------------------------------------------------ movie
sub openDetail(id as dynamic, autoplay as boolean)
    m.dReq = { id: id, autoplay: autoplay, left: 2, m: invalid, extra: {} }
    apiGet("/api/movies/" + str0(id), onDetailMovie, m.dReq)
    apiGet("/api/movies/" + str0(id) + "/extra", onDetailExtra, m.dReq)
end sub

sub onDetailMovie(res as object, req as object)
    req.m = res.data
    req.left = req.left - 1
    if req.left = 0 then movieDetailBuild(req)
end sub

sub onDetailExtra(res as object, req as object)
    if res.data <> invalid and type(res.data) = "roAssociativeArray" then req.extra = res.data
    req.left = req.left - 1
    if req.left = 0 then movieDetailBuild(req)
end sub

sub movieDetailBuild(req as object)
    if m.dReq = invalid or req.id <> m.dReq.id then return
    mv = req.m
    if mv = invalid then return
    extra = req.extra
    files = mv.files
    if files = invalid then files = []
    d = { m: mv, extra: extra, files: files, current: preferredFile(files, "m" + str0(mv.id)) }
    d.resumeAt = 0
    if num(mv.resume_position, 0) > 5 then d.resumeAt = mv.resume_position
    m.dPage = d
    detailOpenLayer()
    g = m.detailContent
    art = mv.backdrop
    if str0(art) = "" then art = mv.poster
    sp = detailSplash(art, mv.poster)
    x = sp.x
    y = detailTitle(mv.title, x, sp.heroTop)
    y = y + 18
    meta = []
    if mv.year <> invalid then meta.Push({ text: str0(mv.year) })
    if mv.rating <> invalid and num(mv.rating, 0) <> 0 then meta.Push({ text: "★ " + fixed1(mv.rating), kind: "rating" })
    if extra.runtime <> invalid and num(extra.runtime, 0) > 0
        rt = Int(extra.runtime)
        meta.Push({ text: str0(rt \ 60) + "h " + str0(rt mod 60) + "m" })
    end if
    if d.current <> invalid and str0(d.current.quality) <> "" then meta.Push({ text: d.current.quality, kind: "q" })
    if meta.Count() > 0
        y = detailMeta(meta, x, y)
        y = y + 18
    end if
    genres = extra.genres
    if genres <> invalid and genres.Count() > 0
        y = detailGenres(genres, x, y)
        y = y + 20
    else
        y = y + 2
    end if
    ' Actions: play buttons, favourite, watched, "Service ▸", version.
    m.dActionsY = y
    m.dActionsX = x
    detailMovieActions()
    heroBottom = maxf(m.dActionsBottom, sp.heroTop + 285)
    ' .dp-body
    by = heroBottom + 4
    if str0(extra.tagline) <> ""
        t = uiPara(g, extra.tagline, { v: "A400i", s: 16, c: m.c.muted, lh: 25.6 }, 38.4, by, 883.2)
        by = by + t.h + 14
    end if
    ov = str0(mv.overview)
    if ov = "" then ov = "No description yet."
    o = uiPara(g, ov, { v: "A400", s: 17, c: m.c.text2, lh: 27.2 }, 38.4, by, 681.9)
    ' The overview's 6px bottom margin collapses into what follows it.
    by = by + o.h
    if d.current <> invalid
        uiText(g, d.current.filename, { v: "M400", s: 12, c: m.c.muted, lh: 19.2, w: 883.2 }, 38.4, by + 6)
        by = by + 6 + 19.2
    end if
    by = detailMovieSections(extra, mv, by)
    detailFinish(by + 70)
    if req.autoplay then moviePlay(d.resumeAt)
end sub

sub detailMovieActions()
    d = m.dPage
    g = m.detailContent
    ' Rebuilt on watched/favourite changes: drop the old ones first.
    if m.dActionsG <> invalid then g.removeChild(m.dActionsG)
    arr = m.fItems["detail"]
    kept = []
    for each it in arr
        if not isT(it.dAction) then kept.Push(it)
    end for
    m.fItems["detail"] = kept
    m.dActionsG = uiGroup(g, 0, 0)
    ag = m.dActionsG
    x = m.dActionsX
    y = m.dActionsY
    items = []
    if d.resumeAt > 0
        items.Push({ label: "▶ Resume", primary: true, fn: dResume })
        items.Push({ label: "↺ From beginning", fn: dBegin })
    else
        items.Push({ label: "▶ Play", primary: true, fn: dPlay })
    end if
    if isT(d.m.favorite) or num(d.m.favorite, 0) = 1
        items.Push({ label: "★ Favorited", fn: dFav })
    else
        items.Push({ label: "☆ Favorite", fn: dFav })
    end if
    if num(d.m.watched, 0) = 1
        items.Push({ label: "✓ Watched", fn: dWatched })
    else
        items.Push({ label: "Mark watched", fn: dWatched })
    end if
    also = d.extra.alsoOn
    if also <> invalid
        for each slug in also
            p = streamProvider(slug)
            if p <> invalid then items.Push({ label: p.name + " ▸", fn: dStream, slug: slug, color: p.color })
        end for
    end if
    cx = x
    cy = y
    rowH = 43
    for each a in items
        opts = { primary: isT(a.primary) }
        if a.color <> invalid then opts.stream = rgba(a.color)
        b = uiBtn(invalid, 0, 0, a.label, opts)
        if cx + b.w > x + 640 and cx > x
            cx = x
            cy = cy + rowH + 10
        end if
        b.x = cx
        b.y = cy
        b.node.translation = [pxs(cx), pxs(cy)]
        ag.appendChild(b.node)
        btnItem(b, "detail", a.fn, { dAction: true, hg: "dp-actions", slug: a.slug })
        cx = cx + b.w + 10
    end for
    ' The version control: a label, or "Version" + a select when there are several.
    if d.files.Count() > 1
        lst = { v: "A400", s: 12.5, c: m.c.muted, lh: 20 }
        lw = textWidth("Version", lst)
        cur = d.current
        idx = 0
        for i = 0 to d.files.Count() - 1
            if d.current <> invalid and d.files[i].id = d.current.id then idx = i
        end for
        selText = versionLabel(d.files[idx], idx)
        sst = { v: "A600", s: 13, c: m.c.onDark, lh: 15.3 }
        sw = textWidth(selText, sst) + 24 + 2 + 20
        w = 4 + lw + 8 + sw
        if cx + w > x + 640 and cx > x
            cx = x
            cy = cy + rowH + 10
        end if
        uiText(ag, "Version", lst, cx + 4, cy + (43 - 20) / 2)
        sx = cx + 4 + lw + 8
        sy = cy + (43 - 35.3) / 2
        sel = { g: uiGroup(ag, sx, sy), w: sw, text: selText }
        selectPaint(sel, false)
        fAdd({ sc: "detail", x: sx, y: sy, w: sw, h: 35.3, kind: "select", dAction: true, hg: "dp-actions", sel: sel, onFocus: selectFocus, onBlur: selectBlur, onSelect: dVersionPick })
    else if d.current <> invalid
        lst = { v: "A400", s: 12.5, c: m.c.muted, lh: 20 }
        t = versionLabel(d.current, 0)
        w = 4 + textWidth(t, lst)
        if cx + w > x + 640 and cx > x
            cx = x
            cy = cy + rowH + 10
        end if
        uiText(ag, t, lst, cx + 4, cy + (43 - 20) / 2)
    end if
    m.dActionsBottom = cy + rowH
end sub

' .dp-select: dark field, 1px line, 9x12 padding, 13px 600, a native arrow.
sub selectPaint(sel as object, focused as boolean)
    clearChildren(sel.g)
    if focused
        gl = glowNode(sel.g, 0, 0, sel.w, 35.3)
        gl.visible = true
    end if
    uiRect(sel.g, 0, 0, sel.w, 35.3, "0x14161ED9")
    uiFrame(sel.g, 0, 0, sel.w, 35.3, 1, m.c.line)
    uiText(sel.g, sel.text, { v: "A600", s: 13, c: m.c.onDark, lh: 15.3, w: sel.w - 44 }, 13, 10)
    uiText(sel.g, "▼", { v: "A400", s: 8, c: m.c.onDark, lh: 15.3 }, sel.w - 20, 10)
end sub

sub selectFocus(it as object)
    selectPaint(it.sel, true)
end sub

sub selectBlur(it as object)
    selectPaint(it.sel, false)
end sub

sub dVersionPick(it as object)
    d = m.dPage
    labels = []
    sel = 0
    for i = 0 to d.files.Count() - 1
        labels.Push(versionLabel(d.files[i], i))
        if d.current <> invalid and d.files[i].id = d.current.id then sel = i
    end for
    m.dSelItem = it
    choiceDialog(labels, sel, dVersionChosen)
end sub

sub dVersionChosen(idx as integer)
    d = m.dPage
    f = d.files[idx]
    if f = invalid then return
    d.current = f
    rememberVersion("m" + str0(d.m.id), f)
    it = m.dSelItem
    if it <> invalid
        it.sel.text = versionLabel(f, idx)
        selectPaint(it.sel, m.fCur <> invalid and m.fCur.fid = it.fid)
    end if
end sub

sub moviePlay(at as dynamic)
    d = m.dPage
    if d = invalid or d.current = invalid then return
    mv = d.m
    openPlayer({
        title: mv.title, subtitle: "", files: d.files, startFileId: d.current.id, verKey: "m" + str0(mv.id),
        streamBase: "/api/stream/", subtitleBase: "/api/subtitle/", searchKind: "movie",
        startAt: at, progressUrl: "/api/movies/" + str0(mv.id) + "/progress", onEnded: invalid, live: false
    })
end sub

sub dPlay(it as object)
    moviePlay(0)
end sub

sub dResume(it as object)
    moviePlay(m.dPage.resumeAt)
end sub

sub dBegin(it as object)
    moviePlay(0)
end sub

sub dFav(it as object)
    apiPost("/api/movies/" + str0(m.dPage.m.id) + "/favorite", invalid, onFav)
end sub

sub onFav(res as object, ctx as dynamic)
    if res.data = invalid then return
    m.dPage.m.favorite = res.data.favorite
    detailMovieActionsKeepFocus("☆")
end sub

sub dWatched(it as object)
    d = m.dPage
    nxt = 1
    if num(d.m.watched, 0) = 1 then nxt = 0
    apiPost("/api/movies/" + str0(d.m.id) + "/watched", { watched: nxt }, onDWatched, nxt)
end sub

sub onDWatched(res as object, nxt as integer)
    d = m.dPage
    d.m.watched = nxt
    if nxt = 1
        d.resumeAt = 0
        d.m.resume_position = 0
    end if
    detailMovieActionsKeepFocus("watched")
end sub

' Rebuild the action row and put focus back on the button that was pressed
' (the web only swaps that button's text; its element, and so focus, stays).
sub detailMovieActionsKeepFocus(which as string)
    was = m.fCur
    wasLabel = ""
    if was <> invalid and was.btn <> invalid then wasLabel = was.btn.parts[0]
    detailMovieActions()
    if was = invalid then return
    target = invalid
    for each it in m.fItems["detail"]
        if isT(it.dAction) and it.btn <> invalid
            l = it.btn.parts[0]
            if which = "watched" and (l = "✓ Watched" or l = "Mark watched") then target = it
            if which = "☆" and (l = "★ Favorited" or l = "☆ Favorite") then target = it
        end if
    end for
    if target <> invalid
        m.fCur = invalid
        fSet(target)
    end if
end sub

sub dStream(it as object)
    openService(it.slug, m.dPage.m.title)
end sub

' Cast & Crew, the franchise, More Like This (no trailers on the Roku).
function detailMovieSections(extra as object, mv as object, y as dynamic) as dynamic
    people = []
    if extra.directors <> invalid
        for each dname in extra.directors
            people.Push({ name: dname, role: "Director", profile: invalid })
        end for
    end if
    if extra.cast <> invalid
        for each c in extra.cast
            people.Push({ name: c.name, role: c.character, profile: c.profile })
        end for
    end if
    if people.Count() > 0 then y = detailPeople(people, y)
    col = extra.collection
    if col <> invalid and col.parts <> invalid and col.parts.Count() > 1
        parts = []
        for each p in col.parts
            if str0(p.poster) <> "" then parts.Push(p)
        end for
        y = detailRecs(str0(col.name), parts, y, "col", true)
    end if
    recs = []
    if extra.recommendations <> invalid
        for each r in extra.recommendations
            if str0(r.poster) <> "" then recs.Push(r)
        end for
    end if
    if recs.Count() > 0 then y = detailRecs("More Like This", recs, y, "recs", false)
    return y
end function

' .dp-section: 36 above, h3 19px/30.4 + 14, then the hscroll (18/12 padding
' inside a -18/-12/-10 margin).
function detailSectionHead(title as string, y as dynamic) as dynamic
    y = y + 36
    uiText(m.detailContent, title, { v: "A600", s: 19, c: m.c.text, lh: 30.4 }, 38.4, y)
    return y + 30.4 + 14
end function

' Cast: 118px square photos, name 13px 600 (wraps), role 12px muted. Not focusable.
function detailPeople(people as object, y as dynamic) as dynamic
    y = detailSectionHead("Cast & Crew", y)
    g = m.detailContent
    clip = uiGroup(g, 26.4, y - 18)
    clip.clippingRect = [0, 0, pxs(907.2), pxs(400)]
    row = uiGroup(clip, 12, 18)
    maxH = 0
    for i = 0 to people.Count() - 1
        p = people[i]
        px = i * 132
        if str0(p.profile) <> ""
            uiRect(row, px, 0, 118, 118, m.c.panel2)
            uiPoster(row, p.profile, px, 0, 118, 118)
        else
            uiRect(row, px, 0, 118, 118, m.c.panel2)
            initial = Left(str0(p.name), 1)
            if initial = "" then initial = "?"
            uiText(row, initial, { v: "A400", s: 30, c: m.c.muted, lh: 118, w: 118, align: "center" }, px, 0)
        end if
        nm = uiPara(row, p.name, { v: "A600", s: 13, c: m.c.text, lh: 16.25 }, px, 126, 118)
        uiPara(row, str0(p.role), { v: "A400", s: 12, c: m.c.muted, lh: 19.2 }, px, 126 + nm.h, 118, 1)
        h = 126 + nm.h + 19.2
        if h > maxH then maxH = h
    end for
    clip.clippingRect = [0, 0, pxs(907.2), pxs(maxH + 36)]
    return y + maxH + 18 - 10 - 18 + 18
end function

' Recs / franchise parts: 152px posters, title 12.5px, owned ones focusable.
function detailRecs(title as string, list as object, y as dynamic, id as string, isCollection as boolean) as dynamic
    y = detailSectionHead(title, y)
    g = m.detailContent
    clip = uiGroup(g, 26.4, y - 18)
    tid = "dp:" + id
    row = uiGroup(clip, 0, 0)
    t = trackAdd(tid, "detail", row, 26.4, y - 18, 907.2)
    n = list.Count()
    t.contentW = 12 + n * 152 + (n - 1) * 14 + 12
    for i = 0 to n - 1
        r = list[i]
        rx = 12 + i * 166
        rg = uiGroup(row, rx, 18)
        owned = (r.localId <> invalid and str0(r.localId) <> "" and str0(r.localId) <> "0")
        rec = { g: rg, owned: owned, r: r }
        rec.body = uiGroup(rg, 0, 0)
        uiRect(rec.body, 0, 0, 152, 228, m.c.sunk)
        rec.frame = uiFrame(rec.body, 0, 0, 152, 228, 3, m.c.text)
        rec.frame.visible = false
        uiPoster(rec.body, r.poster, 0, 0, 152, 228)
        tt = str0(r.title)
        if r.year <> invalid and isCollection then tt = tt + " (" + str0(r.year) + ")"
        tst = { v: "A400", s: 12.5, c: "0xD3D7E3FF", lh: 20 }
        if owned
            ' "Title ▸ in library": the suffix in the signal colour, 11px.
            sfx = " ▸ in library"
            sfxW = textWidth(sfx, { v: "A400", s: 11 })
            tw = minf(textWidth(tt, tst), 152 - sfxW)
            uiText(rec.body, tt, { v: "A400", s: 12.5, c: "0xD3D7E3FF", lh: 20, w: tw }, 0, 235)
            if tw + sfxW <= 152 then uiText(rec.body, sfx, { v: "A400", s: 11, c: m.c.accent, lh: 20 }, tw, 235)
        else
            uiText(rec.body, tt, { v: "A400", s: 12.5, c: "0xD3D7E3FF", lh: 20, w: 152 }, 0, 235)
            rec.body.opacity = 0.66
        end if
        rec.bar = uiRect(rg, 0, 255 + 4, 152, 6, m.c.accent)
        rec.bar.visible = false
        fAdd({ sc: "detail", track: tid, x: rx, y: 18, w: 152, h: 255, kind: "rec", hg: tid, carousel: tid, rec: rec, onFocus: recFocus, onBlur: recBlur, onSelect: recSelect })
    end for
    clip.clippingRect = [0, 0, pxs(907.2), pxs(255 + 18 + 18)]
    return y + 255 + 18 - 10
end function

sub recFocus(it as object)
    r = it.rec
    r.frame.visible = true
    r.bar.visible = true
    r.body.opacity = 1
end sub

sub recBlur(it as object)
    r = it.rec
    r.frame.visible = false
    r.bar.visible = false
    if not r.owned then r.body.opacity = 0.66
end sub

sub recSelect(it as object)
    r = it.rec
    if r.owned then openDetail(Val(str0(r.r.localId)), false)
end sub

' ------------------------------------------------------------ select popup
' Android's native <select> dialog (what the WebView shows): a dark card of
' single-choice rows. Up/Down move, OK picks, Back cancels.
sub choiceDialog(labels as object, selected as integer, onPick as dynamic)
    m.choice = { labels: labels, sel: selected, idx: selected, onPick: onPick }
    if m.choiceG = invalid then m.choiceG = uiGroup(m.top, 0, 0)
    choicePaint()
    m.chooserKey = choiceKey
end sub

sub choicePaint()
    g = m.choiceG
    clearChildren(g)
    c = m.choice
    uiRect(g, 0, 0, 960, 540, "0x00000099")
    n = c.labels.Count()
    rowH = 48
    w = 440
    h = n * rowH + 16
    x = (960 - w) / 2
    y = (540 - h) / 2
    uiRect(g, x, y, w, h, "0x2E2E30FF")
    for i = 0 to n - 1
        ry = y + 8 + i * rowH
        if i = c.idx then uiRect(g, x, ry, w, rowH, "0xFFFFFF1F")
        cx = x + 24
        uiImage(g, "icons/ring56.png", cx, ry + 14, 20, 20, "0xFFFFFFB3")
        if i = c.sel then uiImage(g, "icons/disc.png", cx + 5, ry + 19, 10, 10, "0x80CBC4FF")
        uiText(g, c.labels[i], { v: "R400", s: 16, c: "0xFFFFFFFF", lh: rowH, w: w - 80 }, cx + 36, ry)
    end for
end sub

function choiceKey(key as string) as boolean
    c = m.choice
    if key = "up"
        if c.idx > 0 then c.idx = c.idx - 1
        choicePaint()
    else if key = "down"
        if c.idx < c.labels.Count() - 1 then c.idx = c.idx + 1
        choicePaint()
    else if key = "OK"
        pick = c.idx
        f = c.onPick
        choiceClose()
        f(pick)
    else if key = "back"
        choiceClose()
    end if
    return true
end function

sub choiceClose()
    m.chooserKey = invalid
    if m.choiceG <> invalid then clearChildren(m.choiceG)
end sub
