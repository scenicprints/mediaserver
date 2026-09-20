' ============================================================
'  Home / Movies / TV Shows: the hero and the rows (app.js
'  renderView, drawRows, setHero, drawHero, showGridView, and the
'  ribbon search). The server computes which rows and in what
'  order (/api/roku/browse); this lays them out exactly as the TV
'  web app does.
'
'  Measured at 960x540: .hero padding-top 94, a grid of
'  [510.1 | 44 | 329.1] with a 44px row gap; the plate is 16:9
'  (286.9 tall) spanning both rows; the dial row is 26 + 22.
'  .row: 32 header + 4 + track (26 padding, 282 poster, 26); rows
'  are 8 apart; the page ends with 60px of padding.
' ============================================================

sub renderBrowse(view as string)
    m.gridBackActive = false
    url = "/api/roku/browse?view=" + view + "&seed=" + str0(m.rotationSeed) + "&ymd=" + localYmd()
    m.browseView = view
    apiGet(url, onBrowse, view)
end sub

sub onBrowse(res as object, view as string)
    if view <> m.currentView or m.browseView <> view then return
    if res.data = invalid then return
    m.browseData = res.data
    drawBrowse(res.data)
end sub

sub drawBrowse(data as object)
    page = pageReset()
    y = 0
    heroItems = data.hero
    if heroItems <> invalid and heroItems.Count() > 0
        y = heroBuild(page, heroItems)
    else
        y = 112
    end if
    y = rowsDraw(page, data.rows, y)
    pageSetHeight(y + 60)
    focusAfterRender()
end sub

' After a re-render the old focus target is gone; the web engine re-seats on the
' next key press. Keep it that way (the item list was rebuilt), unless a layer
' asked for a specific seat.
sub focusAfterRender()
    if m.fCur <> invalid and m.fCur.sc = "page" then m.fCur = invalid
end sub

' ------------------------------------------------------------ hero
function heroBuild(page as object, items as object) as dynamic
    m.heroItems = items
    m.heroIdx = 0
    m.heroG = uiGroup(page, 0, 0)
    h = heroDraw()
    heroStart()
    return h
end function

' app.js drawHero(). Returns the page y where the rows begin.
function heroDraw() as dynamic
    g = m.heroG
    ' The hero's buttons are rebuilt: drop them from the focus list. If one held
    ' focus it is now gone, exactly as when the web replaces the innerHTML.
    arr = m.fItems["page"]
    kept = []
    for each it in arr
        if not isT(it.hero) then kept.Push(it)
    end for
    m.fItems["page"] = kept
    if m.fCur <> invalid and isT(m.fCur.hero) then m.fCur.hidden = true
    clearChildren(g)
    it = m.heroItems[m.heroIdx]
    kind = it.kind
    colX = 38.4 + 510.1 + 44
    colW = 329.1
    ' The plate: 16:9, hairline frame, sunk behind the art.
    uiRect(g, 38.4, 94, 510.1, 286.9, m.c.sunk)
    uiPoster(g, it.art, 38.4, 94, 510.1, 286.9)
    uiFrame(g, 38.4, 94, 510.1, 286.9, 1, m.c.line)
    ' Title: Archivo 500, 28px, line-height 1.04, -0.01em, wraps in the column.
    tst = { v: "A500n01", s: 28, c: m.c.text, lh: 29.12 }
    t = uiPara(g, it.title, tst, colX, 94, colW)
    y = 94 + t.h + 16
    ' Meta chips: mono 12px, gap 12, margin-bottom 18.
    cx = colX
    chipH = 0
    if it.year <> invalid
        ch = uiChip(g, cx, y, str0(it.year))
        cx = cx + ch.w + 12
        chipH = ch.h
    end if
    if it.rating <> invalid
        ch = uiChip(g, cx, y, "★ " + str0(it.rating), "rating")
        cx = cx + ch.w + 12
        chipH = ch.h
    end if
    if it.extra <> invalid
        kindChip = ""
        if isT(it.extraQ) then kindChip = "q"
        ch = uiChip(g, cx, y, str0(it.extra), kindChip)
        chipH = ch.h
    end if
    if chipH = 0 then chipH = 22.4
    y = y + chipH + 18
    ost = { v: "A400", s: 17, c: m.c.text2, lh: 27.2 }
    o = uiPara(g, it.overview, ost, colX, y, colW, 4)
    if str0(it.overview) = "" then o.h = 0
    y = y + o.h + 24
    play = uiBtn(g, colX, y, "▶ Play", { primary: true })
    btnItem(play, "page", heroPlay, { hero: true, hg: "hero-actions", kindH: kind, heroIt: it })
    info = uiBtn(g, colX + play.w + 12, y, "ⓘ More Info")
    btnItem(info, "page", heroInfo, { hero: true, hg: "hero-actions", heroIt: it })
    y = y + 43
    contentH = y - 94
    row1 = maxf(contentH, 286.9 - 44 - 48)
    ' The dial: 12px cells (a 2px tick in the button's padding box), 9 apart,
    ' bottom-aligned in 22px; the current one signal and full height.
    dy = 94 + row1 + 44 + 26
    for i = 0 to m.heroItems.Count() - 1
        if i = m.heroIdx
            uiRect(g, colX + i * 21, dy, 12, 22, m.c.accent)
        else
            uiRect(g, colX + i * 21, dy + 11, 12, 11, m.c.muted)
        end if
    end for
    ' The first row sits below the hero's 30px margin.
    return 94 + row1 + 44 + 48 + 30
