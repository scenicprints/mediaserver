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
    ' A version switch restarts the film mid-play: never a pre-roll then.
    if kind = "movie" and not (num(ctx.startAt, 0) > 0) and not isT(ctx.noPreroll) and m.prerollInfo <> invalid then preroll = "/api/preroll/stream"
    ' /api/versions describes a title by its own id (the movie or episode, not
    ' the file), which the version key already carries: "m12" / "e34".
    verPath = invalid
    vk = str0(ctx.verKey)
    if files.Count() > 1 and Len(vk) > 1 and (kind = "movie" or kind = "episode") then verPath = "/api/versions/" + kind + "/" + Mid(vk, 2)
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
        files: files, verKey: ctx.verKey, versionsPath: verPath,
        atrack: ctx.atrack,
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
        base: 0.0, finished: false, wasPlaying: false, cues: [], errShown: false,
        audState: "none", audT0: 0, audWaiting: false, audPick: -1, audCount: 0, audApplied: false, audMismatch: false,
        audTracks: [], audCur: -1, versions: invalid, menuTop: 0
    }
    ' A soundtrack the viewer chose before this restart (the fallback after a
    ' failed direct play) is the one playing, not the server's own pick.
    if spec.atrack <> invalid and num(spec.atrack, -1) >= 0 then pl.audCur = num(spec.atrack, -1)
    m.pl = pl
    m.playerOpen = true
    playerBuildUi()
    ' Asked before the pre-roll, so the answer is usually in by the time the
    ' film itself starts.
    playerFetchAudio()
    if spec.prerollPath <> invalid and not pl.live
        pl.inPreroll = true
        playerPlayUrl(absUrl(withToken(spec.prerollPath)), "")
    else
        playerStartMain()
    end if
    playerFetchInfo()
    playerFetchVersions()
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
    sp = pl.spec
    ' Direct play waits for the soundtrack pick (3 seconds at most): it may turn
    ' out the Roku can't play any of the file's tracks, and then the converted
    ' stream is the one to start.
    if not sp.fallback and pl.audState = "pending"
        pl.audWaiting = true
        playerShowBuffering(true)
        ' The 3 seconds count from here: time spent in the pre-roll is free.
        pl.audT0 = nowMs()
        playerAfter(3.0, "playerAudioTimeout")
        return
    end if
    pl.mainStarted = true
    if sp.fallback
        ' The server-converted stream, starting where the direct play stopped.
        pl.base = sp.startAt
        q = "?start=" + fixed2(sp.startAt)
        if regRead("audioMode", "stereo") = "surround" then q = q + "&audio=surround"
        ' A soundtrack picked from the Audio menu: the route carries one audio
        ' rendition, so the choice is part of the request.
        if sp.atrack <> invalid and num(sp.atrack, -1) >= 0 then q = q + "&atrack=" + str0(num(sp.atrack, -1))
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
    v.observeField("availableAudioTracks", "onVideoAudioTracks")
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
    else
        m.plTime = uiText(h, "0:00 / 0:00", { v: "R400t06", s: 13, c: m.pc.ink, lh: rowH }, tx, ry)
    end if
    m.plHint = uiText(h, playerHintText(), { v: "R400t08", s: 12, c: m.pc.ink3, lh: rowH, w: 892, align: "right" }, 34, ry)
end sub

' The hint names what ▼ opens. The Audio section appears only once the track
' list is in, so the hint is rewritten then.
function playerHintText() as string
    pl = m.pl
    holds = ["subtitles"]
    if pl.audTracks.Count() > 1 then holds.Push("audio")
    if pl.spec.files <> invalid and pl.spec.files.Count() > 1 then holds.Push("version")
    menu = "▼ " + joinArr(holds, ", ")
    if pl.live then return menu + " · Back exit"
    return "OK play/pause · ◀ ▶ ±10s · " + menu + " · Back exit"
end function

sub playerRefreshHint()
    if m.plHint <> invalid and m.pl <> invalid then m.plHint.text = playerHintText()
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
        playerApplyAudio()
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

