' ============================================================
'  The player: androidtv PlayerActivity.kt, ported, plus the web
'  app's native-handoff chain around it (app.js tryNativeHandoff /
'  __marqueeNativeDone).
'
'  On Android TV every play goes to PlayerActivity (libVLC). It
'  direct-plays /api/stream, keeps its own HUD (dp sizes, Roboto,
'  the Braun player palette), and reports {ended, failed, position}
'  back to the web app, which chains the next episode, rolls a
'  channel on, or falls back to a server-converted stream.
'  The Roku does the same with its Video node; its fallback is the
'  server's HLS route (/api/hls), at the same position.
' ============================================================

' app.js openPlayer() -> tryNativeHandoff(): build the spec and go.
sub openPlayer(ctx as object)
    files = ctx.files
    if files = invalid or files.Count() = 0 then return
    f = invalid
    for each x in files
        if str0(x.id) = str0(ctx.startFileId) then f = x
    end for
    if f = invalid then f = files[0]
    ' Settings > Audio > TV player engine: Classic skips the native player
    ' (Android: the web player; here: the server-converted stream).
    if regRead("classicPlayer", "0") = "1" then ctx.fallback = true
    tele("player", { ev: "handoff", title: ctx.title, kind: ctx.searchKind, live: isT(ctx.live) })
    kind = ctx.searchKind
    preroll = invalid
    ' The fallback still plays it: on Android the fallback is the web player,
    ' which runs the pre-roll for a movie started at 0 (Classic included).
    if kind = "movie" and not (num(ctx.startAt, 0) > 0) and m.prerollInfo <> invalid then preroll = "/api/preroll/stream"
    spec = {
        title: str0(ctx.title), subtitle: str0(ctx.subtitle), kind: kind, fileId: f.id, filename: str0(f.filename),
        startAt: num(ctx.startAt, 0), live: isT(ctx.live),
        streamPath: ctx.streamBase + str0(f.id),
        playPath: "/api/play/" + kind + "/" + str0(f.id) + "?native=1",
        subListPath: "/api/subtitles/list/" + kind + "/" + str0(f.id),
        subBase: ctx.subtitleBase + str0(f.id),
        progressPath: ctx.progressUrl,
        prerollPath: preroll,
        hasUpNext: ctx.chain <> invalid,
        fallback: isT(ctx.fallback),
        deviceId: m.teleDevice
    }
    m.pctx = ctx
    playerStart(spec)
end sub

' A top-level view change, closing the detail, etc. must never leave a player.
sub stopActivePlayer()
    if isT(m.playerOpen) then playerFinish(false, false, true)
end sub

' ------------------------------------------------------------ setup
sub playerStart(spec as object)
    pl = {
        spec: spec, live: spec.live, startAt: spec.startAt, inPreroll: false, mainStarted: false,
        resumeApplied: false, subsForcedOff: false, userPickedSub: false, durationSec: 0.0,
        positionSec: 0.0, endedNaturally: false, introStart: -1, introEnd: -1, introSkipped: false,
        hasUpNext: spec.hasUpNext, creditsTaken: false, hudVisible: false,
        sessionId: newUuid(), rebufferStartedAt: 0, rebufferCount: 0, seekGateUntil: 0,
        subTracks: [], currentSubIdx: -1, aiJobRunning: false, menuOpen: false, menuSel: 1,
        base: 0.0, finished: false, wasPlaying: false, cues: [], errShown: false
    }
    m.pl = pl
    m.playerOpen = true
    playerBuildUi()
    if spec.prerollPath <> invalid and not pl.live
        pl.inPreroll = true
        playerPlayUrl(absUrl(withToken(spec.prerollPath)), "")
    else
        playerStartMain()
    end if
    playerFetchInfo()
    if m.plNet = invalid
        m.plNet = CreateObject("roSGNode", "Timer")
        m.plNet.duration = 10
        m.plNet.repeat = true
        m.plNet.observeField("fire", "playerNetTick")
    end if
    m.plNet.control = "start"
end sub

function streamFormatOf(filename as string) as string
    ext = LCase(filename)
    dot = 0
    for i = Len(ext) to 1 step -1
        if Mid(ext, i, 1) = "."
            dot = i
            exit for
        end if
    end for
    if dot = 0 then return ""
    e = Mid(ext, dot + 1)
    if e = "mkv" or e = "webm" then return "mkv"
    if e = "mp4" or e = "m4v" or e = "mov" then return "mp4"
    if e = "ts" or e = "m2ts" then return "ts"
    return ""
end function

sub playerStartMain()
    pl = m.pl
    pl.inPreroll = false
    pl.mainStarted = true
    sp = pl.spec
    if sp.fallback
        ' The server-converted stream, starting where the direct play stopped.
        pl.base = sp.startAt
        q = "?start=" + fixed2(sp.startAt)
        if regRead("audioMode", "stereo") = "surround" then q = q + "&audio=surround"
        url = absUrl(withToken("/api/hls/" + sp.kind + "/" + str0(sp.fileId) + "/index.m3u8" + q))
        playerPlayUrl(url, "hls")
        pl.resumeApplied = true
    else
        playerPlayUrl(absUrl(withToken(sp.streamPath)), streamFormatOf(sp.filename))
    end if
    mode = "direct"
    if sp.fallback then mode = "transcode"
    tele("player", { ev: "load", native: true, mode: mode, title: sp.title, live: pl.live, at: Int(pl.startAt) })
end sub

sub playerPlayUrl(url as string, fmt as string)
    c = CreateObject("roSGNode", "ContentNode")
    c.url = url
    if fmt <> "" then c.streamFormat = fmt
    c.title = m.pl.spec.title
    m.video.content = c
    playerShowBuffering(true)
    m.video.control = "play"
end sub

sub playerBuildUi()
    g = m.playerG
    clearChildren(g)
    uiRect(g, 0, 0, 960, 540, "0x000000FF")
    v = CreateObject("roSGNode", "Video")
    v.width = 1920
    v.height = 1080
    v.enableUI = false
    v.notificationInterval = 0.5
    v.observeField("state", "onVideoState")
    v.observeField("position", "onVideoPosition")
    v.observeField("duration", "onVideoDuration")
    g.appendChild(v)
    m.video = v
    ' Captions (libVLC draws them over the picture: white, black outline).
    m.plSubG = uiGroup(g, 0, 0)
    ' HUD.
    m.plHud = uiGroup(g, 0, 0)
    m.plHud.visible = false
    playerBuildHud()
    ' Skip pills: bottom|end, 40 from the right, 90 from the bottom.
    m.plSkipIntro = playerPill(g, "SKIP INTRO ▸  (OK)")
    m.plSkipCredits = playerPill(g, "SKIP CREDITS ▸  (OK)")
    ' Buffering: the MARQUEE splash.
    m.plBuf = uiGroup(g, 0, 0)
    uiRect(m.plBuf, 0, 0, 960, 540, "0x0E0E16BA")
    bh = tvLineH(34)
    lh2 = tvLineH(12)
    top = (540 - (bh + 14 + lh2)) / 2
    uiText(m.plBuf, "MARQUEE", { v: "R700t35", s: 34, c: m.pc.ink, lh: bh, w: 960, align: "center" }, 0, top)
    uiText(m.plBuf, "LOADING…", { v: "R400t22", s: 12, c: m.pc.ink2, lh: lh2, w: 960, align: "center" }, 0, top + bh + 14)
    ' Subtitles menu.
    m.plMenu = uiGroup(g, 0, 0)
    m.plMenu.visible = false
    ' Error (only the fallback path shows one: the web player's .vp-error).
    m.plErr = uiGroup(g, 0, 0)
    m.plErr.visible = false
