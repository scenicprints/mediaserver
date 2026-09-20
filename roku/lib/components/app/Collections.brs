' ============================================================
'  Collections (app.js renderCollections, openCollection).
'
'  Measured: the same Movies/TV tab head as Library at 112; the
'  grid at padding 16 38.4 60 with auto-fill minmax(230px) and a
'  22px gap: three 279.7px columns. A card is a 16:10 poster with
'  a count badge (top/right 8) and the name 15px 700, 10 below.
' ============================================================

sub renderCollections()
    heroStop()
    page = pageReset()
    m.gridBackActive = false
    if m.collectionKind = invalid then m.collectionKind = "movie"
    y = 112
    libTabs(page, y, invalid, "col")
    m.colCountY = y
    if m.collectionKind = "tv"
        collEmpty(page, [{ t: "TV shows aren't grouped into collections yet — browse them under " }, { t: "TV Shows", b: true }, { t: " or " }, { t: "Library", b: true }, { t: "." }])
        return
    end if
    apiGet("/api/collections", onCollections)
end sub

sub onCollections(res as object, ctx as dynamic)
    if m.currentView <> "collections" or m.collectionKind <> "movie" then return
    page = m.pageG
    cols = res.data
    if cols = invalid or type(cols) <> "roArray" then cols = []
    ' The count sits where .row-count does, after the tabs.
    st = { v: "A600", s: 14 }
    tw = 4 + textWidth("Movies", st) + 36 + 4 + textWidth("TV Shows", st) + 36 + 4 + 2
    if cols.Count() > 0
        word = " collections"
        if cols.Count() = 1 then word = " collection"
        uiText(page, str0(cols.Count()) + word, { v: "A600", s: 13, c: m.c.muted, lh: 20.8 }, 38.4 + tw + 14, m.colCountY + 9.6)
    end if
    if cols.Count() = 0
        collEmpty(page, [{ t: "No franchises found yet. Collections appear once TMDB details finish loading for your movies (they backfill in the background after a scan)." }])
        return
    end if
    colW = (883.2 - 44) / 3
    posterH = colW * 10 / 16
    nameH = 24
    cardH = posterH + 10 + nameH
    top = 158 + 16
    for i = 0 to cols.Count() - 1
        c = cols[i]
        cx = 38.4 + (i mod 3) * (colW + 22)
        cy = top + (i \ 3) * (cardH + 22)
        g = uiGroup(page, cx, cy)
        cc = { g: g, c: c, w: colW, ph: posterH }
        collCardPaint(cc, false)
        fAdd({ sc: "page", x: cx, y: cy, w: colW, h: cardH, kind: "card", hg: "coll-grid", cc: cc, onFocus: collFocus, onBlur: collBlur, onSelect: collSelect })
    end for
    rows = (cols.Count() + 2) \ 3
    pageSetHeight(top + rows * cardH + (rows - 1) * 22 + 60)
    focusAfterRender()
end sub

' A .lib-empty message (13px muted, padding 40 2) in the grid's first cell,
' with <b> runs in the bold face.
sub collEmpty(page as object, runs as object)
    y = 158 + 16 + 40
    x = 38.4 + 2
    w = (883.2 - 44) / 3 - 4
    ' Word-wrap across the runs.
    words = []
    for each r in runs
        v = "A400"
        if isT(r.b) then v = "A600"
        parts = r.t.Split(" ")
        for i = 0 to parts.Count() - 1
            wd = parts[i]
            if i < parts.Count() - 1 then wd = wd + " "
            if wd <> "" then words.Push({ t: wd, v: v })
        end for
    end for
    cx = 0
    cy = 0
    for each wd in words
        ww = measure(wd.t.Trim(), wd.v, 13)
        if cx + ww > w and cx > 0
            cx = 0
            cy = cy + 20.8
        end if
        uiText(page, wd.t, { v: wd.v, s: 13, c: m.c.muted, lh: 20.8 }, x + cx, y + cy)
        cx = cx + measure(wd.t, wd.v, 13)
    end for
    pageSetHeight(y + cy + 20.8 + 40 + 60)
    focusAfterRender()
end sub