' ------------------------------------------------------------ soundtrack
' Direct play hands the Roku the raw file, and the Roku plays whichever track
' the file marks as default: often TrueHD or DTS, which it can't decode. So ask
' the server what is in the file (app.js chooseAudioTrackThen) and pick one the
' device named in Settings plays as-is. The converted stream needs no pick:
' the server chooses a copyable track for it. The list is still fetched there,
' for the Audio menu.
sub playerFetchAudio()
    pl = m.pl
    sp = pl.spec
    if sp.kind <> "movie" and sp.kind <> "episode" then return
    if not sp.fallback
        pl.audState = "pending"
        pl.audT0 = nowMs()
        ' Playback never depends on this: a slow answer is let go after 3 seconds.
        playerAfter(3.0, "playerAudioTimeout")
    end if
    apiGet("/api/audio/list/" + sp.kind + "/" + str0(sp.fileId), onAudioList, pl.sessionId)
end sub

sub onAudioList(res as object, sid as string)
    pl = m.pl
    if pl = invalid or pl.finished or pl.sessionId <> sid then return
    tracks = invalid
    if res.data <> invalid and type(res.data) = "roAssociativeArray" then tracks = res.data.tracks
    if tracks <> invalid and type(tracks) = "roArray" then pl.audTracks = tracks
    playerRefreshHint()
    if pl.menuOpen then playerRenderMenu()
    ' Started on the converted stream: nothing waits on the list, it only
    ' feeds the Audio menu.
    if pl.audState = "none" then return
    ' After the timeout the film is already playing: a pick can still be
    ' applied, but it is too late to switch to the converted stream.
    late = pl.audState <> "pending"
    pl.audState = "done"
    if tracks <> invalid and type(tracks) = "roArray" and tracks.Count() > 0
        dev = audioDeviceKey()
        pick = audioAutoPick(tracks, dev)
        if pick <> invalid
            pl.audPick = num(pick.index, -1)
            pl.audCount = tracks.Count()
        else if not late and not audioAnyPlayable(tracks, dev)
            ' Nothing in the file the device can decode, so direct play would be
            ' silent. The server's converted stream has sound; converting is
            ' unavoidable here.
            pl.spec.fallback = true
            tele("player", { ev: "audio", result: "convert", title: pl.spec.title, dev: dev })
        end if
    end if
    if late
        playerApplyAudio()
    else
        playerAudioSettled()
    end if
end sub

sub playerAudioTimeout()
    pl = m.pl
    if pl = invalid or pl.finished or pl.audState <> "pending" then return
    ' During the pre-roll nothing is waiting yet; the film starts its own 3
    ' seconds if the answer still hasn't come. A timer left over from the
    ' previous play can also fire early in this one.
    if pl.inPreroll or nowMs() - pl.audT0 < 2900 then return
    pl.audState = "late"
    playerAudioSettled()
end sub

sub playerAudioSettled()
    pl = m.pl
    if pl.audWaiting
        pl.audWaiting = false
        playerStartMain()
    end if
end sub