end sub

sub playerBuildHud()
    h = m.plHud
    sp = m.pl.spec
    live = m.pl.live
    ' Top: title 18sp bold, subtitle 13sp, padding 34/22/34/30, black 70% -> 0.
    th = tvLineH(18)
    sh = 0
    if sp.subtitle <> "" then sh = tvLineH(13)
    topH = 22 + th + sh + 30
    uiImage(h, "grad/hudtop.png", 0, 0, 960, topH)
    uiText(h, sp.title, { v: "R700", s: 18, c: m.pc.ink, lh: th, w: 892 }, 34, 22)
    if sh > 0 then uiText(h, sp.subtitle, { v: "R400", s: 13, c: m.pc.ink2, lh: sh, w: 892 }, 34, 22 + th)
    ' Bottom: 4dp scrub, 10 gap, then play icon / time / hint; black 78% -> 0.
    rowH = tvLineH(15)
    botH = 30 + 4 + 10 + rowH + 24
    by = 540 - botH
    uiImage(h, "grad/hudbottom.png", 0, by, 960, botH)
    m.plScrubTrack = uiRect(h, 34, by + 30, 892, 4, "0xFFFFFF2E")
    m.plScrubFill = uiRect(h, 34, by + 30, 0, 4, m.pc.signal)
    if live
        m.plScrubTrack.visible = false
        m.plScrubFill.visible = false
    end if
    ry = by + 30 + 4 + 10
    m.plPlayIcon = uiText(h, "❚❚", { v: "R700", s: 15, c: m.pc.ink, lh: rowH }, 34, ry)
    tx = 34
    if live
        m.plPlayIcon.visible = false
    else
        tx = 34 + measure("❚❚", "R700", 15) + 14
    end if
    m.plTimeX = tx
    if live
        m.plTime = uiText(h, "LIVE", { v: "R400t30", s: 13, c: m.pc.signal, lh: rowH }, tx, ry)
        hint = "▼ subtitles · Back exit"
    else
        m.plTime = uiText(h, "0:00 / 0:00", { v: "R400t06", s: 13, c: m.pc.ink, lh: rowH }, tx, ry)
        hint = "OK play/pause · ◀ ▶ ±10s · ▼ subtitles · Back exit"
    end if
    uiText(h, hint, { v: "R400t08", s: 12, c: m.pc.ink3, lh: rowH, w: 892, align: "right" }, 34, ry)
