' ============================================================
'  The spatial focus engine: public/focus.js, ported.
'
'  The web engine reads live element rectangles off the DOM. Here
'  every focusable registers its rectangle (CSS px) with the
'  scroller it lives in, and the same pick / wrap / scope / back
'  rules run over those rectangles, so the remote moves exactly
'  as it does on the Android TV.
'
'  Scrollers: a vertical scroll area (the page, the detail view,
'  the settings sheet...) with an on-screen viewport. Tracks: a
'  horizontal scroller inside one (a row of cards, a hscroll).
'  An item's on-screen rect = scroller origin - scrollY + track
'  origin - scrollX + its own x/y.
' ============================================================

sub focusInit()
    m.sc = {}
    m.tracks = {}
    m.fItems = {}
    m.fCur = invalid
    m.navMode = false
end sub

' name: scroller id. node: the Group that scrolls. viewTop/viewH: the viewport
' in screen CSS px. padTop: CSS scroll-padding-top. layer: which scope it
' belongs to ("page", "detail", "modal", "auth", "nav").
function scAdd(name as string, node as object, layer as string, viewTop as dynamic, viewH as dynamic, padTop = 0 as dynamic, originX = 0 as dynamic) as object
    s = { name: name, node: node, layer: layer, viewTop: viewTop, viewH: viewH, padTop: padTop, originX: originX, scrollY: 0, contentH: viewH, onScroll: invalid }
    m.sc[name] = s
    m.fItems[name] = []
    return s
end function

sub scReset(name as string)
    s = m.sc[name]
    if s = invalid then return
    m.fItems[name] = []
    ' Tracks belonging to it go too.
    dead = []
    for each k in m.tracks
        if m.tracks[k].sc = name then dead.Push(k)
    end for
    for each k in dead
        m.tracks.Delete(k)
    end for
    if m.fCur <> invalid and m.fCur.sc = name then m.fCur = invalid
end sub

sub scSetScroll(s as object, y as dynamic)
    maxY = s.contentH - s.viewH
    if maxY < 0 then maxY = 0
    y = clamp(y, 0, maxY)
    s.scrollY = y
    ' nodeTop: where the scrolling group sits in its parent at scroll 0 (the
    ' page and overlays sit at the viewport top; a clipped sheet at its own 0).
    nt = s.viewTop
    if s.nodeTop <> invalid then nt = s.nodeTop
    if s.node <> invalid then s.node.translation = [s.node.translation[0], pxs(nt - y)]
    if s.onScroll <> invalid then fCall(s.onScroll, s)
end sub

' A horizontal scroller at (x, y) inside scroller `scName`; viewW is its client
' width, pad its CSS padding-left/right (part of the scrollable width).
function trackAdd(id as string, scName as string, node as object, x as dynamic, y as dynamic, viewW as dynamic, clipNode = invalid as dynamic) as object
    t = { id: id, sc: scName, node: node, x: x, y: y, viewW: viewW, contentW: viewW, scrollX: 0, clip: clipNode }
    m.tracks[id] = t
    return t
end function

sub trackSetScroll(t as object, x as dynamic)
    maxX = t.contentW - t.viewW
    if maxX < 0 then maxX = 0
    x = clamp(x, 0, maxX)
    t.scrollX = x
    if t.node <> invalid then t.node.translation = [pxs(-x), t.node.translation[1]]
end sub

' Register a focusable, in DOM order. Required: sc, x, y, w, h, kind.
' Optional: track, hg (horizontal group id), carousel (id of the carousel it
' sits in), rowHead, seeAll, row (row key), firstInRow, onFocus/onBlur/onSelect
' (function refs taking the item), input, play (a primary .btn-play).
function fAdd(it as object) as object
    if it.hg = invalid then it.hg = ""
    if it.hidden = invalid then it.hidden = false
    ' BrightScript can't compare two objects, so every item carries an id.
    if m.fSeq = invalid then m.fSeq = 0
    m.fSeq = m.fSeq + 1
    it.fid = m.fSeq
    arr = m.fItems[it.sc]
    if arr = invalid
        arr = []
        m.fItems[it.sc] = arr
    end if
    arr.Push(it)
    return it
