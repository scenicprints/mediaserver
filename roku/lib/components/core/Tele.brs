' ============================================================
'  Flight recorder (public/telemetry.js): errors, failed/slow
'  API calls, nav, player, buffering and deep-link events,
'  batched to /api/telemetry every 7s, requeued on failure,
'  never more than 300 held. Lands in Settings > Diagnostics
'  on the desktop.
' ============================================================

sub teleInit()
    m.teleQ = []
    m.teleDevice = regRead("teleDevice", "")
    if m.teleDevice = ""
        m.teleDevice = "d" + LCase(Left(newUuid().Replace("-", ""), 8))
        regWrite("teleDevice", m.teleDevice)
    end if
    m.teleTimer = CreateObject("roSGNode", "Timer")
    m.teleTimer.duration = 7
    m.teleTimer.repeat = true
    m.teleTimer.observeField("fire", "teleFlush")
    m.teleTimer.control = "start"
end sub

sub tele(kind as string, data as dynamic)
    if m.teleQ = invalid then return
    if m.teleQ.Count() >= 300 then m.teleQ.Shift()
    if data = invalid then data = {}
    m.teleQ.Push({ ts: nowMs(), type: kind, data: data })
end sub

' telemetry.js fpsSample(): every 60s it counts requestAnimationFrame callbacks
' for a second and reports fps, how many of them arrived late, and the worst
' gap. BrightScript has no per-frame callback, so the closest honest measure is
' a repeating frame-length Timer: it is serviced by the same render loop, so a
' busy app services fewer of them, exactly as rAF does.
sub teleVitalsInit()
    m.vitTimer = CreateObject("roSGNode", "Timer")
    m.vitTimer.duration = 60
    m.vitTimer.repeat = true
    m.vitTimer.observeField("fire", "teleVitalsSample")
    m.vitTimer.control = "start"
    m.vitTick = CreateObject("roSGNode", "Timer")
    m.vitTick.duration = 0.0167
    m.vitTick.repeat = true
    m.vitTick.observeField("fire", "teleVitalsTick")
end sub

sub teleVitalsSample()
    if isT(m.playerOpen) then return          ' document.hidden: no sample
    m.vitFrames = 0
    m.vitLong = 0
    m.vitMax = 0
    m.vitT0 = nowMs()
    m.vitLast = m.vitT0
    m.vitTick.control = "start"
end sub

sub teleVitalsTick()
    t = nowMs()
    gap = t - m.vitLast
    m.vitLast = t
    m.vitFrames = m.vitFrames + 1
    ' 50ms is the web's long-task threshold.
    if gap >= 50
        m.vitLong = m.vitLong + 1
        if gap > m.vitMax then m.vitMax = gap
    end if
    el = t - m.vitT0
    if el < 1000 then return
    m.vitTick.control = "stop"
    ' The web drops a sample that overshot: a real freeze, not lag it can attribute.
    if el > 2500 then return
    tele("vitals", { fps: Int(m.vitFrames / (el / 1000.0) + 0.5), longTasks: m.vitLong, longestMs: Int(m.vitMax) })
end sub

sub teleBoot()
    di = CreateObject("roDeviceInfo")
    ai = CreateObject("roAppInfo")
    osv = di.GetOSVersion()
    ver = ""
    if osv <> invalid then ver = str0(osv.major) + "." + str0(osv.minor)
    tele("boot", {
        ua: "Roku/" + di.GetModel() + " RokuOS/" + ver + " (" + di.GetModelDisplayName() + ") Marquee",
        viewport: "960x540",
        screen: "1920x1080",
        dpr: 2,
        tv: true,
        lang: di.GetCurrentLocale(),
        appVer: m.appVersion
    })
end sub

sub teleFlush()
    if m.teleQ.Count() = 0 or m.token = invalid then return
    batch = []
    while batch.Count() < 100 and m.teleQ.Count() > 0
        batch.Push(m.teleQ.Shift())
    end while
    apiPost("/api/telemetry", { device: m.teleDevice, events: batch }, teleFlushed, batch)
end sub

sub teleFlushed(res as object, batch as object)
    if res.code >= 200 and res.code < 300 then return
    ' Put them back in front, still capped.
    merged = []
    merged.Append(batch)
    merged.Append(m.teleQ)
    while merged.Count() > 300
        merged.Pop()
    end while
    m.teleQ = merged
end sub
