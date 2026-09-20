' ============================================================
'  Sign in / create account (index.html #auth + app.js setupAuth).
'
'  Measured: a 400px card centred on the page (rgba(23,26,34,.92),
'  1px line, padding 36/30/26, 12px between items): MARQUEE (the
'  20px brand), "Sign in to continue" 16px muted, 46px inputs (the
'  WebView's input font, 16px, padding 13x14, panel-2), an 18px
'  error line in the signal colour, the full-width Sign in button
'  4 below it, and the 14px muted toggle.
' ============================================================

sub loginInit()
    la = m.top.launchArgs
    if la <> invalid and la.mqtoken <> invalid
        m.token = la.mqtoken
        regWrite("token", m.token)
    end if
    if la <> invalid and la.mqdebug <> invalid then m.debug = true
    m.authMode = "login"
    m.authFields = { user: "", pass: "", code: "" }
    m.authErr = ""
    m.authBusy = false
end sub

sub showAuth()
    m.authOpen = true
    stopActivePlayer()
    authRender(invalid)
end sub

sub hideAuth()
    m.authOpen = false
    clearChildren(m.authG)
    scReset("auth")
    if m.fCur <> invalid and m.fCur.sc = "auth" then m.fCur = invalid
end sub

sub authError(msg as string)
    m.authErr = msg
    if isT(m.authOpen) then authRender(authFocusKey())
end sub

function authFocusKey() as dynamic
    if m.fCur <> invalid and m.fCur.sc = "auth" then return m.fCur.akey
    return invalid
end function

sub authRender(keep as dynamic)
    g = m.authG
    clearChildren(g)
    scReset("auth")
    s = scAdd("auth", g, "auth", 0, 540)
    s.fixed = true
    reg = (m.authMode = "register")
    ' The overlay has no background of its own (.auth-bg is forced to none), so
    ' the ribbon and the empty page show around the card.
    ' Height (measured, 385.6 signing in): 36 + brand 32 + 2 + 12 + sub 25.6 + 12
    ' + 12 + inputs (46 + 12 each) + error 18 + 12 + 4 + button 41 + 12 + 6 +
    ' toggle 17 + 26, and 1px borders.
    n = 2
    if reg then n = 3
    innerH = 32 + 2 + 12 + 25.6 + 12 + 12 + n * (46 + 12) + 18 + 12 + 4 + 41 + 12 + 6 + 17
    h = 1 + 36 + innerH + 26 + 1
    w = 400
    x = (960 - w) / 2
    y = (540 - h) / 2
    popShadow(g, x, y, w, h)
    uiRect(g, x, y, w, h, "0x171A22EB")
    uiFrame(g, x, y, w, h, 1, m.c.line)
    cx = x + 1 + 30
    cw = w - 2 - 60
    cy = y + 1 + 36
    brand = { v: "A600t30", s: 20, c: m.c.onDark, lh: 32 }
    bw = textWidth("MARQUEE", brand)
    uiText(g, "MARQUEE", brand, cx + (cw - bw) / 2, cy)
    cy = cy + 32 + 2 + 12
    sub1 = "Sign in to continue"
    if reg then sub1 = "Create your account"
    uiText(g, sub1, { v: "A400", s: 16, c: m.c.muted, lh: 25.6, w: cw, align: "center" }, cx, cy)
    cy = cy + 25.6 + 12 + 12
    authInput(g, "user", "Username", false, cx, cy, cw)
    cy = cy + 46 + 12
    authInput(g, "pass", "Password", true, cx, cy, cw)
    cy = cy + 46 + 12
    if reg
        authInput(g, "code", "Invite code", false, cx, cy, cw)
        cy = cy + 46 + 12
    end if
    uiText(g, m.authErr, { v: "A400", s: 14, c: m.c.accent, lh: 18, w: cw, align: "center" }, cx, cy)
    cy = cy + 18 + 12 + 4
    label = "Sign in"
    if reg then label = "Create account"
    if m.authBusy then label = "…"
    b = uiBtn(g, cx, cy, label, { primary: true, flat: true, fullW: cw, play: false })
    b.opts.fullW = cw
    ' .auth-submit.tv-focus adds outline 3px, offset 2 on top of the .btn ring
    ' (it moves with the button's 1px lift).
    b.outline = uiFrame(b.node, -5, -5, cw + 10, b.h + 10, 3, m.c.accent)
    b.outline.visible = false
    btnItem(b, "auth", authSubmit, { akey: "submit", onFocus: authSubmitFocus, onBlur: authSubmitBlur })
    cy = cy + 41 + 12 + 6
    tl = "New here? Create an account"
    if reg then tl = "Have an account? Sign in"
    tg = uiGroup(g, cx, cy)
    tog = { g: tg, w: cw, t: tl }
    authTogglePaint(tog, false)
    fAdd({ sc: "auth", x: cx, y: cy, w: cw, h: 17, kind: "btn", akey: "toggle", tog: tog, onFocus: authToggleFocus, onBlur: authToggleBlur, onSelect: authToggle })
    if keep <> invalid
        for each it in m.fItems["auth"]
            if it.akey = keep
                m.fCur = invalid
                fSet(it)
                return
            end if
        end for
    end if
    m.fCur = invalid
