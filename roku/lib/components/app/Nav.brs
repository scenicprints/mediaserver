' ============================================================
'  The top ribbon (.nav), TV mode. Measured off the web app at
'  960x540: a 68px panel with a hairline under it; brand at
'  52.8; the tabIt strip from the brand's end to the search field;
'  search at 701.2 (150 wide); settings circle at 867.2.
'  Once the remote is in use (body.tv-nav) the bar's content box
'  shrinks by the 20px bottom padding and the tabs grow to 17px,
'  which is why everything sits 10px higher from then on.
' ============================================================

sub navBuild()
    clearChildren(m.navG)
    scReset("nav")
    m.navLinks = []
    m.navViews = [
        { view: "home", label: "Home" },
        { view: "movies", label: "Movies" },
        { view: "tv", label: "TV Shows" },
        { view: "livetv", label: "Live TV" },
        { view: "library", label: "Library" },
        { view: "collections", label: "Collections" }
    ]
    ' (Requests: display:none on the TV ribbon; it lives in Settings.)
    m.navBg = uiRect(m.navG, 0, 0, 960, 68, m.c.panel)
    m.navLine = uiRect(m.navG, 0, 67, 960, 1, m.c.line)
    brandSt = { v: "A600t30", s: 20, c: m.c.text, lh: 32 }
    m.brandW = textWidth("MARQUEE", brandSt)
    m.brandNode = uiText(m.navG, "MARQUEE", brandSt, 52.8, 35.8)
    m.stripX = 52.8 + m.brandW + 16
    m.stripW = 701.2 - 16 - m.stripX
    m.stripClip = uiGroup(m.navG, m.stripX, 0)
    m.stripClip.clippingRect = [0, 0, pxs(m.stripW), pxs(68)]
    m.stripG = uiGroup(m.stripClip, 0, 0)
    m.navTrack = trackAdd("navlinks", "nav", m.stripG, m.stripX, 0, m.stripW)
    m.navTrack.fixedX = true
    for each v in m.navViews
        l = { view: v.view, label: v.label }
        l.node = uiGroup(m.stripG, 0, 0)
        l.item = fAdd({ sc: "nav", track: "navlinks", x: 0, y: 0, w: 10, h: 10, kind: "navlink", hg: "navlinks", noScroll: true, link: l, view: v.view, onFocus: navLinkFocus, onBlur: navLinkBlur, onSelect: navLinkSelect })
        m.navLinks.Push(l)
    end for
    ' Search field.
    m.searchG = uiGroup(m.navG, 701.2, 36.8)
    m.searchItem = fAdd({ sc: "nav", x: 701.2, y: 36.8, w: 150, h: 29.3, kind: "input", input: true, noScroll: true, onFocus: navSearchFocus, onBlur: navSearchBlur, onSelect: navSearchEdit })
    ' Settings.
    m.gearG = uiGroup(m.navG, 867.2, 31.5)
    m.gearItem = fAdd({ sc: "nav", x: 867.2, y: 31.5, w: 40, h: 40, kind: "icon", noScroll: true, onFocus: navGearFocus, onBlur: navGearBlur, onSelect: navGearSelect })
    m.searchText = ""
    navLayout()
    navSetActive(m.currentView)
    navOnPageScroll(m.sc["page"])
end sub

' window 'scroll' -> nav.classList.toggle('scrolled', scrollY > 40). On a TV,
' body.tv-mode .nav.scrolled outranks the Braun rule: the bar goes to
' rgba(9,10,14,.97) in every finish.
sub navOnPageScroll(s as object)
    if m.navBg = invalid or s = invalid then return
    if s.scrollY > 40
        m.navBg.color = "0x090A0EF7"
    else
        m.navBg.color = m.c.panel
    end if
end sub

sub navOnMode()
    ' No ribbon before sign-in (or after signing out).
    if m.brandNode = invalid or m.navLinks = invalid then return
    if m.navModeLaidOut = m.navMode then return
    navLayout()
end sub

' Lay the bar out for the current mode.
sub navLayout()
    m.navModeLaidOut = m.navMode
    remote = m.navMode
    ' Content box: top 35.6 (14px + 4vh), bottom padding 0 or 20.
    contentTop = 35.6
    contentH = 68 - 35.6
    if remote then contentH = 68 - 35.6 - 20
    mid = contentTop + contentH / 2
    m.brandNode.translation = [pxs(52.8), pxs(mid - 16)]
    if remote
        fs = 17
        linkH = 44
        padY = 9
        lh = 18
    else
        fs = 13
        linkH = 38
        padY = 8
        lh = 14
    end if
    m.navLinkSt = { v: "A500t16", s: fs, lh: lh, upper: true, padY: padY, h: linkH }
    x = 0
    top = mid - linkH / 2
    for each l in m.navLinks
        tw = textWidth(l.label, m.navLinkSt)
        w = tw + 24
        l.x = x
        l.w = w
        l.tw = tw
        l.item.x = x
        l.item.y = top
        l.item.w = w
        l.item.h = linkH
        x = x + w + 2
    end for
    m.navTrack.contentW = x - 2
    m.navTop = top
    m.searchY = mid - 29.3 / 2
    m.searchItem.y = m.searchY
    m.searchG.translation = [pxs(701.2), pxs(m.searchY)]
    m.gearY = mid - 20
    m.gearItem.y = m.gearY
    m.gearG.translation = [pxs(867.2), pxs(m.gearY)]
    for each l in m.navLinks
        navPaintLink(l)
    end for
    navPaintSearch()
    navPaintGear(isT(m.gearFocused))
end sub