end sub

function playerPill(g as object, text as string) as object
    lh = tvLineH(14)
    tw = measure(text, "R700t18", 14)
    w = tw + 40 + 2
    h = lh + 22 + 2
    x = 960 - 40 - w
    y = 540 - 90 - h
    p = uiGroup(g, x, y)
    uiRect(p, 0, 0, w, h, "0x141416D2")
    uiFrame(p, 0, 0, w, h, 1, m.pc.rule)
    uiText(p, text, { v: "R700t18", s: 14, c: m.pc.ink, lh: lh }, 21, 12)
    p.visible = false
    return p
end function

sub playerShowBuffering(on as boolean)
    if m.plBuf <> invalid then m.plBuf.visible = on
end sub

' ------------------------------------------------------------ video events
sub onVideoState()
    pl = m.pl
    if pl = invalid or pl.finished then return
    st = m.video.state
    if st = "buffering"
        if pl.mainStarted and pl.resumeApplied and pl.wasPlaying and pl.rebufferStartedAt = 0 then pl.rebufferStartedAt = nowMs()
        playerShowBuffering(true)
    else if st = "playing"
        playerShowBuffering(false)
        if pl.rebufferStartedAt > 0
            started = pl.rebufferStartedAt
            pl.rebufferStartedAt = 0
            if not pl.inPreroll and pl.resumeApplied
                ms = nowMs() - started
                if nowMs() < pl.seekGateUntil
                    pl.seekGateUntil = 0
                else if ms > 700
                    pl.rebufferCount = pl.rebufferCount + 1
                    tele("buffer", { kind: "rebuffer", native: true, ms: Int(ms), at: Int(pl.positionSec) })
                end if
            end if
        end if
        pl.wasPlaying = true
        if pl.inPreroll then return
        ' Resume: exactly once, only now that it's playing.
        if not pl.resumeApplied
            pl.resumeApplied = true
            if pl.startAt > 1
                playerMarkSeek()
                m.video.seek = pl.startAt
            end if
            playerAfter(0.8, "playerForceSubsOff")
        end if
        playerUpdateHud()
    else if st = "paused"
        pl.wasPlaying = false
        playerUpdateHud()
        playerPostProgress(false)
        playerHeartbeat()
    else if st = "finished"
        if pl.inPreroll
            playerStartMain()
            return
        end if
        pl.endedNaturally = true
        playerPostProgress(true)
        playerFinish(true, false, false)
    else if st = "error"
        if pl.inPreroll
            ' A broken pre-roll must never trap the viewer.
            playerStartMain()
            return
        end if
        tele("error", { ev: "native-media-error", title: pl.spec.title, at: Int(pl.positionSec), msg: str0(m.video.errorMsg) })
        if pl.spec.fallback
            playerShowError()
        else
            playerFinish(false, true, false)
        end if
    end if
