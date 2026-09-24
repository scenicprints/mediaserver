# Installing Marquee on a Roku

You only do this once per Roku. After this, both the app and the shell update over the
air from the server, and nobody has to touch the TV again.

**Before you go:** the Dell must be running a build that has `src/roku.js`. Check it from
anywhere by opening `https://marqu33.duckdns.org/roku/version.json`. It should show
something like `{"lib":"…","shell":1}`.

**Bring:** a laptop (a phone works, but a laptop is easier) on the **same Wi-Fi as the
Roku**, and the Roku remote.

## 1. Download the shell

1. On the laptop, open `https://marqu33.duckdns.org/roku/shell.zip` and save the file.
   Keep it zipped.

## 2. Turn on Developer Mode

1. On the Roku remote, press **Home ×3, Up ×2, Right, Left, Right, Left, Right**.
2. The Developer Settings screen shows the Roku's IP address (for example
   `http://192.168.1.50`). Write it down.
3. Choose **Enable installer and restart**, then accept the SDK license.
4. Set the webserver password to **`marquee`**. It must be exactly this: the shell
   uses it to update itself (it is `dev_password` in `roku/shell/manifest`).
5. The Roku restarts.

## 3. Install the shell

1. On the laptop, open the IP address from step 2.2 in a browser.
2. Sign in as user **`rokudev`** with the password **`marquee`**.
3. Click **Upload**, pick `shell.zip`, then click **Install with zip**.
4. The Roku launches Marquee. You should see the MARQUEE splash, then the sign-in card.
   If it says it can't reach the server, check the Roku's internet connection. It
   retries by itself every 5 seconds.

## 4. Sign in and check it

1. Sign in with the viewer's account.
2. Play a movie, a TV episode, and a Live TV channel. Turn subtitles on and off.
3. Open a streaming title (Netflix etc.). It should open that service and land on the
   title. If it only opens the app, say so: the search deep-link needs a different form.
4. Open **Settings**. The version at the bottom should match the one on the TCL.

Anything that goes wrong shows up on the desktop under **Settings ▸ Diagnostics**. Every
Roku reports there with model and version.

## 5. Test a shell update (do this on install day)

A shell update has never been tested on a real Roku. So test it while you're there:

1. On the desktop, raise `build_version` in `roku/shell/manifest` by one (for example 2 → 3), push,
   and run Update on the Dell.
2. On the Roku, press Home and launch Marquee again.
3. Within a few seconds the Roku should reinstall Marquee and relaunch it by itself.
4. In **Diagnostics**, look for `shell-update` events. They log each step: downloading,
   uploading to the installer, and what the installer answered.

If it fails, the Roku keeps working on the old shell. Paste the `shell-update` events to
Claude.

## Good to know

- Developer Mode stays on after restarts. The sideloaded Marquee stays installed.
- A Roku holds only **one** sideloaded channel. Installing another one replaces Marquee.
- Turning Developer Mode off, or a factory reset, removes Marquee. Then repeat this
  guide.
- Once a viewer has signed in, the Roku also knows the Dell's address on the home Wi-Fi.
  If the internet goes down but the Dell is up, Marquee still starts and plays from it.
- App changes need nothing on the Roku: push, run Update on the Dell, and every Roku
  has the new app the next time it's launched.
