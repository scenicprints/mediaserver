' ============================================================
'  Node builders. Every x/y/w/h here is in CSS px (see Theme.brs);
'  they are doubled on the way into the node.
' ============================================================

function uiGroup(parent as object, x = 0 as dynamic, y = 0 as dynamic) as object
    g = CreateObject("roSGNode", "Group")
    g.translation = [pxs(x), pxs(y)]
    if parent <> invalid then parent.appendChild(g)
    return g
end function

function uiRect(parent as object, x as dynamic, y as dynamic, w as dynamic, h as dynamic, color as string) as object
    r = CreateObject("roSGNode", "Rectangle")
    r.translation = [pxs(x), pxs(y)]
    r.width = pxs(w)
    r.height = pxs(h)
    r.color = color
    if parent <> invalid then parent.appendChild(r)
    return r
end function

' A 1px-per-side outline (CSS border), drawn as four bars inside the box.
function uiFrame(parent as object, x as dynamic, y as dynamic, w as dynamic, h as dynamic, t as dynamic, color as string) as object
    g = uiGroup(parent, x, y)
    tt = t
    uiRect(g, 0, 0, w, tt, color)
    uiRect(g, 0, h - tt, w, tt, color)
    uiRect(g, 0, tt, tt, h - 2 * tt, color)
    uiRect(g, w - tt, tt, tt, h - 2 * tt, color)
    return g
end function

sub uiFrameColor(frame as object, color as string)
    for i = 0 to frame.getChildCount() - 1
        frame.getChild(i).color = color
    end for
end sub

' Text. st = { v: font variant, s: CSS px size, c: colour, lh: CSS line-height px,
' w: box width (px, for wrapping/alignment), align: "left"|"center"|"right",
' lines: max lines (wrapping), upper: true for text-transform: uppercase }.
' (x, y) is the top of the CSS line box.
function uiText(parent as object, text as dynamic, st as object, x as dynamic, y as dynamic) as object
    lbl = CreateObject("roSGNode", "Label")
    t = str0(text)
    if isT(st.upper) then t = UCase(t)
    v = st.v
    sz = st.s
    lbl.font = fontOf(v, sz)
    lbl.color = st.c
    lh = st.lh
    if lh = invalid then lh = contentHeight(v, sz)
    ch = contentHeight(v, sz)
    align = st.align
    if align = invalid then align = "left"
    lbl.horizAlign = align
    if st.w <> invalid then lbl.width = pxs(st.w)
    lines = st.lines
    if lines <> invalid and lines > 1
        lbl.wrap = true
        lbl.maxLines = lines
        lbl.lineSpacing = pxs(lh - ch)
        lbl.translation = [pxs(x), pxs(y + (lh - ch) / 2)]
        lbl.ellipsizeOnBoundary = true
    else
        lbl.height = pxs(lh)
        lbl.vertAlign = "center"
        lbl.translation = [pxs(x), pxs(y)]
        if st.w <> invalid then lbl.ellipsisText = "…"
    end if
    lbl.text = t
    if parent <> invalid then parent.appendChild(lbl)
    return lbl
end function

' Style helper: uiSt("A600", 13, color) plus optional fields.
function uiSt(v as string, s as dynamic, c as string, extra = invalid as dynamic) as object
    st = { v: v, s: s, c: c }
    if extra <> invalid then st.Append(extra)
    return st
end function

function textWidth(text as dynamic, st as object) as float
    t = str0(text)
    if isT(st.upper) then t = UCase(t)
    return measure(t, st.v, st.s)
end function

function uiPoster(parent as object, uri as dynamic, x as dynamic, y as dynamic, w as dynamic, h as dynamic, mode = "scaleToZoom" as string) as object
    p = CreateObject("roSGNode", "Poster")
    p.translation = [pxs(x), pxs(y)]
    p.width = pxs(w)
    p.height = pxs(h)
    p.loadWidth = pxs(w)
    p.loadHeight = pxs(h)
    p.loadDisplayMode = mode
    p.uri = artUrl(str0(uri))
    if parent <> invalid then parent.appendChild(p)
    return p
end function

' A packaged image (icon, gradient, emoji), tinted by blendColor (the images are white).
function uiImage(parent as object, name as string, x as dynamic, y as dynamic, w as dynamic, h as dynamic, tint = "" as string) as object
    p = CreateObject("roSGNode", "Poster")
    p.translation = [pxs(x), pxs(y)]
    p.width = pxs(w)
    p.height = pxs(h)
    p.loadDisplayMode = "scaleToFill"
    p.uri = "pkg:/images/" + name
    if tint <> "" then p.blendColor = tint
    if parent <> invalid then parent.appendChild(p)
    return p