sub navPaintLink(l as object)
    clearChildren(l.node)
    st = m.navLinkSt
    focused = isT(l.focused)
    active = (l.view = m.currentView)
    l.node.translation = [pxs(l.x), pxs(m.navTop)]
    if focused
        uiRect(l.node, 0, 0, l.w, st.h, rgba("#DE5F10", 0.16))
        g = glowNode(l.node, 0, 0, l.w, st.h)
        g.visible = true
    end if
    ink = m.c.text2
    if active then ink = m.c.text
    if focused then ink = m.c.onDark
    uiText(l.node, l.label, { v: st.v, s: st.s, c: ink, lh: st.lh, upper: true }, 12, st.padY)
    ' ::after: 3px under the label, 5px below it; signal when active, ink on focus.
    if active or focused
        bar = m.c.text
        if active then bar = m.c.accent
        uiRect(l.node, 12, st.padY + st.lh + 5, l.w - 24, 3, bar)
    end if
end sub

sub navSetActive(view as string)
    if m.navLinks = invalid then return
    for each l in m.navLinks
        l.item.active = (l.view = view)
        navPaintLink(l)
    end for
end sub

sub navLinkFocus(it as object)
    it.link.focused = true
    fTrackNearest(it)
    navPaintLink(it.link)
end sub

sub navLinkBlur(it as object)
    it.link.focused = false
    navPaintLink(it.link)
end sub

sub navLinkSelect(it as object)
    setView(it.view)
end sub

' .nav-search: underline field, Chrome's input font (the system sans).
sub navPaintSearch()
    if m.searchG = invalid then return
    clearChildren(m.searchG)
    focused = isT(m.searchFocused)
    w = 150
    editing = isT(m.kbOpen) and m.kbFor = "search"
    if editing then w = 170
    if focused and not editing
        g = glowNode(m.searchG, 0, 0, w, 29.3)
        g.visible = true
    end if
    line = m.c.line
    if editing then line = m.c.accent
    uiRect(m.searchG, 0, 27.3, w, 2, line)
    t = m.searchText
    if t = invalid then t = ""
    if t = ""
        uiText(m.searchG, "Search…", { v: "R400", s: 13.33, c: "0x757575FF", lh: 15.3, w: w - 8 }, 4, 6)
    else
        uiText(m.searchG, t, { v: "R400", s: 13.33, c: m.c.text, lh: 15.3, w: w - 8 }, 4, 6)
    end if
end sub

sub navSearchFocus(it as object)
    m.searchFocused = true
    navPaintSearch()
end sub

sub navSearchBlur(it as object)
    m.searchFocused = false
    navPaintSearch()
end sub

sub navSearchEdit(it as object)
    openKeyboard("search", "Search…", m.searchText, false, onSearchTyped, onSearchDone)
end sub

' The web's input handler: every keystroke re-filters.
sub onSearchTyped(text as string)
    m.searchText = text
    navPaintSearch()
    q = text.Trim()
    if q = ""
        renderView()
        return
    end if
    runSearch(q)
end sub

sub onSearchDone(text as string)
    onSearchTyped(text)
end sub

' .icon-btn: a 40px circle, 1px line border, 20px gear in text-2.
sub navPaintGear(focused as boolean)
    clearChildren(m.gearG)
    if focused
        circleGlowNode(m.gearG, 0, 0)
        uiImage(m.gearG, "icons/disc.png", 0, 0, 40, 40, m.c.inverse)
        uiImage(m.gearG, "icons/navgear.png", 10, 10, 20, 20, m.c.onInverse)
    else
        uiImage(m.gearG, "icons/ring80.png", 0, 0, 40, 40, m.c.line)
        uiImage(m.gearG, "icons/navgear.png", 10, 10, 20, 20, m.c.text2)
    end if
end sub

sub navGearFocus(it as object)
    m.gearFocused = true
    navPaintGear(true)
end sub

sub navGearBlur(it as object)
    m.gearFocused = false
    navPaintGear(false)
end sub

sub navGearSelect(it as object)
    openSettings()
end sub

' ------------------------------------------------------------ keyboard
' The TV's on-screen keyboard (what Enter on a web <input> brings up).
' onChange fires on every keystroke when live is wanted; onDone on OK.
sub openKeyboard(forWhat as string, title as string, text as dynamic, secure as boolean, onChange as dynamic, onDone as dynamic)
    kb = CreateObject("roSGNode", "StandardKeyboardDialog")
    kb.title = title
    kb.text = str0(text)
    kb.buttons = ["OK", "Cancel"]
    if secure then kb.textEditBox.secureMode = true
    m.kb = kb
    m.kbFor = forWhat
    m.kbOnChange = onChange
    m.kbOnDone = onDone
    m.kbOpen = true
    kb.observeField("buttonSelected", "onKbButton")
    kb.observeField("wasClosed", "onKbClosed")
    if onChange <> invalid then kb.observeField("text", "onKbText")
    m.top.getScene().dialog = kb
    if forWhat = "search" then navPaintSearch()
end sub

sub onKbText()
    if m.kb = invalid or m.kbOnChange = invalid then return
    f = m.kbOnChange
    f(m.kb.text)
end sub

sub onKbButton()
    if m.kb = invalid then return
    idx = m.kb.buttonSelected
    text = m.kb.text
    done = m.kbOnDone
    kbClose()
    if idx = 0 and done <> invalid then done(text)
end sub

sub onKbClosed()
    kbClose()
end sub

sub kbClose()
    if m.kb = invalid then return
    kb = m.kb
    m.kb = invalid
    m.kbOpen = false
    kb.close = true
    wasFor = m.kbFor
    m.kbFor = ""
    m.top.setFocus(true)
    if wasFor = "search" then navPaintSearch()
end sub