' Settings > Audio > "What are you watching on?", as app.js deviceType() reads
' it: the stored choice names the device, and Detect means this Roku. The
' server's `playable` map uses the same keys. Anything else (an old or mistyped
' value) counts as a Roku, the hardware actually doing the decoding.
function audioDeviceKey() as string
    t = deviceType()
    if t = "appletv" or t = "androidtv" or t = "roku" or t = "vava" or t = "browser" then return t
    return "roku"
end function

function audioPlayable(t as dynamic, dev as string) as boolean
    if t = invalid or type(t) <> "roAssociativeArray" then return false
    p = t.playable
    if p = invalid or type(p) <> "roAssociativeArray" then return false
    return isT(p[dev])
end function

function audioAnyPlayable(tracks as object, dev as string) as boolean
    for each t in tracks
        if audioPlayable(t, dev) then return true
    end for
    return false
end function

' app.js autoPickTrack(): only tracks the chosen device plays as-is, never
' commentary on its own; Surround wants the most channels, Stereo a real 2.0
' track; then bitrate, then the file's default flag. A tie keeps the file's
' order.
function audioAutoPick(tracks as object, dev as string) as dynamic
    wantSurround = regRead("audioMode", "stereo") = "surround"
    best = invalid
    bestScore = 0.0
    for each t in tracks
        if audioPlayable(t, dev) and not isT(t.commentary)
            ch = num(t.channels, 0)
            s = 0.0
            if wantSurround
                if ch > 8 then ch = 8
                s = s + ch * 10
            else if ch = 2
                s = s + 50
            else if ch < 20
                s = s + (20 - ch)
            end if
            b = num(t.bitrateKbps, 0) / 100
            if b > 10 then b = 10
            s = s + b
            if isT(t.default) then s = s + 5
            if best = invalid or s > bestScore
                best = t
                bestScore = s
            end if
        end if
    end for
    return best
end function

sub onVideoAudioTracks()
    playerApplyAudio()
end sub

' The Roku lists the stream's soundtracks in availableAudioTracks, and writing
' an entry's Track id to audioTrack switches to it. The id's format isn't
' documented, so the pick is matched by position: the server's index is the
' track's place among the file's audio streams. If the Roku lists a different
' number of tracks (it may leave out ones it can't decode), position means
' nothing, and the Roku's own choice stands rather than a guess.
sub playerApplyAudio()
    pl = m.pl
    if pl = invalid or pl.finished or pl.audApplied or pl.audPick < 0 then return
    if not pl.mainStarted or pl.inPreroll or pl.spec.fallback then return
    v = m.video
    if v = invalid then return
    avail = v.availableAudioTracks
    if avail = invalid or type(avail) <> "roArray" or avail.Count() = 0 then return
    if avail.Count() <> pl.audCount
        ' Tracks can be added as the Roku finds them: look again on the next
        ' change, but report it only once.
        if not pl.audMismatch
            pl.audMismatch = true
            tele("player", { ev: "audio", result: "mismatch", title: pl.spec.title, roku: avail.Count(), server: pl.audCount })
        end if
        return
    end if
    t = avail[pl.audPick]
    if t = invalid then return
    id = str0(t.Track)
    if id = "" then return
    pl.audApplied = true
    pl.audCur = pl.audPick
    if str0(v.currentAudioTrack) <> id then v.audioTrack = id
    tele("player", { ev: "audio", result: "set", title: pl.spec.title, idx: pl.audPick, of: pl.audCount, dev: audioDeviceKey() })
end sub

' src/hls.js pickAudioIndex(): the track the converted stream sends when none
' was asked for (copyable first, then not commentary, the most channels,
' E-AC-3 over AC-3 over AAC, the default flag). Only used to tick the right
' row in the Audio menu, so it must stay the server's rule.
function audioHlsDefault(tracks as object) as integer
    pref = ["eac3", "ac3", "aac", "alac", "mp3"]
    best = 0
    bestKey = invalid
    for i = 0 to tracks.Count() - 1
        t = tracks[i]
        codec = LCase(str0(t.codec))
        rank = -1
        for r = 0 to pref.Count() - 1
            if pref[r] = codec then rank = r
        end for
        if rank >= 0
            ch = num(t.channels, 0)
            if ch > 8 then ch = 8
            notComm = 1
            if isT(t.commentary) then notComm = 0
            def = 0
            if isT(t.default) then def = 1
            k = [notComm, ch, -rank, def]
            if bestKey = invalid or audioKeyAbove(k, bestKey)
                best = num(t.index, i)
                bestKey = k
            end if
        end if
    end for
    return best
end function

function audioKeyAbove(a as object, b as object) as boolean
    for i = 0 to a.Count() - 1
        if a[i] <> b[i] then return a[i] > b[i]
    end for
    return false
end function

' Which of the server's tracks is playing, for the tick in the Audio menu: the
' viewer's or the auto-pick's choice; on the converted stream the server's
' default; otherwise whatever the Roku chose, when its list lines up with the
' server's. Unknown is -1, and then nothing is ticked rather than a guess.
function playerAudioCurrent() as integer
    pl = m.pl
    if pl.audCur >= 0 then return pl.audCur
    if pl.spec.fallback then return audioHlsDefault(pl.audTracks)
    v = m.video
    if v = invalid then return -1
    avail = v.availableAudioTracks
    if avail = invalid or type(avail) <> "roArray" or avail.Count() <> pl.audTracks.Count() then return -1
    cur = str0(v.currentAudioTrack)
    if cur = "" then return -1
    for i = 0 to avail.Count() - 1
        if str0(avail[i].Track) = cur then return i
    end for
    return -1
