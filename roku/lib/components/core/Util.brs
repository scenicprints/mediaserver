' ============================================================
'  Small helpers shared by every screen.
' ============================================================

function regRead(key as string, fallback = "" as string) as string
    sec = CreateObject("roRegistrySection", "Marquee")
    if sec.Exists(key) then return sec.Read(key)
    return fallback
end function

sub regWrite(key as string, value as dynamic)
    sec = CreateObject("roRegistrySection", "Marquee")
    if value = invalid or value = ""
        sec.Delete(key)
    else
        sec.Write(key, value)
    end if
    sec.Flush()
end sub

function nowSec() as integer
    dt = CreateObject("roDateTime")
    return dt.AsSeconds()
end function

function nowMs() as double
    dt = CreateObject("roDateTime")
    return dt.AsSeconds() * 1000# + dt.GetMilliseconds()
end function

' The viewer's local date as YYYY-MM-DD (the browser's `new Date()`).
function localYmd() as string
    dt = CreateObject("roDateTime")
    dt.ToLocalTime()
    return dt.GetYear().ToStr() + "-" + pad2(dt.GetMonth()) + "-" + pad2(dt.GetDayOfMonth())
end function

function pad2(n as integer) as string
    if n < 10 then return "0" + n.ToStr()
    return n.ToStr()
end function

function istr(n as dynamic) as string
    if n = invalid then return ""
    if type(n) = "roString" or type(n) = "String" then return n
    return Str(Int(n)).Trim()
end function

' toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) in en-US: "9:30 PM".
function clockTime(sec as integer) as string
    dt = CreateObject("roDateTime")
    dt.FromSeconds(sec)
    dt.ToLocalTime()
    h = dt.GetHours()
    ampm = "AM"
    if h >= 12 then ampm = "PM"
    h = h mod 12
    if h = 0 then h = 12
    return h.ToStr() + ":" + pad2(dt.GetMinutes()) + " " + ampm
end function

' app.js fmtTime: h:mm:ss or m:ss.
function fmtTime(t as dynamic) as string
    if t = invalid then t = 0
    t = Int(t)
    if t < 0 then t = 0
    h = t \ 3600
    mm = (t mod 3600) \ 60
    s = t mod 60
    if h > 0 then return h.ToStr() + ":" + pad2(mm) + ":" + pad2(s)
    return mm.ToStr() + ":" + pad2(s)
end function

' String(n).padStart(2, '0').
function padEp(n as dynamic) as string
    if n = invalid then return "00"
    return pad2(Int(n))
end function

' encodeURIComponent.
function enc(s as dynamic) as string
    if s = invalid then return ""
    s = istr(s)
    ba = CreateObject("roByteArray")
    ba.FromAsciiString(s)
    safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    out = ""
    for i = 0 to ba.Count() - 1
        b = ba[i]
        ch = Chr(b)
        if b < 128 and Instr(1, safe, ch) > 0
            out = out + ch
        else
            out = out + "%" + hexByte(b)
        end if
    end for
    return out
end function

function aaGet(aa as dynamic, key as string, fallback = invalid as dynamic) as dynamic
    if aa = invalid or type(aa) <> "roAssociativeArray" then return fallback
    v = aa[key]
    if v = invalid then return fallback
    return v
end function

function str0(v as dynamic) as string
    if v = invalid then return ""
    t = type(v)
    if t = "roString" or t = "String" then return v
    if t = "roInt" or t = "Integer" or t = "roInteger" or t = "LongInteger" then return v.ToStr()
    if t = "roFloat" or t = "Float" or t = "roDouble" or t = "Double"
        if v = Int(v) then return Str(Int(v)).Trim()
        return Str(v).Trim()
    end if
    if t = "roBoolean" or t = "Boolean"
        if v then return "true"
        return "false"
    end if
    return ""
end function

function num(v as dynamic, fallback = 0 as dynamic) as dynamic
    if v = invalid then return fallback
    t = type(v)
    if t = "roString" or t = "String"
        if v = "" then return fallback
        return Val(v)
    end if
    if t = "roBoolean" or t = "Boolean"
        if v then return 1
        return 0
    end if
    return v
end function

function truthy(v as dynamic) as boolean
    if v = invalid then return false
    t = type(v)
    if t = "roBoolean" or t = "Boolean" then return v
    if t = "roString" or t = "String" then return v <> "" and v <> "0"
    return v <> 0
end function

' One decimal, as Number.toFixed(1).
function fixed1(v as dynamic) as string
    x = num(v, 0)
    n = Int(x * 10 + 0.5)
    return (n \ 10).ToStr() + "." + (n mod 10).ToStr()
end function

function fixed2(v as dynamic) as string
    x = num(v, 0)
    neg = x < 0
    if neg then x = -x
    n = Int(x * 100 + 0.5)
    out = (n \ 100).ToStr() + "." + pad2(n mod 100)
    if neg then out = "-" + out
    return out
end function

function uc(s as dynamic) as string
    if s = invalid then return ""
    return UCase(s)
end function

function joinArr(arr as object, sep as string) as string
    out = ""
    for i = 0 to arr.Count() - 1
        if i > 0 then out = out + sep
        out = out + arr[i]
    end for
    return out
end function

function clamp(v as dynamic, lo as dynamic, hi as dynamic) as dynamic
    if v < lo then return lo
    if v > hi then return hi
    return v
end function

function maxf(a as dynamic, b as dynamic) as dynamic
    if a > b then return a
    return b
end function

function minf(a as dynamic, b as dynamic) as dynamic
    if a < b then return a
    return b
end function

function absf(a as dynamic) as dynamic
    if a < 0 then return -a
    return a
end function

function newUuid() as string
    di = CreateObject("roDeviceInfo")
    return di.GetRandomUUID()
end function

' A flag that may be unset: true only for a real boolean true.
function isT(v as dynamic) as boolean
    if v = invalid then return false
    t = type(v)
    if t = "roBoolean" or t = "Boolean" then return v
    return false
end function

' One of this library's own components. Inside a component library the bare
' name resolves on a Roku; some runtimes want the library prefix, so try both.
function newNode(name as string) as object
    n = CreateObject("roSGNode", name)
    if n = invalid then n = CreateObject("roSGNode", "MarqueeLib:" + name)
    return n
end function