end function

' On-screen rect in CSS px.
function fRect(it as object) as object
    s = m.sc[it.sc]
    x = it.x
    y = it.y
    if it.track <> invalid
        t = m.tracks[it.track]
        if t <> invalid
            x = x + t.x - t.scrollX
            y = y + t.y
        end if
    end if
    x = x + s.originX
    ' position: fixed items (the detail's close button) don't move with the scroll.
    if isT(it.fixed)
        y = y + s.viewTop
    else
        y = y + s.viewTop - s.scrollY
    end if
    return { left: x, top: y, width: it.w, height: it.h, right: x + it.w, bottom: y + it.h }
end function

' focus.js scope(): the layer that owns the remote right now. Returns the list
' of scroller names whose items are candidates, or invalid (player owns keys).
function fScope() as dynamic
    if isT(m.playerOpen) then return invalid
    if isT(m.authOpen) then return ["auth"]
    if m.modalOpen <> invalid and m.modalOpen <> "" then return [m.modalOpen]
    if isT(m.detailOpen) then return ["detail"]
    ' The page scope: the ribbon, the document, and the fixed A-Z rail.
    return ["nav", "page", "rail"]
end function

function fCandidates(scope as object) as object
    out = []
    for each name in scope
        arr = m.fItems[name]
        if arr <> invalid
            for each it in arr
                if not it.hidden and it.w > 1 and it.h > 1 then out.Push(it)
            end for
        end if
    end for
    return out
end function

function inScope(it as object, scope as object) as boolean
    if it = invalid then return false
    for each name in scope
        if it.sc = name then return true
    end for
    return false
end function

function fIsLive(it as object) as boolean
    if it = invalid then return false
    arr = m.fItems[it.sc]
    if arr = invalid then return false
    for each x in arr
        if x.fid = it.fid then return not it.hidden
    end for
    return false
end function

' focus.js pick(dir).
function fPick(dir as string, scope as object) as dynamic
    cur = fRect(m.fCur)
    cx = cur.left + cur.width / 2
    cy = cur.top + cur.height / 2
    horizontal = (dir = "left" or dir = "right")
    if horizontal and isT(m.fCur.seeAll)
        if dir = "left" then return invalid
        return fFirstCardOfRow(m.fCur.row)
    end if
    inNav = (m.fCur.sc = "nav")
    grp = ""
    if horizontal then grp = m.fCur.hg
    best = invalid
    bestScore = 1e30
    vert = []
    for each el in fCandidates(scope)
        if el.fid <> m.fCur.fid
            elNav = (el.sc = "nav")
            skip = false
            if inNav
                if dir = "down"
                    skip = elNav
                else
                    skip = not elNav
                end if
            else if elNav
                skip = true
            end if
            if not skip and grp <> "" and not inNav and el.hg <> grp then skip = true
            if not skip
                r = fRect(el)
                dx = r.left + r.width / 2 - cx
                dy = r.top + r.height / 2 - cy
                if horizontal
                    along = 0
                    ok = true
                    if dir = "right"
                        if dx <= 1 then ok = false
                        along = dx
                    else
                        if dx >= -1 then ok = false
                        along = -dx
                    end if
                    if ok
                        score = along + absf(dy) * 3
                        if score < bestScore
                            bestScore = score
                            best = el
                        end if
                    end if
                else if not isT(el.rowHead)
                    stp = maxf(24, cur.height * 0.5)
                    ok = true
                    if dir = "down"
                        if r.top <= cur.top + stp then ok = false
                    else
                        if r.top >= cur.top - stp then ok = false
                    end if
                    if ok then vert.Push({ el: el, r: r })
                end if
            end if
        end if
    end for
    if not horizontal
        if vert.Count() = 0 then return invalid
        ' Nearest row band in that direction.
        anchor = vert[0].r.top
        for each v in vert
            if dir = "down"
                if v.r.top < anchor then anchor = v.r.top
            else
                if v.r.top > anchor then anchor = v.r.top
            end if
        end for
        band = []
        for each v in vert
            if absf(v.r.top - anchor) <= 40 then band.Push(v)
        end for
        ' The band's first-sorted item decides whether it's a carousel. Sorting
        ' by top is stable in the web engine, so ties keep DOM order.
        first0 = band[0]
        for each v in band
            if dir = "down"
                if v.r.top < first0.r.top then first0 = v
            else
                if v.r.top > first0.r.top then first0 = v
            end if
        end for
        car = first0.el.carousel
        if car <> invalid and car <> ""
            first = invalid
            for each v in band
                if v.el.carousel = car
                    if first = invalid or v.r.left < first.r.left then first = v
                end if
            end for
            if first <> invalid then return first.el
        end if
        pickBest = invalid
        pickD = 1e30
        for each v in band
            r = v.r
            overlap = minf(cur.right, r.right) - maxf(cur.left, r.left)
            off = absf(r.left + r.width / 2 - cx)
            if overlap > 0
                d = off
            else
                d = 100000 + off
            end if
            if d < pickD
                pickD = d
                pickBest = v.el
            end if
        end for
        return pickBest
    end if
    if horizontal and best = invalid
        if dir = "left"
            if m.fCur.track <> invalid and m.fCur.row <> invalid
                head = fSeeAllOfRow(m.fCur.row)
                if head <> invalid then return head
            end if
        end if
    end if
    return best