end sub

sub onVideoPosition()
    pl = m.pl
    if pl = invalid or pl.inPreroll or pl.finished then return
    pl.positionSec = pl.base + m.video.position
    playerOnTick()
    playerRenderSub()
end sub

sub onVideoDuration()
    pl = m.pl
    if pl = invalid or pl.inPreroll then return
    if pl.durationSec <= 0 and m.video.duration > 0 then pl.durationSec = pl.base + m.video.duration
end sub

' libVLC turns the first embedded text track on by itself; the Roku doesn't,
' but a stream can still carry a default caption track: keep them OFF.
sub playerForceSubsOff()
    pl = m.pl
    if pl = invalid or pl.subsForcedOff or pl.userPickedSub then return
    pl.subsForcedOff = true
    m.video.globalCaptionMode = "Off"
end sub

sub playerMarkSeek()
    m.pl.seekGateUntil = nowMs() + 15000
end sub

sub playerSeekBy(delta as integer)
    pl = m.pl
    if pl.live or pl.inPreroll then return
    d = pl.durationSec
    if d <= 0 then d = pl.base + m.video.duration
    target = pl.positionSec + delta
    hi = target
    if d > 1 then hi = d - 1
    target = clamp(target, 0, hi)
    playerMarkSeek()
    m.video.seek = target - pl.base
    pl.positionSec = target
    playerFlashHud()
end sub

sub playerTogglePause()
    pl = m.pl
    ' A channel does not pause.
    if pl.live or pl.inPreroll then return
    if m.video.state = "playing"
        m.video.control = "pause"
    else
        m.video.control = "resume"
    end if
    playerFlashHud()
end sub

' ------------------------------------------------------------ /api/play
sub playerFetchInfo()
    p = m.pl.spec.playPath
    if p = invalid or p = "" then return
    apiGet(p, onPlayInfo, m.pl.sessionId)
end sub

sub onPlayInfo(res as object, sid as string)
    pl = m.pl
    if pl = invalid or pl.sessionId <> sid then return
    j = res.data
    if j = invalid then return
    if num(j.duration, 0) > 0 then pl.durationSec = j.duration
    if j.intro <> invalid
        pl.introStart = num(j.intro.start, -1)
        pl.introEnd = num(j.intro["end"], -1)
    end if
end sub

' ------------------------------------------------------------ ticks
sub playerOnTick()
    pl = m.pl
    playerUpdateHud()
    posS = pl.positionSec
    inIntro = not pl.live and not pl.introSkipped and pl.introEnd > 0 and posS >= pl.introStart and posS < pl.introEnd
    m.plSkipIntro.visible = inIntro
    ' Skip Credits: the last 45 seconds of an episode that has a next one.
    inCredits = not pl.live and pl.hasUpNext and not pl.creditsTaken and pl.durationSec > 0 and posS >= pl.durationSec - 45 and posS < pl.durationSec - 1
    m.plSkipCredits.visible = inCredits
end sub

' The reporting tick is a real timer: position stops while paused, and a
' paused viewer must stay visible in the admin monitor.
sub playerNetTick()
    pl = m.pl
    if pl = invalid or pl.finished then return
    if pl.mainStarted and not pl.inPreroll
        playerPostProgress(false)
        playerHeartbeat()
        teleFlush()
    end if
