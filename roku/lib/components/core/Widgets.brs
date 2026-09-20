' ============================================================
'  The web app's controls, drawn as nodes: .btn, .chip, the
'  underline search field, the focus glow. Sizes and states are
'  the computed styles measured off the TV-mode web app.
' ============================================================

' The glow 9-patches reach 24 CSS px past their element (images/glow/glow.json).
function glowNode(parent as object, x as dynamic, y as dynamic, w as dynamic, h as dynamic, kind = "ring" as string) as object
    fin = "black"
    if m.finish = "white" then fin = "white"
    mg = 24
    if kind = "ring2" then mg = 22
    p = CreateObject("roSGNode", "Poster")
    p.uri = "pkg:/images/glow/" + kind + "_" + fin + ".9.png"
    p.translation = [pxs(x - mg), pxs(y - mg)]
    p.width = pxs(w + 2 * mg)
    p.height = pxs(h + 2 * mg)
    p.visible = false
    if parent <> invalid then parent.appendChild(p)
    return p
end function

' --shadow-pop (0 18px 44px, black .6 / white .18) under an element's box, which
' the caller draws next. The 9-patch reaches 88 CSS px past the box.
function popShadow(parent as object, x as dynamic, y as dynamic, w as dynamic, h as dynamic) as object
    fin = "black"
    if m.finish = "white" then fin = "white"
    p = CreateObject("roSGNode", "Poster")
    p.uri = "pkg:/images/glow/pop_" + fin + ".9.png"
    p.translation = [pxs(x - 88), pxs(y - 88)]
    p.width = pxs(w + 176)
    p.height = pxs(h + 176)
    if parent <> invalid then parent.appendChild(p)
    return p
end function

function circleGlowNode(parent as object, x as dynamic, y as dynamic) as object
    fin = "black"
    if m.finish = "white" then fin = "white"
    return uiImage(parent, "glow/circle40_" + fin + ".png", x - 24, y - 24, 88, 88)
end function

' .btn. opts: primary, sm, parts (rich label), danger. Returns a widget AA:
' { node, x, y, w, h, setFocus(on) } with the node's children arranged so the
' focus state can be repainted without rebuilding.
function uiBtn(parent as object, x as dynamic, y as dynamic, label as dynamic, opts = invalid as dynamic) as object
    if opts = invalid then opts = {}
    padX = 24
    padY = 14
    if isT(opts.sm)
        padX = 14
        padY = 8
    end if
    if opts.padX <> invalid then padX = opts.padX
    st = { v: "A600t16", s: 13, c: m.c.text, lh: 13, upper: true }
    parts = opts.parts
    if parts = invalid then parts = [str0(label)]
    tw = richWidth(parts, st)
    ' .btn.primary has border:none (only .btn-play keeps the 1px accent border):
    ' 41 tall instead of 43, unless a flex row stretches it (opts.h).
    bdr = 2
    if isT(opts.flat) then bdr = 0
    w = tw + padX * 2 + bdr
    if opts.minW <> invalid and w < opts.minW then w = opts.minW
    if opts.fullW <> invalid then w = opts.fullW
    h = 13 + padY * 2 + bdr
    if opts.h <> invalid then h = opts.h
    g = uiGroup(parent, x, y)
    b = { node: g, x: x, y: y, w: w, h: h, primary: isT(opts.primary), opts: opts, parts: parts, st: st, padX: padX, padY: padY, tw: tw }
    b.glow = glowNode(g, 0, 0, w, h)
    b.fill = uiRect(g, 0, 0, w, h, "0x00000000")
    b.frame = uiFrame(g, 0, 0, w, h, 1, m.c.line)
    b.textG = uiGroup(g, btnTextX(b), (h - 13) / 2)
    if isT(opts.flat) then b.frame.visible = false
    btnPaint(b, false)
    return b
end function

' .btn is inline-flex with no justify-content: sized to its label the label is
' centred by the equal padding, but stretched wider (width:100%) the label
' stays at the left padding.
function btnTextX(b as object) as dynamic
    bdr = 1
    if isT(b.opts.flat) then bdr = 0
    if b.opts.fullW <> invalid then return b.padX + bdr
    return (b.w - b.tw) / 2
end function

