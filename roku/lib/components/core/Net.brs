' ============================================================
'  API calls. Each request runs in its own Http task; the
'  callback gets (result, ctx) on the render thread. The web
'  app's fetch() wrapper rules apply: the session token rides
'  as a Bearer header, and a 401 from /api (outside the auth
'  endpoints) drops back to the sign-in screen.
' ============================================================

sub netInit()
    m.pending = {}
    m.reqSeq = 0
end sub

' cb is a function reference (or invalid for fire-and-forget).
function api(method as string, path as string, body as dynamic, cb as dynamic, ctx = invalid as dynamic) as object
    t = newNode("Http")
    m.reqSeq = m.reqSeq + 1
    id = "r" + m.reqSeq.ToStr()
    t.id = id
    url = path
    if Left(path, 4) <> "http" then url = m.base + path
    t.url = url
    t.method = method
    if body <> invalid
        if type(body) = "roString" or type(body) = "String"
            t.body = body
        else
            t.body = FormatJson(body)
        end if
    end if
    if m.token <> invalid then t.token = m.token
    m.pending[id] = { cb: cb, ctx: ctx, task: t, path: path, t0: nowMs() }
    if isT(m.debug) then print "[net] "; method; " "; path
    t.observeField("result", "onHttpResult")
    t.control = "RUN"
    return t
end function

sub onHttpResult(ev as object)
    t = ev.getRoSGNode()
    id = t.id
    p = m.pending[id]
    if p = invalid then return
    m.pending.Delete(id)
    res = ev.getData()
    if isT(m.debug) then print "[net] "; res.code; " "; p.path; " "; res.error
    ' Only calls to the active base say anything about whether it is still there.
    if Left(p.path, 4) <> "http" then lanNote(res.code)
    ' telemetry.js: failed / slow API calls (never the telemetry post itself).
    path = p.path
    if Left(path, 5) = "/api/" and Left(path, 14) <> "/api/telemetry"
        ms = nowMs() - p.t0
        short = path
        q = Instr(1, short, "?")
        if q > 0 then short = Left(short, q - 1)
        if res.code = 0
            tele("net", { url: short, failed: true, ms: Int(ms), msg: Left(str0(res.error), 120) })
        else if res.code >= 400 and res.code <> 401
            tele("net", { url: short, status: res.code, ms: Int(ms) })
        else if ms > 4000
            tele("net", { url: short, slow: true, ms: Int(ms) })
        end if
    end if
    if res.code = 401 and Left(path, 5) = "/api/"
        if Instr(1, path, "/api/login") = 0 and Instr(1, path, "/api/register") = 0 and Instr(1, path, "/api/auth/status") = 0
            showAuth()
        end if
    end if
    cb = p.cb
    if cb <> invalid then cb(res, p.ctx)
end sub

function apiGet(path as string, cb as dynamic, ctx = invalid as dynamic) as object
    return api("GET", path, invalid, cb, ctx)
end function

function apiPost(path as string, body as dynamic, cb = invalid as dynamic, ctx = invalid as dynamic) as object
    return api("POST", path, body, cb, ctx)
end function

' Media and art URLs can't carry a header on the Roku either; ?token= it is.
function withToken(url as string) as string
    if m.token = invalid or m.token = "" then return url
    sep = "?"
    if Instr(1, url, "?") > 0 then sep = "&"
    return url + sep + "token=" + enc(m.token)
end function

function absUrl(path as string) as string
    if Left(path, 4) = "http" then return path
    return m.base + path
end function