end sub

sub playerSkipCreditsNow()
    pl = m.pl
    if pl.creditsTaken or pl.live or not pl.hasUpNext then return
    pl.creditsTaken = true
    m.plSkipCredits.visible = false
    playerPostProgress(true)
    playerFinish(true, false, false)
end sub

sub playerSkipIntroNow()
    pl = m.pl
    if pl.live or pl.introEnd <= 0 then return
    pl.introSkipped = true
    m.plSkipIntro.visible = false
    playerMarkSeek()
    m.video.seek = pl.introEnd - pl.base
end sub

' ------------------------------------------------------------ reporting
sub playerPostProgress(watched as boolean)
    pl = m.pl
    path = pl.spec.progressPath
    if path = invalid or path = "" then return
    if pl.inPreroll or pl.positionSec <= 0 then return
    d = pl.durationSec
    done = watched or (d > 0 and pl.positionSec / d > 0.92)
    body = { position: pl.positionSec }
    if d > 0 then body.duration = d
    if done then body.watched = 1
    apiPost(path, body)
end sub

sub playerHeartbeat()
    pl = m.pl
    sp = pl.spec
    apiPost("/api/session/heartbeat", {
        sessionId: pl.sessionId, kind: sp.kind, fileId: sp.fileId, title: sp.title, subtitle: sp.subtitle,
        mode: "direct", position: pl.positionSec, duration: pl.durationSec,
        paused: m.video.state <> "playing", live: pl.live, stalls: pl.rebufferCount,
        tv: true, native: true, audioMode: "native"
    })
end sub

' ------------------------------------------------------------ subtitles
sub playerOpenSubsMenu()
    pl = m.pl
    if pl.inPreroll then return
    pl.menuOpen = true
    m.plMenu.visible = true
    playerSetHud(false)
    playerRenderMenu()
    apiGet(pl.spec.subListPath, onSubList, pl.sessionId)
end sub

sub onSubList(res as object, sid as string)
    pl = m.pl
    if pl = invalid or pl.sessionId <> sid then return
    if res.data <> invalid and type(res.data) = "roArray"
        pl.subTracks = res.data
        if pl.menuOpen then playerRenderMenu()
    end if
end sub

' Right-side panel, 340dp, 30 from the edge, centred vertically.
sub playerRenderMenu()
    pl = m.pl
    g = m.plMenu
    clearChildren(g)
    rows = []
    ai = "✨ Generate with AI…"
    if pl.aiJobRunning then ai = "✨ Generating…"
    if pl.aiText <> invalid then ai = pl.aiText
    rows.Push({ text: ai, idx: -2, ai: true })
    rows.Push({ text: "Off", idx: -1 })
    for i = 0 to pl.subTracks.Count() - 1
        t = pl.subTracks[i]
        idx = i
        if t.idx <> invalid then idx = t.idx
        lbl = str0(t.label)
        if lbl = "" then lbl = "Track " + str0(i + 1)
        rows.Push({ text: lbl, idx: idx })
    end for
    pl.menuRows = rows
    if pl.menuSel > rows.Count() then pl.menuSel = rows.Count()
    headH = tvLineH(11) + 16
    rowH = tvLineH(14) + 22
    h = 10 + headH + rows.Count() * rowH + 10 + 2
    if h > 540 then h = 540
    x = 960 - 30 - 340
    y = (540 - h) / 2
    uiRect(g, x, y, 340, h, "0x1D1D20F6")
    uiFrame(g, x, y, 340, h, 1, m.pc.rule)
    uiText(g, "Subtitles", { v: "R700t24", s: 11, c: m.pc.ink3, lh: tvLineH(11) }, x + 1 + 6 + 14, y + 1 + 10 + 8)
    ry = y + 1 + 10 + headH
    for i = 0 to rows.Count() - 1
        r = rows[i]
        on = (i + 1 = pl.menuSel)
        if on then uiRect(g, x + 7, ry, 326, rowH, m.pc.panel2)
        ink = m.pc.ink2
        if on then ink = m.pc.signal
        t = r.text
        if not isT(r.ai) and r.idx = pl.currentSubIdx then t = "✓ " + t
        st = { v: "R400", s: 14, c: ink, lh: tvLineH(14) }
        if isT(r.ai)
            parts = [{ e: "2728" }, Mid(t, 2)]
            uiRich(g, parts, st, x + 7 + 14, ry + 11)
        else
            uiText(g, t, { v: "R400", s: 14, c: ink, lh: tvLineH(14), w: 298 }, x + 7 + 14, ry + 11)
        end if
        ry = ry + rowH
    end for
