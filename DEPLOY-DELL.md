# Deploying the media server to the Dell

You'll copy this folder to the Dell, run one setup command, then start it.
Everything after the copy happens **on the Dell**.

## 1. Copy the project to the Dell

Copy the whole `mediaserver` folder to the Dell (a USB stick or your network
both work). Put it somewhere simple, e.g. `C:\mediaserver`.

You do **not** need to copy the `node_modules`, `data`, or `sample-media`
folders — setup rebuilds `node_modules`, and your real drives replace the
samples. (If you're using the zip I made, those are already excluded.)

## 2. Run setup (once)

On the Dell, open the copied folder, go into `deploy`, right-click
**`setup-dell.ps1`** → **Run with PowerShell**.

> If Windows blocks the script, open PowerShell **as Administrator** and run:
> `Set-ExecutionPolicy -Scope Process Bypass -Force` then `.\setup-dell.ps1`

This installs Node.js (if missing), installs dependencies, and opens the
firewall so other devices can reach it. It prints the address to use, like
`http://192.168.1.50:8096`.

## 3. Start it

Double-click **`deploy\start-server.bat`**. Leave that window open — it's the
server running.

Open the printed address (e.g. `http://192.168.1.50:8096`) in any browser on
your network — your phone, this PC, the living-room devices.

## 4. Add your movie folders (in the app)

The first time, the library is empty. In the web page:

1. Click **⚙ Folders** (top-right).
2. Click **＋ Add Movies folder**.
3. Browse to your movies drive (e.g. `H:\Movies`) and click **Use this folder**.
   Sub-folders are included automatically, so pick the top folder.
4. It scans and pulls posters in the background — hit **Rescan** if you want to
   refresh. Repeat for any other movie drives.

> TV Shows: you can add TV folders now too, but episodes won't appear until the
> TV update lands — that's the next feature.

## 5. (Optional) Start automatically

Once you're happy it works, right-click **`deploy\install-autostart.ps1`** →
Run with PowerShell. The server will then launch every time the Dell logs in.

---

## Adding, removing, or rescanning folders

All done in the web page under **⚙ Folders** — add a Movies/TV folder, or hit ✕
to remove one. Click **Rescan** anytime after dropping new movies onto your
drives; new files are picked up and existing ones are left alone.