end function

sub heroStart()
    heroStop()
    if isT(m.freezeHero) then return
    if m.heroTimer = invalid
        m.heroTimer = CreateObject("roSGNode", "Timer")
        m.heroTimer.duration = 9
        m.heroTimer.repeat = true
        m.heroTimer.observeField("fire", "heroTick")
    end if
    m.heroTimer.control = "start"
end sub

sub heroStop()
    if m.heroTimer <> invalid then m.heroTimer.control = "stop"
end sub

sub heroTick()
    if m.heroItems = invalid or m.heroItems.Count() = 0 then return
    m.heroIdx = (m.heroIdx + 1) mod m.heroItems.Count()
    heroDraw()
end sub

sub heroPlay(it as object)
    h = it.heroIt
    if h.kind = "show"
        openShow(h.id, invalid, true)
    else
        openDetail(h.id, true)
    end if
end sub

sub heroInfo(it as object)
    h = it.heroIt
    if h.kind = "show"
        openShow(h.id, invalid, false)
    else
        openDetail(h.id, false)
    end if
end sub

' ------------------------------------------------------------ rows
' app.js drawRows(). Returns the y after the last row.
function rowsDraw(page as object, rows as object, y as dynamic) as dynamic
    first = true
    for each r in rows
        if r.cards <> invalid and r.cards.Count() > 0
            if not first then y = y + 8
            first = false
            y = rowDraw(page, r, y)
        end if
    end for
    return y
end function

function rowDraw(page as object, r as object, y as dynamic) as dynamic
    key = str0(r.key)
    ' Header: title (600 20px caps .2em, line-height 32) and See all ›.
    tst = { v: "A600t20", s: 20, c: m.c.text, lh: 32, upper: true }
    parts = r.parts
    if parts = invalid then parts = [str0(r.title)]
    uiRich(page, parts, tst, 38.4, y)
    if isT(r.seeAll)
        sst = { v: "A600", s: 13, c: m.c.muted, lh: 16 }
        ' A <button> with no padding of its own keeps the UA's 1px 6px.
        sw = textWidth("See all ›", sst) + 12
        sx = 960 - 38.4 - sw
        sg = uiGroup(page, sx, y + 10.3)
        sa = { g: sg, w: sw }
        seeAllPaint(sa, false)
        fAdd({ sc: "page", x: sx, y: y + 10.3, w: sw, h: 16, kind: "seeall", seeAll: true, rowHead: true, row: key, sa: sa, rowData: r, onFocus: seeAllFocus, onBlur: seeAllBlur, onSelect: seeAllSelect })
    end if
    ' Track.
    ty = y + 32 + 4
    tid = "row:" + key
    trackG = uiGroup(page, 0, ty)
    t = trackAdd(tid, "page", trackG, 0, ty, 960)
    n = r.cards.Count()
    t.contentW = 38.4 * 2 + n * 188 + (n - 1) * 12
    place = { sc: "page", track: tid, hg: tid, carousel: tid, row: key }
    for i = 0 to n - 1
        cardBuild(trackG, 38.4 + i * 200, 26, 188, r.cards[i], place)
    end for
    return ty + 334