end function

' The menu row: CODEC · layout · LANG · title, and a commentary tag when the
' title doesn't already say so.
function audioTrackLabel(t as object, i as integer) as string
    parts = []
    c = UCase(str0(t.codec))
    if c <> "" then parts.Push(c)
    ly = str0(t.layout)
    if ly = "" and num(t.channels, 0) > 0 then ly = str0(num(t.channels, 0)) + "ch"
    if ly <> "" then parts.Push(ly)
    lang = str0(t.language)
    if lang <> "" and LCase(lang) <> "und" then parts.Push(UCase(lang))
    ti = str0(t.title)
    if ti <> "" then parts.Push(ti)
    if isT(t.commentary) and not CreateObject("roRegex", "comment", "i").IsMatch(ti) then parts.Push("commentary")
    if parts.Count() = 0 then return "Track " + str0(i + 1)
    return joinArr(parts, " · ")
end function

' The viewer's pick from the Audio menu. A track the chosen device plays as-is
' is switched in place on direct play, matched by position the same way the
' auto-pick is (so only when the Roku lists the same number of tracks). Any
' other case, and every switch on the converted stream, is a new converted
' stream at the same position asking for that track: the server converts what
' the device can't decode (TrueHD, DTS on a Roku), and its HLS route carries
' one soundtrack, so there is no switching inside it.
sub playerSelectAudio(idx as integer)
    pl = m.pl
    playerCloseMenu()
    if idx = playerAudioCurrent() then return
    t = invalid
    for each x in pl.audTracks
        if num(x.index, -1) = idx then t = x
    end for
    if t = invalid then return
    ' Kept on the handoff too: if direct play later fails, the fallback stream
    ' plays this track rather than the server's own pick.
    if m.pctx <> invalid then m.pctx.atrack = idx
    dev = audioDeviceKey()
    if not pl.spec.fallback and audioPlayable(t, dev)
        v = m.video
        avail = v.availableAudioTracks
        if avail <> invalid and type(avail) = "roArray" and avail.Count() = pl.audTracks.Count() and idx < avail.Count()
            id = str0(avail[idx].Track)
            if id <> ""
                ' Also stops a late auto-pick from undoing the viewer's choice.
                pl.audApplied = true
                pl.audCur = idx
                if str0(v.currentAudioTrack) <> id then v.audioTrack = id
                tele("player", { ev: "audio", result: "user", how: "track", title: pl.spec.title, idx: idx, of: pl.audTracks.Count(), dev: dev })
                return
            end if
        end if
    end if
    tele("player", { ev: "audio", result: "user", how: "convert", title: pl.spec.title, idx: idx, of: pl.audTracks.Count(), dev: dev, at: Int(pl.positionSec) })
    playerRestartConverted(idx)
end sub

' The fallback's own start (playerStartMain: ?start= and pl.base), from where
' the viewer is now, with the soundtrack named. Captions are drawn here from
' positionSec, so a chosen subtitle carries straight on.
sub playerRestartConverted(atrack as integer)
    pl = m.pl
    sp = pl.spec
    atSec = pl.positionSec
    if atSec < 0 then atSec = 0
    sp.fallback = true
    sp.atrack = atrack
    sp.startAt = atSec
    pl.startAt = atSec
    pl.audApplied = true
    pl.audCur = atrack
    ' The reload's buffering is the viewer's doing, not a stall.
    playerMarkSeek()
    m.video.control = "stop"
    playerStartMain()
end sub

' ------------------------------------------------------------ versions
' /api/versions: what each file actually is ("4K · HEVC HDR10 · TrueHD Atmos
' 7.1 · 58.2 GB"). Until it answers (or if it never does) the rows use the
' filename's description, as the detail page does.
sub playerFetchVersions()
    pl = m.pl
    p = pl.spec.versionsPath
    if p = invalid then return
    apiGet(p, onPlayerVersions, pl.sessionId)
end sub

sub onPlayerVersions(res as object, sid as string)
    pl = m.pl
    if pl = invalid or pl.finished or pl.sessionId <> sid then return
    pl.versions = versionInfoMap(res.data)
    if pl.menuOpen then playerRenderMenu()
end sub