end function

' Text that may carry colour emoji: parts is an array of strings and { e: "1f604" }
' segments (the server splits API strings; screens split their own). Emoji are
' drawn as Noto Color Emoji images at 1.18em, on the text's line. Returns the
' group; group.width-in-CSS is stored in m.lastRichW.
function uiRich(parent as object, parts as dynamic, st as object, x as dynamic, y as dynamic) as object
    g = uiGroup(parent, x, y)
    if type(parts) <> "roArray" then parts = [str0(parts)]
    cx = 0.0
    lh = st.lh
    if lh = invalid then lh = contentHeight(st.v, st.s)
    for each p in parts
        if type(p) = "roAssociativeArray"
            es = st.s * 1.18
            uiImage(g, "emoji/" + p.e + ".png", cx, (lh - es) / 2, es, es)
            cx = cx + es
        else
            t = p
            if isT(st.upper) then t = UCase(t)
            one = { v: st.v, s: st.s, c: st.c, lh: lh }
            uiText(g, t, one, cx, 0)
            cx = cx + measure(t, st.v, st.s)
        end if
    end for
    m.lastRichW = cx
    return g
end function

' Split "😄 Feel-Good Comedies" style strings written in this code. Only the
' emoji this app prints are recognised (roku/lib/images/emoji.json).
function richOf(s as string) as object
    if m.emojiMap = invalid
        m.emojiMap = ParseJson(ReadAsciiFile("pkg:/images/emoji.json"))
        if m.emojiMap = invalid then m.emojiMap = {}
        m.emojiKeys = []
        for each k in m.emojiMap
            m.emojiKeys.Push(k)
        end for
    end if
    out = []
    buf = ""
    n = Len(s)
    i = 1
    while i <= n
        hit = invalid
        ' Longest match first: sequences are up to 2 code points + VS16.
        for take = 3 to 1 step -1
            if i + take - 1 <= n
                seg = Mid(s, i, take)
                key = ""
                for j = 1 to Len(seg)
                    key = key + hex4(Asc(Mid(seg, j, 1)))
                end for
                f = m.emojiMap[key]
                if f <> invalid
                    hit = { take: take, file: f }
                    exit for
                end if
            end if
        end for
        if hit <> invalid
            if buf <> "" then out.Push(buf)
            buf = ""
            out.Push({ e: Left(hit.file, Len(hit.file) - 4) })
            i = i + hit.take
        else
            buf = buf + Mid(s, i, 1)
            i = i + 1
        end if
    end while
    if buf <> "" then out.Push(buf)
    return out
end function

function hex4(n as integer) as string
    digits = "0123456789ABCDEF"
    out = ""
    v = n
    while v > 0
        out = Mid(digits, (v mod 16) + 1, 1) + out
        v = v \ 16
    end while
    while Len(out) < 4
        out = "0" + out
    end while
    return out
end function

function richWidth(parts as dynamic, st as object) as float
    if type(parts) <> "roArray" then parts = [str0(parts)]
    w = 0.0
    for each p in parts
        if type(p) = "roAssociativeArray"
            w = w + st.s * 1.18
        else
            t = p
            if isT(st.upper) then t = UCase(t)
            w = w + measure(t, st.v, st.s)
        end if
    end for
    return w
end function

sub clearChildren(node as object)
    if node = invalid then return
    n = node.getChildCount()
    if n > 0 then node.removeChildrenIndex(n, 0)
end sub

' Art URLs from the server are absolute; anything root-relative is ours.
function artUrl(u as string) as string
    if u = "" then return ""
    if Left(u, 1) = "/" then return m.base + u
    return u
end function

' Word-wrap like a browser (greedy, break at spaces; a word wider than the box
' breaks by character), up to maxLines (0 = no limit). The last kept line gets
' an ellipsis when text was cut, as -webkit-line-clamp does.
function wrapLines(text as dynamic, st as object, width as dynamic, maxLines = 0 as integer) as object
    t = str0(text)
    if isT(st.upper) then t = UCase(t)
    out = []
    for each para in t.Split(Chr(10))
        words = para.Split(" ")
        line = ""
        for each w in words
            cand = w
            if line <> "" then cand = line + " " + w
            if measure(cand, st.v, st.s) <= width or line = ""
                if line = "" and measure(w, st.v, st.s) > width
                    ' Break an over-long word.
                    piece = ""
                    for i = 1 to Len(w)
                        ch = Mid(w, i, 1)
                        if measure(piece + ch, st.v, st.s) > width and piece <> ""
                            out.Push(piece)
                            piece = ch
                        else
                            piece = piece + ch
                        end if
                    end for
                    line = piece
                else
                    line = cand
                end if
            else
                out.Push(line)
                line = w
            end if
        end for
        out.Push(line)
    end for
    if maxLines > 0 and out.Count() > maxLines
        kept = []
        for i = 0 to maxLines - 1
            kept.Push(out[i])
        end for
        last = kept[maxLines - 1] + "…"
        while measure(last, st.v, st.s) > width and Len(last) > 1
            last = Left(last, Len(last) - 2) + "…"
        end while
        ' Browsers trim the space before the ellipsis.
        kept[maxLines - 1] = last.Replace(" …", "…")
        return kept
    end if
    return out