end function

function fFirstCardOfRow(row as dynamic) as dynamic
    for each name in ["page", "detail"]
        arr = m.fItems[name]
        if arr <> invalid
            for each it in arr
                if it.row = row and it.kind = "card" and not it.hidden then return it
            end for
        end if
    end for
    return invalid
end function

function fSeeAllOfRow(row as dynamic) as dynamic
    arr = m.fItems[m.fCur.sc]
    for each it in arr
        if isT(it.seeAll) and it.row = row and not it.hidden then return it
    end for
    return invalid
end function

' focus.js wrap(dir): past a row end, drop to the next row's first item or rise
' to the previous row's last.
function fWrap(dir as string, scope as object) as dynamic
    cur = fRect(m.fCur)
    cy = cur.top + cur.height / 2
    best = invalid
    key = 1e30
    for each el in fCandidates(scope)
        if el.fid <> m.fCur.fid
            r = fRect(el)
            ecy = r.top + r.height / 2
            if dir = "right"
                if ecy > cy + 4
                    k = ecy * 10000 + r.left
                    if k < key
                        key = k
                        best = el
                    end if
                end if
            else
                if ecy < cy - 4
                    k = -ecy * 10000 - r.left
                    if k < key
                        key = k
                        best = el
                    end if
                end if
            end if
        end if
    end for
    return best
end function

sub fSet(it as dynamic)
    if it = invalid then return
    if isT(m.debug) then print "[focus] -> "; it.kind; " "; it.sc; " x="; it.x; " y="; it.y; " k="; it.k
    if m.fCur <> invalid then fCall(m.fCur.onBlur, m.fCur)
    m.fCur = it
    fCall(it.onFocus, it)
    fScrollIntoView(it)
end sub

' scrollIntoView({ block: 'center', inline: 'center' }), clamped like a browser.
' Nav and the A-Z rail never scroll the page; a clipped nav tabIt slides its strip.
sub fScrollIntoView(it as object)
    if isT(it.fixed) then return
    if isT(it.noScroll)
        if it.track <> invalid then fTrackNearest(it)
        return
    end if
    if it.track <> invalid
        t = m.tracks[it.track]
        if t <> invalid and not isT(t.fixedX)
            trackSetScroll(t, it.x + it.w / 2 - t.viewW / 2)
        end if
    end if
    s = m.sc[it.sc]
    if isT(s.fixed) then return
    y = it.y
    if it.track <> invalid
        t = m.tracks[it.track]
        if t <> invalid then y = y + t.y
    end if
    snapTop = s.padTop
    snapH = s.viewH - s.padTop
    scSetScroll(s, y + it.h / 2 - (snapTop + snapH / 2))