end sub

sub authSubmitFocus(it as object)
    btnPaint(it.btn, true)
    it.btn.outline.visible = true
end sub

sub authSubmitBlur(it as object)
    btnPaint(it.btn, false)
    it.btn.outline.visible = false
end sub

' .auth-input: panel-2, 1px line, 16px, padding 13x14. Its focus ring is a
' 3px signal outline, 2px outside (.auth-input.tv-focus).
sub authInput(g as object, key as string, ph as string, secure as boolean, x as dynamic, y as dynamic, w as dynamic)
    fg = uiGroup(g, x, y)
    f = { g: fg, key: key, ph: ph, secure: secure, w: w }
    authInputPaint(f, false)
    fAdd({ sc: "auth", x: x, y: y, w: w, h: 46, kind: "input", input: true, akey: "in:" + key, field: f, onFocus: authInputFocus, onBlur: authInputBlur, onSelect: authInputEdit })
end sub

sub authInputPaint(f as object, focused as boolean)
    g = f.g
    clearChildren(g)
    if focused then uiFrame(g, -5, -5, f.w + 10, 56, 3, m.c.accent)
    uiRect(g, 0, 0, f.w, 46, m.c.panel2)
    bc = m.c.line
    if isT(m.kbOpen) and m.kbFor = "auth:" + f.key then bc = m.c.accent
    uiFrame(g, 0, 0, f.w, 46, 1, bc)
    v = m.authFields[f.key]
    if v = ""
        uiText(g, f.ph, { v: "R400", s: 16, c: "0x757575FF", lh: 18.75, w: f.w - 30 }, 15, 13.6)
    else
        shown = v
        if f.secure
            shown = ""
            for i = 1 to Len(v)
                shown = shown + "•"
            end for
        end if
        uiText(g, shown, { v: "R400", s: 16, c: m.c.text, lh: 18.75, w: f.w - 30 }, 15, 13.6)
    end if
end sub

sub authInputFocus(it as object)
    authInputPaint(it.field, true)
end sub

sub authInputBlur(it as object)
    authInputPaint(it.field, false)
end sub

sub authInputEdit(it as object)
    f = it.field
    m.authEditing = it
    openKeyboard("auth:" + f.key, f.ph, m.authFields[f.key], f.secure, invalid, authInputDone)
end sub

sub authInputDone(text as string)
    it = m.authEditing
    if it = invalid then return
    m.authFields[it.field.key] = text
    authInputPaint(it.field, m.fCur <> invalid and m.fCur.fid = it.fid)
end sub

' .auth-toggle: a full-width (flex-stretched) button, 14px muted, centred,
' padding 1x6, 17 tall; focused: the 3px signal outline 2px outside its box.
sub authTogglePaint(t as object, focused as boolean)
    clearChildren(t.g)
    if focused then uiFrame(t.g, -5, -5, t.w + 10, 27, 3, m.c.accent)
    uiText(t.g, t.t, { v: "A400", s: 14, c: m.c.muted, lh: 15, w: t.w, align: "center" }, 0, 1)
end sub

sub authToggleFocus(it as object)
    authTogglePaint(it.tog, true)
end sub

sub authToggleBlur(it as object)
    authTogglePaint(it.tog, false)
end sub

sub authToggle(it as object)
    if m.authMode = "login"
        m.authMode = "register"
    else
        m.authMode = "login"
    end if
    m.authErr = ""
    authRender("toggle")
end sub

sub authSubmit(it as object)
    if m.authBusy then return
    m.authErr = ""
    u = m.authFields.user.Trim()
    p = m.authFields.pass
    if u = "" or p = ""
        m.authErr = "Enter a username and password."
        authRender("submit")
        return
    end if
    m.authBusy = true
    authRender("submit")
    if m.authMode = "register"
        apiPost("/api/register", { username: u, password: p, code: m.authFields.code.Trim() }, onAuthDone)
    else
        apiPost("/api/login", { username: u, password: p }, onAuthDone)
    end if
end sub

sub onAuthDone(res as object, ctx as dynamic)
    m.authBusy = false
    if res.code = 0
        m.authErr = "Could not reach the server."
        authRender("submit")
        return
    end if
    if res.code < 200 or res.code >= 300
        msg = "Something went wrong."
        if res.data <> invalid and str0(res.data.error) <> "" then msg = res.data.error
        m.authErr = msg
        authRender("submit")
        return
    end if
    ' location.reload(): signed in, start over.
    if res.data <> invalid and str0(res.data.token) <> ""
        m.token = res.data.token
        regWrite("token", m.token)
    end if
    m.authFields = { user: "", pass: "", code: "" }
    hideAuth()
    apiGet("/api/me", onMe)
end sub