end sub

sub playerMenuClick()
    pl = m.pl
    r = pl.menuRows[pl.menuSel - 1]
    if r = invalid then return
    if isT(r.ai)
        playerStartAiSubs()
    else
        playerSelectSub(r.idx)
    end if
end sub

sub playerSelectSub(idx as integer)
    pl = m.pl
    pl.currentSubIdx = idx
    pl.userPickedSub = true
    pl.cues = []
    clearChildren(m.plSubG)
    if idx >= 0
        ' Server tracks (sidecars + extracted embedded) are WebVTT.
        t = newNode("Http")
        t.url = absUrl(withToken(pl.spec.subBase + "?idx=" + str0(idx)))
        t.raw = true
        t.observeField("result", "onSubText")
        m.plSubTask = t
        m.plSubFor = idx
        t.control = "RUN"
    end if
    playerCloseMenu()
end sub

sub onSubText(ev as object)
    pl = m.pl
    if pl = invalid then return
    if m.plSubFor <> pl.currentSubIdx then return
    res = ev.getData()
    pl.cues = parseVtt(str0(res.text))
    playerRenderSub()
end sub

' app.js parseVtt(): hours optional, . or , before the milliseconds.
function parseVtt(text as string) as object
    out = []
    rx = CreateObject("roRegex", "(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})", "")
    tagRx = CreateObject("roRegex", "<[^>]+>", "")
    t = text.Replace(Chr(13), "")
    blocks = CreateObject("roRegex", "\n\n+", "").Split(t)
    for each block in blocks
        lines = block.Split(Chr(10))
        tl = -1
        for i = 0 to lines.Count() - 1
            if Instr(1, lines[i], "-->") > 0
                tl = i
                exit for
            end if
        end for
        if tl >= 0
            mt = rx.Match(lines[tl])
            if mt.Count() >= 9
                st = Val(mt[1]) * 3600 + Val(mt[2]) * 60 + Val(mt[3]) + Val(mt[4]) / 1000
                en = Val(mt[5]) * 3600 + Val(mt[6]) * 60 + Val(mt[7]) + Val(mt[8]) / 1000
                body = []
                for j = tl + 1 to lines.Count() - 1
                    if lines[j].Trim() <> "" then body.Push(tagRx.ReplaceAll(lines[j], ""))
                end for
                out.Push({ s: st, e: en, lines: body })
            end if
        end if
    end for
    return out
end function

sub playerRenderSub()
    pl = m.pl
    if pl = invalid then return
    t = pl.positionSec
    active = []
    for each c in pl.cues
        if t >= c.s and t <= c.e
            for each l in c.lines
                active.Push(l)
            end for
        end if
    end for
    key = joinArr(active, Chr(10))
    if key = pl.subShown then return
    pl.subShown = key
    g = m.plSubG
    clearChildren(g)
    n = active.Count()
    if n = 0 then return
    lh = 24 * 1.25
    y = 540 - 540 * 0.05 - n * lh
    for i = 0 to n - 1
        ly = y + i * lh
        ' A black outline, the way libVLC draws captions.
        for each o in [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]
            uiText(g, active[i], { v: "R400", s: 24, c: "0x000000FF", lh: lh, w: 960, align: "center" }, o[0], ly + o[1])
        end for
        uiText(g, active[i], { v: "R400", s: 24, c: "0xFFFFFFFF", lh: lh, w: 960, align: "center" }, 0, ly)
    end for