end sub

sub fTrackNearest(it as object)
    t = m.tracks[it.track]
    if t = invalid then return
    if it.x < t.scrollX
        trackSetScroll(t, it.x)
    else if it.x + it.w > t.scrollX + t.viewW
        trackSetScroll(t, it.x + it.w - t.viewW)
    end if
end sub

' focus.js firstTarget(root).
function fFirstTarget(scope as object) as dynamic
    cands = fCandidates(scope)
    if scope.Count() >= 2 and scope[1] = "page"
        tabIt = invalid
        for each it in cands
            if it.sc = "nav" and it.kind = "navlink"
                if tabIt = invalid then tabIt = it
                if isT(it.active)
                    tabIt = it
                    exit for
                end if
            end if
        end for
        if tabIt <> invalid then return tabIt
    end if
    for each it in cands
        if isT(it.play) then return it
    end for
    for each it in cands
        if it.kind = "card" then return it
    end for
    if cands.Count() > 0 then return cands[0]
    return invalid
end function

sub fEnterNav()
    m.navMode = true
    if m.onNavMode <> invalid then m.onNavMode()
end sub

' focus.js move(dir).
sub fMove(dir as string)
    scope = fScope()
    if scope = invalid then return
    wasNav = m.navMode
    fEnterNav()
    if m.fCur = invalid or not fIsLive(m.fCur) or not inScope(m.fCur, scope)
        fSet(fFirstTarget(scope))
        return
    end if
    inNav = (m.fCur.sc = "nav")
    nxt = fPick(dir, scope)
    if nxt = invalid and not inNav and (dir = "right" or dir = "left") then nxt = fWrap(dir, scope)
    if nxt <> invalid
        fSet(nxt)
        return
    end if
    if dir = "up" and not inNav and (m.modalOpen = invalid or m.modalOpen = "") then fToRibbon()
end sub

function fToRibbon() as boolean
    tabIt = invalid
    for each it in m.fItems["nav"]
        if it.kind = "navlink" and not it.hidden
            if tabIt = invalid then tabIt = it
            if isT(it.active)
                tabIt = it
                exit for
            end if
        end if
    end for
    if tabIt = invalid then return false
    fEnterNav()
    fSet(tabIt)
    return true
end function

' focus.js activate().
sub fActivate()
    it = m.fCur
    if isT(m.debug)
        if it = invalid
            print "[focus] activate: nothing focused"
        else
            print "[focus] activate "; it.kind; " live="; fIsLive(it)
        end if
    end if
    if it = invalid or not fIsLive(it) then return
    if isT(it.input)
        fCall(it.onSelect, it)
        return
    end if
    wasTab = (it.kind = "navlink")
    fCall(it.onSelect, it)
    if wasTab
        if isT(m.ltActive)
            if m.fCur <> invalid then fCall(m.fCur.onBlur, m.fCur)
            m.fCur = invalid
            return
        end if
        el = fFirstTarget(fScope())
        if el <> invalid and el.sc <> "nav" then fSet(el)
    end if
end sub

' focus.js reseat(root): a new layer opened; seat focus on its primary action.
sub fReseat()
    scope = fScope()
    if scope = invalid then return
    el = fFirstTarget(scope)
    if el = invalid then return
    if m.fCur <> invalid then fCall(m.fCur.onBlur, m.fCur)
    m.fCur = el
    if m.navMode
        m.fCur = invalid
        fSet(el)
    end if
end sub

sub fDrop()
    if m.fCur <> invalid then fCall(m.fCur.onBlur, m.fCur)
    m.fCur = invalid
end sub

' Put focus on a specific item (window.tvSeat): lit only when driving by remote.
sub fSeat(it as dynamic)
    if it = invalid then return
    if m.navMode
        fSet(it)
    else
        m.fCur = it
    end if
end sub

' Call a handler stored on an item. Never as it.onX(it): a call through an
' object member makes `m` that object inside the handler, and every handler
' here works on the app's own `m`.
sub fCall(fn as dynamic, arg as dynamic)
    if fn = invalid then return
    fn(arg)
end sub
