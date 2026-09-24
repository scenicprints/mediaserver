sub init()
    m.top.functionName = "httpRun"
end sub

sub httpRun()
    port = CreateObject("roMessagePort")
    xfer = CreateObject("roUrlTransfer")
    xfer.SetMessagePort(port)
    url = m.top.url
    xfer.SetUrl(url)
    if LCase(Left(url, 5)) = "https"
        xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
        xfer.InitClientCertificates()
    end if
    xfer.EnableEncodings(true)
    xfer.RetainBodyOnError(true)
    if m.top.token <> "" then xfer.AddHeader("Authorization", "Bearer " + m.top.token)
    if m.top.digestUser <> ""
        xfer.SetUserAndPassword(m.top.digestUser, m.top.digestPass)
        xfer.EnableFreshConnection(true)
    end if
    method = UCase(m.top.method)
    ok = false
    if m.top.uploadFile <> ""
        ok = startUpload(xfer)
    else if m.top.outFile <> ""
        ok = xfer.AsyncGetToFile(m.top.outFile)
    else if method = "GET"
        ok = xfer.AsyncGetToString()
    else
        xfer.SetRequest(method)
        xfer.AddHeader("Content-Type", "application/json")
        body = m.top.body
        if body = "" then body = "{}"
        ok = xfer.AsyncPostFromString(body)
    end if
    if not ok
        m.top.result = { code: 0, data: invalid, text: "", error: "could not start" }
        return
    end if
    msg = wait(m.top.timeoutMs, port)
    if type(msg) <> "roUrlEvent"
        xfer.AsyncCancel()
        m.top.result = { code: 0, data: invalid, text: "", error: "timeout" }
        return
    end if
    code = msg.GetResponseCode()
    text = msg.GetString()
    data = invalid
    if not m.top.raw and text <> "" then data = ParseJson(text)
    err = ""
    if code <= 0 then err = msg.GetFailureReason()
    ' A failed transfer reports a negative curl code; every caller reads 0 as
    ' "no HTTP answer" (can't reach the server), so that is what it gets.
    if code < 0 then code = 0
    m.top.result = { code: code, data: data, text: text, error: err }
end sub

' multipart/form-data POST of a zip, the way the Roku developer installer page
' submits it (fields mysubmit + archive).
function startUpload(xfer as object) as boolean
    boundary = "----MarqueeShell" + CreateObject("roDeviceInfo").GetRandomUUID()
    body = CreateObject("roByteArray")
    head = "--" + boundary + Chr(13) + Chr(10)
    head = head + "Content-Disposition: form-data; name=""mysubmit""" + Chr(13) + Chr(10) + Chr(13) + Chr(10)
    head = head + "Replace" + Chr(13) + Chr(10)
    head = head + "--" + boundary + Chr(13) + Chr(10)
    head = head + "Content-Disposition: form-data; name=""archive""; filename=""marquee-shell.zip""" + Chr(13) + Chr(10)
    head = head + "Content-Type: application/zip" + Chr(13) + Chr(10) + Chr(13) + Chr(10)
    body.FromAsciiString(head)
    zip = CreateObject("roByteArray")
    if not zip.ReadFile(m.top.uploadFile) then return false
    body.Append(zip)
    tail = CreateObject("roByteArray")
    tail.FromAsciiString(Chr(13) + Chr(10) + "--" + boundary + "--" + Chr(13) + Chr(10))
    body.Append(tail)
    tmp = "tmp:/marquee-shell-upload.bin"
    body.WriteFile(tmp)
    xfer.AddHeader("Content-Type", "multipart/form-data; boundary=" + boundary)
    return xfer.AsyncPostFromFile(tmp)
end function