end sub

sub playerStartAiSubs()
    pl = m.pl
    if pl.aiJobRunning then return
    pl.aiJobRunning = true
    pl.aiText = invalid
    playerRenderMenu()
    apiPost("/api/subtitles/generate", { kind: pl.spec.kind, fileId: pl.spec.fileId, target: "orig" })
    playerPollAi()
end sub

sub playerPollAi()
    pl = m.pl
    if pl = invalid then return
    q = "kind=" + pl.spec.kind + "&fileId=" + str0(pl.spec.fileId) + "&target=orig"
    apiGet("/api/subtitles/generate?" + q, onAiPoll, pl.sessionId)
end sub

sub onAiPoll(res as object, sid as string)
    pl = m.pl
    if pl = invalid or pl.sessionId <> sid then return
    j = res.data
    if j = invalid then j = {}
    st = str0(j.status)
    if st = "running"
        ' optInt() on Android: the percent is truncated, not rounded.
        pl.aiText = "✨ Generating… " + Int(num(j.pct, 0)).ToStr() + "% (" + str0(j.phase) + ")"
        if pl.menuOpen then playerRenderMenu()
        playerAfter(2.5, "playerPollAi")
    else if st = "done"
        pl.aiJobRunning = false
        pl.aiText = invalid
        apiGet(pl.spec.subListPath, onSubList, pl.sessionId)
    else if st = "error"
        pl.aiJobRunning = false
        pl.aiText = "✨ Failed — try again"
        if pl.menuOpen then playerRenderMenu()
    else
        pl.aiJobRunning = false
        pl.aiText = invalid
        if pl.menuOpen then playerRenderMenu()
    end if
end sub

sub playerCloseMenu()
    m.pl.menuOpen = false
    m.plMenu.visible = false
end sub

' ------------------------------------------------------------ keys
function playerKey(key as string, press as boolean) as boolean
    if not press then return true
    pl = m.pl
    if pl = invalid then return true
    if pl.errShown
        if key = "back" then playerFinish(false, false, true)
        return true
    end if
    ' Pre-roll: locked. Back still exits everything.
    if pl.inPreroll
        if key = "back" then playerFinish(false, false, false)
        return true
    end if
    if pl.menuOpen
        if key = "back"
            playerCloseMenu()
        else if key = "up"
            if pl.menuSel > 1 then pl.menuSel = pl.menuSel - 1
            playerRenderMenu()
        else if key = "down"
            if pl.menuSel < pl.menuRows.Count() then pl.menuSel = pl.menuSel + 1
            playerRenderMenu()
        else if key = "OK"
            playerMenuClick()
        end if
        return true
    end if
    if key = "OK"
        if m.plSkipIntro.visible
            playerSkipIntroNow()
        else if m.plSkipCredits.visible
            playerSkipCreditsNow()
        else
            playerTogglePause()
        end if
    else if key = "play"
        playerTogglePause()
    else if key = "left" or key = "rewind"
        playerSeekBy(-10)
    else if key = "right" or key = "fastforward"
        playerSeekBy(10)
    else if key = "up"
        playerFlashHud()
    else if key = "down"
        playerOpenSubsMenu()
    else if key = "back"
        if pl.hudVisible
            playerSetHud(false)
        else
            playerPostProgress(false)
            playerFinish(false, false, false)
        end if
    end if
    return true
end function

' ------------------------------------------------------------ HUD
sub playerSetHud(v as boolean)
    pl = m.pl
    pl.hudVisible = v
    m.plHud.visible = v
    if m.plHudTimer = invalid
        m.plHudTimer = CreateObject("roSGNode", "Timer")
        m.plHudTimer.duration = 4
        m.plHudTimer.observeField("fire", "playerHudTimeout")
    end if
    m.plHudTimer.control = "stop"
    if v then m.plHudTimer.control = "start"
end sub

sub playerHudTimeout()
    if m.pl <> invalid then playerSetHud(false)
end sub

sub playerFlashHud()
    playerSetHud(true)
    playerUpdateHud()
