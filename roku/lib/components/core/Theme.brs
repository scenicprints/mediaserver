' ============================================================
'  Theme: the Braun tokens from public/style.css, and the one
'  scale rule that keeps the Roku a copy of the Android TV app.
'
'  The Android TV WebView lays the web app out on a 960x540 CSS
'  canvas (1080p panel, density 2). The Roku UI is 1920x1080, so
'  every CSS px is exactly 2 Roku px. All layout code below is
'  written in CSS px and goes through pxs() on the way to a node.
' ============================================================

function pxs(v as dynamic) as integer
    return cint(v * 2)
end function

sub themeInit()
    m.fontCache = {}
    m.measureLabel = CreateObject("roSGNode", "Label")
    finish = regRead("finish", "auto")
    themeApply(finish)
end sub

' "auto" = match the device. A Roku has no light/dark setting, and the Android
' TV WebView reports dark, so auto is the Black finish on both.
sub themeApply(finish as string)
    m.finish = finish
    if finish = "white"
        m.c = {
            bg: "0xE7E6E1FF", bg2: "0xEFEEE9FF", panel: "0xF8F7F4FF", panel2: "0xEFEEE9FF",
            sunk: "0xDEDCD5FF", line: "0xCBC9C2FF", line2: "0xDCDAD3FF",
            text: "0x1A1B1DFF", text2: "0x75756EFF", muted: "0xA3A29BFF",
            accent: "0xDE5F10FF", accentDeep: "0xB84A08FF", onAccent: "0xFFFFFFFF",
            inverse: "0x1A1B1DFF", onInverse: "0xF8F7F4FF"
        }
    else
        m.c = {
            bg: "0x141416FF", bg2: "0x232327FF", panel: "0x1D1D20FF", panel2: "0x232327FF",
            sunk: "0x0E0E10FF", line: "0x33333AFF", line2: "0x28282EFF",
            text: "0xEFEEE9FF", text2: "0x8C8C86FF", muted: "0x65655FFF",
            accent: "0xF26A16FF", accentDeep: "0xC85410FF", onAccent: "0x141416FF",
            inverse: "0xEFEEE9FF", onInverse: "0x141416FF"
        }
    end if
    ' Fixed in every finish (the surfaces that are dark whatever the finish).
    m.c.onDark = "0xEFEEE9FF"
    m.c.white = "0xFFFFFFFF"
    m.c.black = "0x000000FF"
    ' The player always wears the black finish (style.css .vp / PlayerActivity Braun).
    m.pc = {
        paper: "0x141416FF", panel: "0x1D1D20FF", panel2: "0x232327FF", ink: "0xEFEEE9FF",
        ink2: "0x8C8C86FF", ink3: "0x65655FFF", rule: "0x33333AFF", signal: "0xF26A16FF"
    }
end sub

' "#rrggbb" or "0xRRGGBBAA" plus an optional alpha 0..1 -> "0xRRGGBBAA".
function rgba(hex as string, alpha = 1.0 as float) as string
    h = hex
    if Left(h, 1) = "#" then h = Mid(h, 2)
    if Left(h, 2) = "0x" then h = Mid(h, 3, 6)
    a = cint(alpha * 255)
    if a < 0 then a = 0
    if a > 255 then a = 255
    return "0x" + UCase(Left(h, 6)) + hexByte(a)
end function

function hexByte(n as integer) as string
    digits = "0123456789ABCDEF"
    return Mid(digits, (n \ 16) + 1, 1) + Mid(digits, (n mod 16) + 1, 1)
end function

' Font variants built by roku/tools/build_assets.py. `w` is the CSS weight
' (anything >= 600 is the SemiBold face, as Chrome picks it with no 700/800
' face on offer), `t` the CSS letter-spacing in em.
function fontVariant(family as string, w as integer, t as float) as string
    if family = "mono"
        base = "M400"
        if w >= 500 then base = "M500"
        if base = "M400" and t >= 0.06 then return "M400t08"
        if base = "M400" and t >= 0.02 then return "M400t04"
        return base
    end if
    wt = "A400"
    if w >= 600
        wt = "A600"
    else if w >= 500
        wt = "A500"
    end if
    if t < 0.02 then return wt
    if wt = "A400" then return "A400t20"
    if wt = "A500"
        if t >= 0.13 then return "A500t16"
        return "A500t10"
    end if
    if t >= 0.28 then return "A600t30"
    if t >= 0.225 then return "A600t25"
    if t >= 0.18 then return "A600t20"
    if t >= 0.15 then return "A600t16"
    if t >= 0.12 then return "A600t14"
    if t >= 0.07 then return "A600t10"
    return "A600t04"
end function

' A Font node for (variant, CSS px size). Cached: fonts are shared by every label.
function fontOf(variant as string, cssSize as float) as object
    key = variant + "@" + Str(cssSize).Trim()
    f = m.fontCache[key]
    if f = invalid
        f = CreateObject("roSGNode", "Font")
        f.uri = "pkg:/fonts/" + variant + ".ttf"
        f.size = pxs(cssSize)
        m.fontCache[key] = f
    end if
    return f
end function

' The CSS content-area height of one line in this font (ascent + descent), in
' CSS px. CSS centres this box inside the line-height; so does a Roku Label
' given a height and vertAlign="center", which is how text lands on the web's
' baselines. Archivo: 878 + 210 per 1000. Roboto Mono: 2146 + 555 per 2048.
function contentHeight(variant as string, cssSize as float) as float
    f = Left(variant, 1)
    if f = "M" then return cssSize * 1.3188
    if f = "R" then return cssSize * 1.1719
    return cssSize * 1.088
end function

' An Android TextView's height for one line: Roboto's yMax..yMin (includeFontPadding).
function tvLineH(sp as dynamic) as float
    return sp * 1.3276
end function

' Width in CSS px of `text` set in (variant, size).
function measure(text as string, variant as string, cssSize as float) as float
    if text = "" then return 0
    lbl = m.measureLabel
    lbl.font = fontOf(variant, cssSize)
    lbl.text = text
    r = lbl.boundingRect()
    return r.width / 2.0
end function
