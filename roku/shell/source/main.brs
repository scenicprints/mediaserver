' Marquee for Roku: the shell. It owns nothing but a screen and the address of
' the server; the app itself is downloaded from that server on every launch
' (components/ShellScene.brs), so it updates over the air.
sub Main(args as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)
    scene = screen.CreateScene("ShellScene")
    screen.show()
    if args <> invalid then scene.launchArgs = args
    input = CreateObject("roInput")
    input.SetMessagePort(port)
    while true
        msg = wait(0, port)
        t = type(msg)
        if t = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        else if t = "roInputEvent"
            if msg.IsInput() then scene.inputArgs = msg.GetInfo()
        end if
    end while
end sub