end sub

sub playerUpdateHud()
    pl = m.pl
    if pl = invalid or not pl.hudVisible then return
    if m.video.state = "playing"
        m.plPlayIcon.text = "❚❚"
    else
        m.plPlayIcon.text = "▶"
    end if
    if not pl.live
        d = pl.durationSec
        if d <= 0 then d = pl.base + m.video.duration
        m.plTime.text = fmtTime(pl.positionSec) + " / " + fmtTime(d)
        w = 0
        if d > 0 then w = clamp(pl.positionSec / d, 0, 1) * 892
        m.plScrubFill.width = pxs(w)
    end if
end sub

' The web player's .vp-error, shown only when the fallback stream fails too.
sub playerShowError()
    pl = m.pl
    pl.errShown = true
    playerShowBuffering(false)
    g = m.plErr
    clearChildren(g)
    uiRect(g, 0, 0, 960, 540, "0x000000C7")
    uiText(g, "Playback failed.", { v: "A600", s: 21, c: m.pc.ink, lh: 33.6, w: 960, align: "center" }, 0, 230)
    uiPara(g, "This file may be corrupt or use a codec the player can't read.", { v: "A400", s: 14.5, c: m.pc.ink3, lh: 23.2, align: "center" }, 0, 273.6, 960)
    g.visible = true
end sub

' ------------------------------------------------------------ finishing
' PlayerActivity.finishWithResult, then the web's __marqueeNativeDone.
' silent: a teardown with nothing to report back (a view change).
sub playerFinish(ended as boolean, failed as boolean, silent as boolean)
    pl = m.pl
    if pl = invalid or pl.finished then return
    pl.finished = true
    tele("player", { ev: "close", native: true, title: pl.spec.title, at: Int(pl.positionSec), dur: Int(pl.durationSec), ended: ended, failed: failed })
    teleFlush()
    if not ended and not failed then playerPostProgress(false)
    apiPost("/api/session/end", { sessionId: pl.sessionId })
    if m.plNet <> invalid then m.plNet.control = "stop"
    if m.plHudTimer <> invalid then m.plHudTimer.control = "stop"
    if m.video <> invalid
        m.video.control = "stop"
        m.video.unobserveField("state")
        m.video.unobserveField("position")
        m.video.unobserveField("duration")
    end if
    clearChildren(m.playerG)
    m.video = invalid
    m.playerOpen = false
    posS = pl.positionSec
    endedAll = ended or pl.endedNaturally
    m.pl = invalid
    if silent then return
    playerNativeDone(endedAll, failed, posS)
end sub

' app.js window.__marqueeNativeDone.
sub playerNativeDone(ended as boolean, failed as boolean, position as dynamic)
    ctx = m.pctx
    m.pctx = invalid
    if ctx = invalid then return
    tele("player", { ev: "native-done", title: ctx.title, ended: ended, failed: failed, at: Int(position) })
    if failed
        ' The Roku couldn't play this file: fall back to the server's converted
        ' stream from where it got to (Android: the web player, which transcodes).
        ctx.fallback = true
        if position > 5 then ctx.startAt = position
        openPlayer(ctx)
        return
    end if
    if ended and ctx.chain <> invalid
        ch = ctx.chain
        if ch.kind = "episode"
            playEpisodeAt(ch.show, ch.flat, ch.i, { autoAdvance: true })
        else if ch.kind = "live"
            tuneIn(ch.chanIdx)
        end if
        return
    end if
    ' Watch state was written by the player; refresh Continue Watching.
    if m.currentView = "home" then renderView()
end sub

' A one-shot delayed call (postDelayed).
sub playerAfter(sec as float, fn as string)
    t = CreateObject("roSGNode", "Timer")
    t.duration = sec
    t.repeat = false
    t.observeField("fire", fn)
    ' Keep a reference or the timer is collected before it fires.
    if m.plTimerList = invalid then m.plTimerList = []
    if m.plTimerList.Count() > 8 then m.plTimerList.Shift()
    m.plTimerList.Push(t)
    t.control = "start"
end sub
