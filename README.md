# VidRush

**Open a video page, choose a quality, and download the video to your Windows PC.**

VidRush consists of a Chrome extension and a local companion powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). The extension provides the controls; the companion analyzes the URL and downloads the file. [FFmpeg](https://github.com/yt-dlp/FFmpeg-Builds) combines video and audio when a website provides them separately.

> **Important:** VidRush supports many websites through yt-dlp. It does **not** work on every website, and it does **not** bypass DRM. This first version downloads individual videos, not playlists or live streams. The extension interface is in Arabic; this guide is in English.

<img src="docs/popup.png" width="400" alt="VidRush's Arabic popup showing a video title, selectable quality, and download button">

*Example interface with illustrative video details and file sizes.*

## What you can do

- Analyze the video page currently open in Chrome.
- Choose from available resolutions, frame rates, and output containers.
- Download video **with audio**, including formats that require merging.
- Follow progress, cancel a download, and open the download folder.
- Close the extension popup while downloads continue. **Keep Chrome running.**

## Requirements

| Requirement | Details |
| --- | --- |
| Operating system | Windows 10 or 11, 64-bit x64 or ARM64 |
| Browser | Google Chrome 120 or newer; use a current version |
| Node.js | Version **22 or newer**, installed before setup; choose the LTS installer from [nodejs.org](https://nodejs.org/) |
| Internet | Required for setup, video analysis, and downloading |
| Disk space | Allow about 1 GB for setup and temporary extraction, plus space for your videos |

You do **not** need Python, a paid account, a server, or administrator privileges. Setup downloads yt-dlp and FFmpeg automatically and copies your existing Node.js executable into the companion folder.

## Install: step by step

### 1. Get the project

Download and extract this repository's ZIP, or clone it using Git:

```powershell
git clone https://github.com/mahmoudSaaadallah/VidRush.git
cd VidRush
```

Keep the extracted/cloned folder in a permanent location. Chrome loads the extension directly from its `extension` subfolder, so moving or deleting that folder breaks the extension.

### 2. Install Node.js

If Node.js 22 or newer is already installed, skip this step.

1. Download the **LTS** Windows installer from [nodejs.org](https://nodejs.org/).
2. Install it with the default options, including adding Node.js to `PATH`.
3. Close and reopen your terminal or File Explorer window if Node.js is not detected.

To check the version from PowerShell:

```powershell
node --version
```

The result must be `v22.x.x` or newer.

### 3. Install the companion

1. Close Chrome, particularly before reinstalling or updating VidRush.
2. In the project folder, double-click **`Install.cmd`**.
3. Wait for yt-dlp and FFmpeg to download. FFmpeg is a large download; extraction can take a minute.
4. Check that the terminal says **`Installed successfully`**. If it reports an error, setup is incomplete; see [Troubleshooting](#troubleshooting).
5. Close the installer window.

You can also run setup from PowerShell in the project folder:

```powershell
.\Install.cmd
```

Do not run this as administrator. Setup registers the companion for your current Windows account.

### 4. Load the Chrome extension

1. Open Chrome and enter `chrome://extensions` in the address bar.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the **`extension`** folder inside this project. **Do not select the project root.**
5. Open Chrome's Extensions menu (the puzzle-piece button) and pin **VidRush** for easy access.

There is no extension ID to copy or paste. A checked-in public key keeps the extension ID stable, and setup registers that ID automatically. The public key is not a secret or a signing credential.

## Download your first video

1. Open an **individual video page** on a site supported by yt-dlp. Avoid a site's home page, search results, or a playlist page.
2. Click the **VidRush** toolbar icon.
3. Wait for the connection badge to show **`متصل محليًا`** (Connected locally), then wait for analysis to finish.
4. Check the video title. Select a quality under **`جودة التحميل`** (Download quality).
5. Click **`تحميل الفيديو`** (Download video).
6. Follow the download under **`التحميلات`** (Downloads). You can close the popup; keep Chrome open.
7. When the status says **`اكتمل التحميل`** (Completed), click **`فتح المجلد`** (Open folder).

The circular-arrow button re-analyzes the current page. Use **`إلغاء`** (Cancel) beside an active download to stop it. Up to **two downloads** can run at once.

### Where files are saved

Files go into **`VidRush` inside your Windows Downloads folder**, including a Downloads folder you relocated in Windows. For a standard account this is:

```text
C:\Users\<your-user>\Downloads\VidRush
```

The installer prints the exact destination, and the extension's Open folder button opens it. Downloads are written by the companion, so they do **not** appear in Chrome's built-in download manager.

To change the destination:

1. Close Chrome so the companion stops.
2. Open `%LOCALAPPDATA%\VidRush\config.json` in a text editor.
3. Change `downloadDir` to an absolute folder path. In JSON, use double backslashes, for example `"D:\\My Videos"`.
4. Save the file and reopen Chrome.

Reinstalling preserves your existing `downloadDir` setting.

File names include the source video ID and format IDs, so different qualities of the same video can be saved separately. Downloading the same choice again does not overwrite an existing file.

### Understanding quality choices and progress

- Only qualities actually reported by the website are shown. VidRush does not upscale videos.
- Every listed choice includes audio. Silent-only options are excluded in this version.
- **MP4** is offered when a suitable source combination is available. Other combinations may produce **MKV**. VidRush does not re-encode the video to force MP4.
- An approximate size appears when the website provides enough information; otherwise no size is shown.
- Separate video and audio tracks download in sequence. The percentage can restart for the second track, then the status changes to merging. Wait for **Completed**, rather than a track reaching 100%.
- Cancelling may leave `.part` files or intermediate tracks. Files already on disk are not automatically deleted.

## Supported websites and limits

Support comes from yt-dlp's [supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) and generic extractor. Website changes, authentication, regional restrictions, and anti-bot checks can still prevent a download.

- **DRM-protected videos are unsupported.**
- Login-required, private, subscription, age-restricted, or anti-bot-protected videos may fail. This version does not import browser cookies or credentials.
- The extension sends the **page URL** to yt-dlp. It does not scan network traffic or discover every video embedded in an unrelated page.
- Playlists are not downloaded as a batch. Open the individual video's own page.
- Live streams are outside the supported workflow for this version.
- Downloads survive closing the popup, but **not closing Chrome, reloading the extension, restarting the companion, sleeping the PC indefinitely, or losing the process**. Reopen the page and retry if interrupted.
- The download list lasts for the current Chrome session. This is not a permanent download-history manager.
- The installer currently supports **Windows and Google Chrome**. Other browsers and operating systems are not configured automatically.

Use VidRush for videos you own or have permission to download.

## Update

1. Finish or cancel active downloads and close Chrome.
2. Update the project files (`git pull`, or replace the extracted project with a newer copy).
3. Run **`Install.cmd`** again. This installs current yt-dlp/FFmpeg releases and refreshes the companion and bundled Node.js executable.
4. Open `chrome://extensions` and click **Reload** on VidRush.

Updates are manual. VidRush does not run an update service in the background. To update Node.js itself, install a newer LTS version before rerunning setup.

## Uninstall

1. Close Chrome.
2. Double-click **`Uninstall.cmd`** in the project folder.
3. Open `chrome://extensions` and remove **VidRush**.
4. Delete the project folder if you no longer need it.

Uninstall removes the companion and its Chrome registration. **Downloaded videos are kept.** Node.js installed separately on your PC is also kept.

If you customized `downloadDir` to point inside the companion installation folder, the uninstaller refuses to delete it. Move your videos elsewhere and update that setting before retrying.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `node` is not recognized | Install Node.js LTS, reopen the terminal/File Explorer, and rerun `Install.cmd`. |
| Installer fails while downloading | Check your connection and access to GitHub. Retry setup. Public GitHub API rate limits can require waiting before retrying. |
| Checksum verification fails | Do not use the downloaded file. Rerun setup; an upstream release may have changed during installation. |
| Installer cannot replace a file | Close Chrome and finish any downloads, then rerun setup. A running companion can lock its files. |
| Extension says the companion is unavailable | Run `Install.cmd` under the same Windows account as Chrome. Click `إعادة الاتصال` (Reconnect) in the popup. Check that `%LOCALAPPDATA%\VidRush\config.json` exists. |
| Chrome rejects the extension folder | Select the project's `extension` folder containing `manifest.json`, rather than the whole project or a ZIP file. |
| No video or qualities found | Open the individual video page and press refresh in VidRush. Update yt-dlp by rerunning setup. The site may be unsupported or require authentication/DRM. |
| Analysis times out | Retry on the individual video's page. Analysis has a 90-second limit. Check the connection and update the companion. |
| Download fails with a site error | The original yt-dlp error appears in the download card. Update the companion. Authentication and anti-bot restrictions may still prevent downloading. |
| Quality list is old or selection expired | Press the circular-arrow button to analyze the page again. |
| Download percentage restarts | Separate audio and video tracks have their own progress. Wait until the final status is Completed. |
| No download appears in Chrome's manager | This is expected. Use VidRush's Open folder button; the companion saves files directly. |
| Files stop after closing Chrome | Keep Chrome running during downloads. Re-analyze and retry after reopening it. |
| A cancelled download left files | Remove unwanted `.part` files or intermediate tracks manually once the download has stopped. |
| An existing video is not overwritten | VidRush intentionally uses yt-dlp's no-overwrite setting. Move or rename the existing file if you want a fresh download. |

## What is installed and what data is used?

The companion is installed under **`%LOCALAPPDATA%\VidRush`**, containing:

```text
VidRush/
  bin/                    yt-dlp.exe, ffmpeg.exe, ffprobe.exe
  runtime/node.exe        copy of your installed Node.js executable
  host/                   local companion JavaScript
  host.cmd                Chrome's launcher
  config.json             local paths and extension ID
  com.vidrush.companion.json
```

Setup adds the current-user registry key:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.vidrush.companion
```

Verified release downloads are cached in `%LOCALAPPDATA%\VidRush\cache` so a retry or reinstall can reuse the same release. Reuse requires a matching SHA-256 hash. Large releases use four partial HTTP downloads where supported. Uninstall removes this cache too.

There is no local web server or listening TCP port. Chrome starts the companion using [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). The native host manifest and companion both check the extension origin.

The extension requests `activeTab`, `nativeMessaging`, and `storage`. It does not request access to all websites, browser cookies, or your browsing history. It reads the active tab's URL when you open it. The URL is passed to the local companion; yt-dlp then connects to the website/CDN. Setup connects to GitHub to download dependencies and checks SHA-256 hashes before installing them. VidRush has no analytics or remote VidRush backend.

Third-party components retain their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).

## Development and tests

Node.js 22 or newer is required. From the project root:

```powershell
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

`npm ci` installs development dependencies only; end users do not need it to run VidRush. The browser tests check the real extension loads and exercise the popup with deterministic companion responses. They do not download third-party videos.

To run an additional end-to-end native test on Windows **after installing the companion**:

```powershell
npm run test:native
```

This generates an original test video using FFmpeg, serves it on localhost, and sends real framed messages to the companion to analyze and download it with yt-dlp. Temporary files are isolated from your regular download folder.

To additionally check that Chrome can launch the **registered** native companion:

```powershell
npm run test:browser -- --native
```

This optional Windows check uses the installed companion. Keep other Chrome windows closed during this test.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the component layout and message flow.
