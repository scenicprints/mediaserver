' ============================================================
'  Library (app.js renderLibrary): Movies / TV Shows tabs, a
'  count, A–Z sections of grids, and the A–Z rail.
'
'  Measured: the head at 112 (tabs in a 4px-padded panel, tabs
'  14px 600 padding 8x18, 30.7 tall; the active one signal-filled
'  with white type); letters 26px 800 signal, 24 above / 12 below;
'  each grid at padding 14 38.4 26 inside a 38.4/64.4 scroller, so
'  four 183.1px columns at 76.8; the rail fixed 4px from the right,
'  centred, 11px 800 muted letters in 16.8px cells.
' ============================================================

sub renderLibrary()
    heroStop()
    pageReset()
    m.gridBackActive = false
    if m.libraryKind = invalid then m.libraryKind = "movie"
    apiGet("/api/roku/library?kind=" + m.libraryKind, onLibrary, m.libraryKind)
end sub

sub onLibrary(res as object, kind as string)
    if m.currentView <> "library" or kind <> m.libraryKind then return
    if res.data = invalid then return
    page = pageReset()
    y = 112
    libTabs(page, y, res.data.count, "lib")
    y = y + 46
    m.libLetterY = {}
    x0 = 38.4
    innerW = 960 - 38.4 - 64.4
    for each sec in res.data.sections
        y = y + 24
        m.libLetterY[sec.letter] = y
        uiText(page, sec.letter, { v: "A600", s: 26, c: m.c.accent, lh: 41.6 }, x0, y)
        y = y + 41.6 + 12
        y = gridDraw(page, sec.cards, y, "lib:" + sec.letter, "page", x0 + 38.4, innerW - 76.8)
    end for
    pageSetHeight(y + 60)
    libRail(res.data.sections)
    focusAfterRender()
end sub

' The Movies / TV Shows tab strip (.lib-head .tabs), shared with Collections.
sub libTabs(page as object, y as dynamic, count as dynamic, which as string)
    st = { v: "A600", s: 14, c: m.c.muted, lh: 14.7 }
    w1 = textWidth("Movies", st) + 36
    w2 = textWidth("TV Shows", st) + 36
    tw = 4 + w1 + 4 + w2 + 4 + 2
    uiRect(page, 38.4, y, tw, 40, m.c.panel)
    uiFrame(page, 38.4, y, tw, 40, 1, m.c.line)
    kindNow = m.libraryKind
    if which = "col" then kindNow = m.collectionKind
    tabs = [{ k: "movie", label: "Movies", x: 38.4 + 1 + 4, w: w1 }, { k: "tv", label: "TV Shows", x: 38.4 + 1 + 4 + w1 + 4, w: w2 }]
    for each t in tabs
        tg = uiGroup(page, t.x, y + 4.7)
        tb = { g: tg, w: t.w, label: t.label, active: (t.k = kindNow) }
        tabPaint(tb, false)
        fAdd({ sc: "page", x: t.x, y: y + 4.7, w: t.w, h: 30.7, kind: "tab", hg: "libtabs", tab: tb, k: t.k, which: which, onFocus: tabFocus, onBlur: tabBlur, onSelect: libTabSelect })
    end for
    if count <> invalid
        uiText(page, str0(count), { v: "A600", s: 13, c: m.c.muted, lh: 20.8 }, 38.4 + tw + 14, y + 9.6)
    end if
end sub

' .tab: 14px 600, padding 8x18; active = signal fill + white; focus ring.
sub tabPaint(tb as object, focused as boolean)
    g = tb.g
    clearChildren(g)
    if focused
        gl = glowNode(g, 0, 0, tb.w, 30.7)
        gl.visible = true
    end if
    ink = m.c.muted
    if tb.active
        uiRect(g, 0, 0, tb.w, 30.7, m.c.accent)
        ink = "0xFFFFFFFF"
    end if
    uiText(g, tb.label, { v: "A600", s: 14, c: ink, lh: 14.7 }, 18, 8)
end sub

sub tabFocus(it as object)
    tabPaint(it.tab, true)
end sub

sub tabBlur(it as object)
    tabPaint(it.tab, false)
end sub

sub libTabSelect(it as object)
    if it.which = "col"
        m.collectionKind = it.k
        renderCollections()
    else
        m.libraryKind = it.k
        renderLibrary()
    end if
end sub

sub libRail(sections as object)
    clearChildren(m.railG)
    n = sections.Count()
    if n = 0 then return
    h = n * 16.8
    top = (540 - h) / 2
    rail = scAdd("rail", m.railG, "page", 0, 540)
    rail.fixed = true
    ' The rail is part of the page layer for focus (the web's body scope).
    for i = 0 to n - 1
        L = sections[i].letter
        ag = uiGroup(m.railG, 932.7, top + i * 16.8)
        az = { g: ag, L: L }
        azPaint(az, false)
        fAdd({ sc: "rail", x: 932.7, y: top + i * 16.8, w: 23.3, h: 16.8, kind: "az", noScroll: true, fixed: true, az: az, onFocus: azFocus, onBlur: azBlur, onSelect: azSelect })
    end for
end sub

sub azPaint(az as object, focused as boolean)
    clearChildren(az.g)
    if focused
        gl = glowNode(az.g, 0, 0, 23.3, 16.8)
        gl.visible = true
    end if
    uiText(az.g, az.L, { v: "A600", s: 11, c: m.c.muted, lh: 14.85, w: 23.3, align: "center" }, 0, 1)
end sub

sub azFocus(it as object)
    azPaint(it.az, true)
end sub

sub azBlur(it as object)
    azPaint(it.az, false)
end sub

' scrollIntoView({ block: 'start' }) with the section's 84px scroll-margin and
' the page's 112px scroll-padding.
sub azSelect(it as object)
    y = m.libLetterY[it.az.L]
    if y = invalid then return
    scSetScroll(m.sc["page"], y - 84 - 112)
end sub

sub railClear()
    clearChildren(m.railG)
    if m.sc["rail"] <> invalid then scReset("rail")
end sub
