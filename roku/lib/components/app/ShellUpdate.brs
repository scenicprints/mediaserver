' ============================================================
'  The shell updates itself over the air.
'
'  The app (this library) is fetched fresh from the server on every
'  launch. The shell is a sideloaded channel, which only the Roku's
'  own developer installer can replace. So when the server holds a
'  newer shell (its manifest build_version) the app downloads it and
'  uploads it to that installer on this Roku (127.0.0.1, digest auth
'  "rokudev" + the password set on install day, kept in the shell's
'  manifest). The installer swaps the shell and relaunches it.
'  Unverified on a real Roku until install day: every step reports
'  to Diagnostics, so the outcome is visible from the desktop.
' ============================================================

sub shellUpdateCheck(v as object)
    serverShell = num(v.shell, 0)
    running = num(m.top.shellVersion, 0)
    if serverShell <= running or running = 0 then return
    if isT(m.shellUpdating) then return
    m.shellUpdating = true
    tele("native", { type: "shell-update", stack: "server " + str0(serverShell) + " > running " + str0(running) + ": downloading" })
    t = newNode("Http")
    t.url = absUrl("/roku/shell.zip")
    t.outFile = "tmp:/marquee-shell.zip"
    t.raw = true
    t.timeoutMs = 60000
    t.observeField("result", "onShellDownloaded")
    m.shellTask = t
    t.control = "RUN"
end sub

sub onShellDownloaded(ev as object)
    res = ev.getData()
    if res.code <> 200
        tele("native", { type: "shell-update", stack: "download failed: " + str0(res.code) + " " + str0(res.error) })
        return
    end if
    ai = CreateObject("roAppInfo")
    pass = ai.GetValue("dev_password")
    if pass = "" then pass = "marquee"
    t = newNode("Http")
    t.url = "http://127.0.0.1/plugin_install"
    t.uploadFile = "tmp:/marquee-shell.zip"
    t.digestUser = "rokudev"
    t.digestPass = pass
    t.raw = true
    t.timeoutMs = 120000
    t.observeField("result", "onShellInstalled")
    m.shellTask = t
    tele("native", { type: "shell-update", stack: "uploading to the developer installer" })
    teleFlush()
    t.control = "RUN"
end sub

' On success the installer replaces this channel and relaunches it, so this
' usually never runs; when it does, the upload was refused.
sub onShellInstalled(ev as object)
    res = ev.getData()
    txt = str0(res.text)
    ok = Instr(1, txt, "Install Success") > 0 or Instr(1, txt, "Identical to previous version") > 0
    stack = "installer answered " + str0(res.code)
    if ok then stack = stack + " (install success)"
    if res.error <> "" then stack = stack + " " + res.error
    tele("native", { type: "shell-update", stack: stack })
    teleFlush()
end sub