' app.js loadFile() from the version list: the other file, from the same
' position, under the same title (same progress URL, same chain). It is a new
' handoff, so the new file gets its own soundtrack pick, subtitle list and
' direct-play attempt; the old file's fallback and soundtrack don't carry over.
sub playerSelectVersion(fileId as dynamic)
    pl = m.pl
    sp = pl.spec
    playerCloseMenu()
    ctx = m.pctx
    if ctx = invalid or str0(fileId) = str0(sp.fileId) then return
    f = invalid
    for each x in sp.files
        if str0(x.id) = str0(fileId) then f = x
    end for
    if f = invalid then return
    rememberVersion(sp.verKey, f)
    atSec = pl.positionSec
    tele("player", { ev: "version", title: sp.title, from: sp.fileId, to: f.id, at: Int(atSec) })
    ' Silent: reports progress and ends the session, with no native-done chain.
    playerFinish(false, false, true)
    ctx.startFileId = f.id
    ctx.startAt = 0
    if atSec > 1 then ctx.startAt = atSec
    ctx.fallback = false
    ctx.atrack = invalid
    ctx.noPreroll = true
    openPlayer(ctx)
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

' Right-side panel, 340dp, 30 from the edge, centred vertically. Subtitles
' first, as before (so ▼ still lands on the same row), then Audio when the
' file has more than one soundtrack and Version when the title has more than
' one file: the Apple TV's order, sections under their own heading. Headings
' are never focused.
sub playerRenderMenu()
    pl = m.pl
    g = m.plMenu
    clearChildren(g)
    rows = []
    rows.Push({ head: true, text: "Subtitles" })
    ai = "✨ Generate with AI…"
    if pl.aiJobRunning then ai = "✨ Generating…"
    if pl.aiText <> invalid then ai = pl.aiText
    rows.Push({ kind: "sub", text: ai, idx: -2, ai: true })
    rows.Push({ kind: "sub", text: "Off", idx: -1, on: pl.currentSubIdx = -1 })
    for i = 0 to pl.subTracks.Count() - 1
        t = pl.subTracks[i]
        idx = i
        if t.idx <> invalid then idx = t.idx
        lbl = str0(t.label)
        if lbl = "" then lbl = "Track " + str0(i + 1)
        rows.Push({ kind: "sub", text: lbl, idx: idx, on: idx = pl.currentSubIdx })
    end for
    if pl.audTracks.Count() > 1
        rows.Push({ head: true, text: "Audio" })
        cur = playerAudioCurrent()
        for i = 0 to pl.audTracks.Count() - 1
            t = pl.audTracks[i]
            idx = num(t.index, i)
            rows.Push({ kind: "aud", text: audioTrackLabel(t, i), idx: idx, on: idx = cur })
        end for
    end if
    files = pl.spec.files
    if files <> invalid and files.Count() > 1
        rows.Push({ head: true, text: "Version" })
        for i = 0 to files.Count() - 1
            f = files[i]
            rows.Push({ kind: "ver", text: versionFullLabel(pl.versions, f, i), fileId: f.id, on: str0(f.id) = str0(pl.spec.fileId) })
        end for
    end if
    pl.menuRows = rows
    if pl.menuSel > rows.Count() then pl.menuSel = rows.Count()
    if pl.menuSel < 1 then pl.menuSel = 1
    while pl.menuSel < rows.Count() and isT(rows[pl.menuSel - 1].head)
        pl.menuSel = pl.menuSel + 1
    end while
    headH = tvLineH(11) + 16
    rowH = tvLineH(14) + 22
    ' A later section starts 10 lower, under a hairline.
    gapH = 10
    hts = []
    total = 0
    for i = 0 to rows.Count() - 1
        rh = rowH
        if isT(rows[i].head)
            rh = headH
            if i > 0 then rh = rh + gapH
        end if
        hts.Push(rh)
        total = total + rh
    end for
    ' 340 wide like PlayerActivity's panel; wider only so a long row (a version
    ' description runs to "4K · HEVC HDR10 · TrueHD Atmos 7.1 · 58.2 GB") isn't
    ' cut short. The text keeps 7 + 14 in from the left and 21 from the right.
    w = 340
    for each r in rows
        if not isT(r.head) and not isT(r.ai)
            need = measure("✓ " + r.text, "R400", 14) + 42
            if need > w then w = need
        end if
    end for
    if w > 560 then w = 560
    tw = w - 42
    ' Too many rows for the screen: the list scrolls to keep the focused row in
    ' view, with a ▲ / ▼ where rows are hidden. A heading stays with its
    ' section's first row.
    inner = 540 - 2 - 20
    arrowH = 0
    top = 0
    if total > inner
        arrowH = tvLineH(11)
        inner = inner - 2 * arrowH
        top = pl.menuTop
        sel = pl.menuSel - 1
        if sel < top then top = sel
        if top = sel and top > 0 and isT(rows[top - 1].head) then top = top - 1
        used = 0
        for i = top to sel
            used = used + hts[i]
        end for
        while used > inner and top < sel
            used = used - hts[top]
            top = top + 1
        end while
        h = 540
    else
        h = 10 + total + 10 + 2
    end if
    pl.menuTop = top
    x = 960 - 30 - w
    y = (540 - h) / 2
    uiRect(g, x, y, w, h, "0x1D1D20F6")
    uiFrame(g, x, y, w, h, 1, m.pc.rule)
    arrowSt = { v: "R400", s: 11, c: m.pc.ink3, lh: arrowH, w: w, align: "center" }
    if top > 0 then uiText(g, "▲", arrowSt, x, y + 1 + 10)
    ry = y + 1 + 10 + arrowH
    bottom = ry + inner
    if arrowH = 0 then bottom = ry + total
    last = top - 1
    for i = top to rows.Count() - 1
        if ry + hts[i] > bottom + 0.5 then exit for
        r = rows[i]
        if isT(r.head)
            ty = ry
            if i > 0
                uiRect(g, x + 7, ry + gapH / 2, w - 14, 1, m.pc.rule)
                ty = ry + gapH
            end if
            uiText(g, r.text, { v: "R700t24", s: 11, c: m.pc.ink3, lh: tvLineH(11) }, x + 1 + 6 + 14, ty + 8)
        else
            on = (i + 1 = pl.menuSel)
            if on then uiRect(g, x + 7, ry, w - 14, rowH, m.pc.panel2)
            ink = m.pc.ink2
            if on then ink = m.pc.signal
            t = r.text
            if isT(r.on) then t = "✓ " + t
            st = { v: "R400", s: 14, c: ink, lh: tvLineH(14) }
            if isT(r.ai)
                parts = [{ e: "2728" }, Mid(t, 2)]
                uiRich(g, parts, st, x + 7 + 14, ry + 11)
            else
                uiText(g, t, { v: "R400", s: 14, c: ink, lh: tvLineH(14), w: tw }, x + 7 + 14, ry + 11)
            end if
        end if
        last = i
        ry = ry + hts[i]
    end for
    if last < rows.Count() - 1 then uiText(g, "▼", arrowSt, x, y + h - 1 - 10 - arrowH)
end sub

' Up/Down step over the headings.
sub playerMenuMove(dir as integer)
    pl = m.pl
    rows = pl.menuRows
    i = pl.menuSel + dir
    while i >= 1 and i <= rows.Count() and isT(rows[i - 1].head)
        i = i + dir
    end while
    if i >= 1 and i <= rows.Count() then pl.menuSel = i
    playerRenderMenu()
end sub

sub playerMenuClick()
    pl = m.pl
    r = pl.menuRows[pl.menuSel - 1]
    if r = invalid or isT(r.head) then return
    if isT(r.ai)
        playerStartAiSubs()
    else if r.kind = "aud"
        playerSelectAudio(r.idx)
    else if r.kind = "ver"
        playerSelectVersion(r.fileId)
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
    ' Pre-roll, and the moment spent waiting on the soundtrack pick: locked.
    ' Back still exits everything.
    if pl.inPreroll or pl.audWaiting
        if key = "back" then playerFinish(false, false, false)
        return true
    end if
    if pl.menuOpen
        if key = "back"
            playerCloseMenu()
        else if key = "up"
            playerMenuMove(-1)
        else if key = "down"
            playerMenuMove(1)
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
        m.video.unobserveField("availableAudioTracks")
    end if
    clearChildren(m.playerG)
    m.video = invalid
    m.plHint = invalid
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