sub collCardPaint(cc as object, focused as boolean)
    g = cc.g
    clearChildren(g)
    c = cc.c
    w = cc.w
    ph = cc.ph
    uiRect(g, 0, 0, w, ph, m.c.sunk)
    if focused then uiFrame(g, 0, 0, w, ph, 3, m.c.text)
    if str0(c.poster) <> ""
        uiPoster(g, c.poster, 0, 0, w, ph)
    else
        lines = wrapLines(c.name, { v: "A600", s: 16 }, w - 28)
        ty = (ph - lines.Count() * 25.6) / 2
        for i = 0 to lines.Count() - 1
            uiText(g, lines[i], { v: "A600", s: 16, c: m.c.muted, lh: 25.6, w: w - 28, align: "center" }, 14, ty + i * 25.6)
        end for
    end if
    ' .coll-count: dark pill, 12px 800, padding 3x9, 1px rgba(255,255,255,.18).
    cst = { v: "A600", s: 12, c: "0xEAF0FFFF", lh: 19.2 }
    cw = textWidth(str0(c.count), cst) + 20
    uiRect(g, w - 8 - cw, 8, cw, 27.2, "0x08090DD9")
    uiFrame(g, w - 8 - cw, 8, cw, 27.2, 1, "0xFFFFFF2E")
    uiText(g, str0(c.count), cst, w - 8 - cw + 10, 12)
    nm = str0(c.name)
    if Right(nm, 11) = " Collection" then nm = Left(nm, Len(nm) - 11)
    uiText(g, nm, { v: "A600", s: 15, c: m.c.text, lh: 24, w: w }, 0, ph + 10)
    if focused then uiRect(g, 0, ph + 10 + 24 + 4, w, 6, m.c.accent)
end sub

sub collFocus(it as object)
    collCardPaint(it.cc, true)
end sub

sub collBlur(it as object)
    collCardPaint(it.cc, false)
end sub

sub collSelect(it as object)
    openCollection(it.cc.c.id)
end sub

' app.js openCollection(): splash, poster, name, "N films in your library",
' then "Films" and a grid of the movies.
sub openCollection(id as dynamic)
    apiGet("/api/collections/" + enc(id), onCollection)
end sub

sub onCollection(res as object, ctx as dynamic)
    data = res.data
    if data = invalid then return
    items = data.items
    if items = invalid then items = []
    detailOpenLayer()
    g = m.detailContent
    art = str0(data.backdrop)
    if art = "" then art = str0(data.poster)
    if art = "" and items.Count() > 0 then art = str0(items[0].backdrop)
    spl = detailSplash(art, data.poster)
    nm = str0(data.name)
    if nm = "" then nm = "Collection"
    if Right(nm, 11) = " Collection" then nm = Left(nm, Len(nm) - 11)
    y = detailTitle(nm, spl.x, spl.heroTop) + 18
    word = " films in your library"
    if items.Count() = 1 then word = " film in your library"
    y = detailMeta([{ text: str0(items.Count()) + word }], spl.x, y)
    by = maxf(y, spl.heroTop + 285) + 4
    ' .seasons-h "Films": 17px 700, 26 above, 12 below.
    by = by + 26
    uiText(g, "Films", { v: "A600", s: 17, c: m.c.text, lh: 27.2 }, 38.4, by)
    by = by + 27.2 + 12
    cards = []
    for each mv in items
        cards.Push(collMovieCard(mv))
    end for
    ' The grid sits in .dp-body (no extra side padding of its own beyond .lib-grid's).
    by = gridDraw(g, cards, by, "coll", "detail", 38.4 + 38.4, 883.2 - 76.8)
    detailFinish(by + 70)
end sub

' buildMediaCard(m, 'movie') for a collection member (the server's card shape).
function collMovieCard(mv as object) as object
    pct = 0
    if num(mv.duration, 0) > 0 and num(mv.resume_position, 0) > 0 then pct = minf(100, mv.resume_position / mv.duration * 100)
    return { type: "movie", id: mv.id, title: mv.title, poster: str0(mv.poster), sub: str0(mv.year), pct: pct, watched: num(mv.watched, 0) = 1 }
end function
