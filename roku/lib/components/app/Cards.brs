' ============================================================
'  .card: the poster tile. Card descriptors come from the server
'  (src/roku.js mediaCard / streamCard / continueCards, ports of
'  app.js), so this only draws them.
'
'  Measured (188 wide in a row): poster 2:3; badge top/right 7,
'  Archivo 600 10.5px .1em caps, padding 3x7; progress bar 4px
'  at the bottom. Focus: the card-info panel (gradient, title,
'  round buttons, sub line) rises in, a 6px signal bar sits 10px
'  below the card, and the inset ink frame is painted under the
'  artwork, so it only shows on a card with no poster.
' ============================================================

' place: { sc, track (id or invalid), hg, carousel, row } for focus.
function cardBuild(parent as object, x as dynamic, y as dynamic, w as dynamic, cd as object, place as object) as object
    h = w * 1.5
    g = uiGroup(parent, x, y)
    c = { node: g, x: x, y: y, w: w, h: h, cd: cd }
    uiRect(g, 0, 0, w, h, m.c.sunk)
    c.frame = uiFrame(g, 0, 0, w, h, 3, m.c.text)
    c.frame.visible = false
    poster = str0(cd.poster)
    if poster <> ""
        uiPoster(g, poster, 0, 0, w, h)
    else
        ' .poster .ph: centred, 12px padding, 13px 600 muted, line-height 1.6.
        st = { v: "A600", s: 13, c: m.c.muted, lh: 20.8 }
        lines = wrapLines(cd.title, st, w - 24)
        top = (h - lines.Count() * 20.8) / 2
        for i = 0 to lines.Count() - 1
            uiText(g, lines[i], { v: "A600", s: 13, c: m.c.muted, lh: 20.8, w: w - 24, align: "center" }, 12, top + i * 20.8)
        end for
    end if
    cardBadges(g, w, cd)
    pct = num(cd.pct, 0)
    if pct > 1
        uiRect(g, 0, h - 4, w, 4, "0xFFFFFF2E")
        uiRect(g, 0, h - 4, w * pct / 100, 4, m.c.accent)
    end if
    c.info = uiGroup(g, 0, 0)
    c.info.visible = false
    c.bar = uiRect(g, 0, h + 4, w, 6, m.c.accent)
    c.bar.visible = false
    it = { sc: place.sc, x: x, y: y, w: w, h: h, kind: "card", card: c, hg: place.hg, carousel: place.carousel, row: place.row, onFocus: cardFocus, onBlur: cardBlur, onSelect: cardSelect }
    if place.track <> invalid then it.track = place.track
    c.item = fAdd(it)
    return c
end function

sub cardBadges(g as object, w as dynamic, cd as object)
    b = cd.badge
    if b <> invalid
        st = { v: "A600t10", s: 10.5, c: "0xEAF0FFFF", lh: 16.8, upper: true }
        if b.style = "stream"
            ' Streaming-only title: provider colour, top-left, white type, ellipsis.
            st.c = "0xFFFFFFFF"
            tw = minf(textWidth(b.text, st), w - 14 - 16)
            bw = tw + 16
            uiRect(g, 7, 7, bw, 24.8, rgba(b.color))
            uiText(g, b.text, { v: st.v, s: st.s, c: st.c, lh: st.lh, upper: true, w: tw }, 14, 11)
        else
            tw = textWidth(b.text, st)
            bw = tw + 16
            bx = w - 7 - bw
            fill = "0x08090DD1"
            border = "0xFFFFFF29"
            if b.style = "new"
                fill = m.c.accent
                border = "0x00000000"
            end if
            uiRect(g, bx, 7, bw, 24.8, fill)
            uiFrame(g, bx, 7, bw, 24.8, 1, border)
            uiText(g, b.text, st, bx + 8, 11)
        end if
    end if
    a = cd.alsoOn
    if a <> invalid
        ' "Also on": dark pill outlined in the brand colour, top-left, 9.5px, padding 2x6.
        st = { v: "A600t10", s: 9.5, c: "0xFFFFFFFF", lh: 15.2, upper: true }
        tw = minf(textWidth(a.text, st), w - 14 - 14)
        bw = tw + 14
        uiRect(g, 7, 7, bw, 21.2, "0x08090DC7")
        uiFrame(g, 7, 7, bw, 21.2, 1, rgba(a.color))
        uiText(g, a.text, { v: st.v, s: st.s, c: st.c, lh: st.lh, upper: true, w: tw }, 14, 10)
    end if
end sub

' The card-info panel: bottom-anchored, 124.2px tall at 188 wide.
sub cardInfoDraw(c as object)
    clearChildren(c.info)
    cd = c.cd
    w = c.w
    h = c.h
    top = h - 124.2
    uiImage(c.info, "grad/cardinfo.png", 0, top, w, 124.2)
    ' .ci-title has no colour of its own: it inherits --text (dark in White).
    uiText(c.info, cd.title, { v: "A600", s: 13, c: m.c.text, lh: 20.8, w: w - 24 }, 12, top + 26)
    bx = 12
    by = top + 26 + 20.8 + 8
    ' ▶ play: a filled white disc with the dark glyph.
    uiImage(c.info, "icons/disc.png", bx, by, 32, 32, "0xFFFFFFFF")
    uiText(c.info, "▶", { v: "A400", s: 13, c: "0x0B0C10FF", lh: 32, w: 32, align: "center" }, bx, by)
    bx = bx + 40
    if cd.type = "movie" or isT(cd.dismiss)
        uiImage(c.info, "icons/disc.png", bx, by, 32, 32, "0x14161E99")
        uiImage(c.info, "icons/ring64.png", bx, by, 32, 32, "0xFFFFFF8C")
        uiText(c.info, "✓", { v: "A400", s: 13, c: "0xFFFFFFFF", lh: 32, w: 32, align: "center" }, bx, by)
    end if
    sub1 = str0(cd.sub)
    if sub1 <> ""
        uiText(c.info, sub1, { v: "A400", s: 11.5, c: m.c.muted, lh: 18.4, w: w - 24 }, 12, by + 32 + 7)
    end if
end sub

sub cardFocus(it as object)
    c = it.card
    if c.info.getChildCount() = 0 then cardInfoDraw(c)
    c.info.visible = true
    c.bar.visible = true
    c.frame.visible = true
end sub

sub cardBlur(it as object)
    c = it.card
    c.info.visible = false
    c.bar.visible = false
    c.frame.visible = false
end sub

' Enter on a card = the web card's onOpen (the ▶ and ✓ inside are nested
' controls the focus engine never lands on).
sub cardSelect(it as object)
    cd = it.card.cd
    t = cd.type
    if t = "stream"
        openService(cd.provider, cd.title)
    else if t = "continue"
        if cd.kind = "movie"
            openDetail(cd.id, false)
        else
            openShow(cd.showId, invalid, false)
        end if
    else if t = "show"
        openShow(cd.id, invalid, false)
    else
        openDetail(cd.id, false)
    end if
end sub