end function

' A paragraph: wrapped lines at exact line-height steps. Returns
' { node, lines, h } with h in CSS px.
function uiPara(parent as object, text as dynamic, st as object, x as dynamic, y as dynamic, width as dynamic, maxLines = 0 as integer) as object
    g = uiGroup(parent, x, y)
    lines = wrapLines(text, st, width, maxLines)
    lh = st.lh
    one = { v: st.v, s: st.s, c: st.c, lh: lh, align: st.align, w: st.w }
    if st.align <> invalid and st.align <> "left" then one.w = width
    for i = 0 to lines.Count() - 1
        uiText(g, lines[i], one, 0, i * lh)
    end for
    return { node: g, lines: lines.Count(), h: lines.Count() * lh }
end function

' Inline runs of mixed weight (<b> inside a paragraph), word-wrapped across the
' runs. runs: [{ t, b (bold) }]. Returns the height in CSS px.
function uiRuns(parent as object, runs as object, st as object, x as dynamic, y as dynamic, width as dynamic) as dynamic
    words = []
    for each r in runs
        v = st.v
        if isT(r.b) then v = st.vb
        if v = invalid then v = "A600"
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
        ww = measure(wd.t.Trim(), wd.v, st.s)
        if cx + ww > width and cx > 0
            cx = 0
            cy = cy + st.lh
        end if
        uiText(parent, wd.t, { v: wd.v, s: st.s, c: st.c, lh: st.lh }, x + cx, y + cy)
        cx = cx + measure(wd.t, wd.v, st.s)
    end for
    return cy + st.lh
end function

' .lt-live-dot: a 9px --hot disc that pulses (@keyframes pulse, 2s infinite): a
' hard-edged ring of rgba(222,95,16) grows from 0 to 9px out while fading .5 -> 0
' over the first 70% (CSS ease), then rests. The ring is a second disc behind
' the dot whose own size, position and opacity are animated (not a Group scale:
' the simulator does not pass a Group's scale to its children). The ease curve
' is sampled into the keys.
function uiLiveDot(parent as object, x as dynamic, y as dynamic, tint as string) as object
    if m.liveDotN = invalid then m.liveDotN = 0
    m.liveDotN = m.liveDotN + 1
    id = "livedot" + m.liveDotN.ToStr()
    g = uiGroup(parent, x, y)
    ring = uiImage(g, "icons/disc.png", 0, 0, 9, 9, "0xDE5F10FF")
    ring.id = id
    ring.opacity = 0
    uiImage(g, "icons/disc.png", 0, 0, 9, 9, tint)
    ease = [0, 0.0948, 0.2952, 0.5133, 0.6825, 0.8024, 0.8852, 0.9408, 0.9756, 0.9943, 1.0]
    keys = []
    sz = []
    tr = []
    op = []
    for i = 0 to 10
        keys.Push(i * 0.07)
        spread = 9 * ease[i]
        sz.Push(pxs(9 + 2 * spread))
        tr.Push([pxs(-spread), pxs(-spread)])
        op.Push(0.5 * (1 - ease[i]))
    end for
    keys.Push(1.0)
    sz.Push(pxs(9))
    tr.Push([0, 0])
    op.Push(0)
    a = CreateObject("roSGNode", "Animation")
    a.duration = 2
    a.repeat = true
    a.easeFunction = "linear"
    for each f in ["width", "height"]
        fi = a.createChild("FloatFieldInterpolator")
        fi.fieldToInterp = id + "." + f
        fi.key = keys
        fi.keyValue = sz
    end for
    ti = a.createChild("Vector2DFieldInterpolator")
    ti.fieldToInterp = id + ".translation"
    ti.key = keys
    ti.keyValue = tr
    oi = a.createChild("FloatFieldInterpolator")
    oi.fieldToInterp = id + ".opacity"
    oi.key = keys
    oi.keyValue = op
    g.appendChild(a)
    a.control = "start"
    return g
end function