sub btnPaint(b as object, focused as boolean)
    fill = "0x00000000"
    border = m.c.line
    ink = m.c.text
    if b.primary or isT(b.selected)
        if isT(b.selected) and not b.primary
            ' .seg .btn.active / chosen segment: filled with ink.
            fill = m.c.inverse
            border = m.c.inverse
            ink = m.c.onInverse
        else
            fill = m.c.accent
            border = m.c.accent
            ink = m.c.onAccent
        end if
    end if
    if b.opts.stream <> invalid
        border = b.opts.stream
    end if
    if focused
        if b.primary and b.opts.play <> invalid and not isT(b.opts.play)
            ' .btn.primary.tv-focus outranks .btn.tv-focus: the deep signal, not
            ' the inverse (.btn-play, equal to .btn.tv-focus, loses to it).
            fill = m.c.accentDeep
            border = m.c.text
            ink = m.c.onAccent
        else
            fill = m.c.inverse
            border = m.c.inverse
            ink = m.c.onInverse
        end if
    end if
    if isT(b.disabled) and not focused
        ink = rgba(ink, 0.5)
    end if
    b.fill.color = fill
    uiFrameColor(b.frame, border)
    ' border:none stays none when focused too.
    if isT(b.opts.flat) then b.frame.visible = false
    b.glow.visible = focused
    ' translateY(-1px) while focused.
    dy = 0
    if focused then dy = -1
    b.node.translation = [pxs(b.x), pxs(b.y + dy)]
    clearChildren(b.textG)
    st = b.st
    st.c = ink
    uiRich(b.textG, b.parts, st, 0, 0)
end sub

sub btnSetLabel(b as object, label as dynamic, parts = invalid as dynamic)
    if parts = invalid then parts = [str0(label)]
    b.parts = parts
    focused = (isT(b.glow.visible))
    tw = richWidth(parts, b.st)
    ' Buttons size to their label (inline-flex): the frame follows.
    bdr = 2
    if isT(b.opts.flat) then bdr = 0
    w = tw + b.padX * 2 + bdr
    if b.opts.minW <> invalid and w < b.opts.minW then w = b.opts.minW
    if b.opts.fullW <> invalid then w = b.opts.fullW
    b.w = w
    b.tw = tw
    b.fill.width = pxs(w)
    b.node.removeChild(b.frame)
    b.frame = uiFrame(invalid, 0, 0, w, b.h, 1, m.c.line)
    b.node.insertChild(b.frame, 2)
    if isT(b.opts.flat) then b.frame.visible = false
    b.glow.width = pxs(w + 48)
    b.textG.translation = [pxs(btnTextX(b)), pxs((b.h - 13) / 2)]
    if b.item <> invalid then b.item.w = w
    btnPaint(b, focused)
end sub

' Register a button with the focus engine.
function btnItem(b as object, sc as string, onSelect as dynamic, extra = invalid as dynamic) as object
    it = { sc: sc, x: b.x, y: b.y, w: b.w, h: b.h, kind: "btn", btn: b, onFocus: btnOnFocus, onBlur: btnOnBlur, onSelect: onSelect }
    if b.primary
        it.play = true
        if type(b.opts.play) = "roBoolean" or type(b.opts.play) = "Boolean" then it.play = b.opts.play
    end if
    if extra <> invalid then it.Append(extra)
    b.item = it
    return fAdd(it)
end function

sub btnOnFocus(it as object)
    btnPaint(it.btn, true)
end sub

sub btnOnBlur(it as object)
    btnPaint(it.btn, false)
end sub

' .chip: square, 1px border, uppercase. Default: the hero/detail mono chip
' (Roboto Mono 500 12px .1em, padding 3 9, line-height 19.2). kind: "rating"
' (gold) or "q" (quality, blue).
function uiChip(parent as object, x as dynamic, y as dynamic, text as dynamic, kind = "" as string, st = invalid as dynamic) as object
    if st = invalid then st = { v: "M500t10", s: 12, c: m.c.text2, lh: 19.2, upper: true }
    border = m.c.line
    if kind = "rating"
        st.c = "0xFFD76AFF"
        border = "0xFFD76A4D"
    else if kind = "q"
        st.c = "0xCFE0FFFF"
        border = "0x5082FF59"
    end if
    tw = textWidth(text, st)
    w = tw + 18 + 2
    h = st.lh + 6 + 2
    g = uiGroup(parent, x, y)
    uiFrame(g, 0, 0, w, h, 1, border)
    uiText(g, text, st, 10, 4)
    return { node: g, w: w, h: h }
end function