end function

sub seeAllPaint(sa as object, focused as boolean)
    clearChildren(sa.g)
    if focused
        g = glowNode(sa.g, 0, 0, sa.w, 16)
        g.visible = true
    end if
    uiText(sa.g, "See all ›", { v: "A600", s: 13, c: m.c.muted, lh: 16 }, 6, 0)
end sub

sub seeAllFocus(it as object)
    seeAllPaint(it.sa, true)
end sub

sub seeAllBlur(it as object)
    seeAllPaint(it.sa, false)
end sub

sub seeAllSelect(it as object)
    r = it.rowData
    url = "/api/roku/seeall?view=" + m.currentView + "&seed=" + str0(m.rotationSeed) + "&ymd=" + localYmd() + "&key=" + enc(it.row)
    apiGet(url, onSeeAll, r)
end sub

sub onSeeAll(res as object, r as object)
    if res.data = invalid then return
    parts = r.parts
    showGridView(str0(res.data.title), parts, res.data.cards)
end sub

' ------------------------------------------------------------ grids
' app.js showGridView(): "‹ Back", the title, a count, then a .lib-grid.
sub showGridView(title as string, parts as dynamic, cards as object)
    heroStop()
    ' window.scrollTo({ top: 0 })
    scSetScroll(m.sc["page"], 0)
    m.sc["page"].pendingScroll = invalid
    page = pageReset()
    m.gridBackActive = true
    y = 112 + 8
    ' .row-head aligns on the baseline (measured): the 31-tall sm button sits 4
    ' below the 32px title line, the head is 35 tall, the count 9 down.
    back = uiBtn(page, 38.4, y + 4, "‹ Back", { sm: true })
    ' It sits in the grid's .row-head, which focus.js skips for Up/Down.
    btnItem(back, "page", gridBackSelect, { gridBack: true, rowHead: true })
    tst = { v: "A600t20", s: 20, c: m.c.text, lh: 32, upper: true }
    if parts = invalid then parts = [title]
    tx = 38.4 + back.w + 10 + 8
    uiRich(page, parts, tst, tx, y)
    cst = { v: "A600", s: 13, c: m.c.muted, lh: 20.8 }
    uiText(page, str0(cards.Count()), cst, tx + m.lastRichW + 10, y + 9)
    y = gridDraw(page, cards, y + 35 + 4, "grid")
    pageSetHeight(y + 60)
    focusAfterRender()
end sub

' .lib-grid: auto-fill columns of minmax(168px, 1fr), gap 30 x 16, padding
' 14 38.4 26. At 960 that is four 208.8px columns.
function gridDraw(parent as object, cards as object, y as dynamic, gid as string, sc = "page" as string, left = 38.4 as dynamic, width = 883.2 as dynamic) as dynamic
    cols = Int((width + 16) / (168 + 16))
    if cols < 1 then cols = 1
    colW = (width - (cols - 1) * 16) / cols
    cardH = colW * 1.5
    top = y + 14
    place = { sc: sc, hg: gid, row: gid }
    for i = 0 to cards.Count() - 1
        c = i mod cols
        rr = i \ cols
        cardBuild(parent, left + c * (colW + 16), top + rr * (cardH + 30), colW, cards[i], place)
    end for
    rowsN = (cards.Count() + cols - 1) \ cols
    if rowsN = 0 then return top + 26
    return top + rowsN * cardH + (rowsN - 1) * 30 + 26
end function

sub gridBackSelect(it as object)
    gridBack()
end sub

sub gridBack()
    m.gridBackActive = false
    renderView()
end sub

' ------------------------------------------------------------ search
sub runSearch(q as string)
    m.searchQ = q
    apiGet("/api/roku/search?q=" + enc(q), onSearch, q)
end sub

sub onSearch(res as object, q as string)
    if m.searchQ <> q or res.data = invalid then return
    heroStop()
    page = pageReset()
    m.gridBackActive = false
    y = rowsDraw(page, [{ key: "search", title: res.data.title, parts: [res.data.title], cards: res.data.cards, seeAll: false }], 112 + 8)
    pageSetHeight(y + 60)
    focusAfterRender()
end sub
