<p align="center">
  <img src="docs/images/cinema-banner.svg" alt="Cinema, a local player for qBittorrent" width="1200">
</p>

<p align="center">
  <a href="https://github.com/abdullahdgrey8/cinema/releases/latest/download/Cinema-Setup-x64.exe"><img src="https://img.shields.io/badge/Download%20for%20Windows-x64-D93656?style=for-the-badge" alt="Download Cinema Setup for Windows x64"></a>
</p>

<p align="center">
  <a href="#install-on-windows"><strong>Install on Windows</strong></a> ·
  <a href="#browse-your-plugins">Browse plugins</a> ·
  <a href="#watch-while-downloading">Playback</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

# Cinema

**A Windows desktop app for browsing your qBittorrent sources and watching video as it downloads.** Explore movies, series, Korean dramas and anime, choose a release, and keep what you download in your library. The Windows window and the optional browser interface use the same local service.

| Discover | Choose a source | Watch |
| --- | --- | --- |
| Browse poster-led shelves, explore installed plugins, and look up seasons and episodes. | Check reported seeders, leechers, size and format. Use **Play best source** or compare releases yourself. | Play from verified downloaded pieces, see which parts of the timeline are ready, and add or adjust subtitles. |

## Install on Windows

1. [Download Cinema Setup for Windows x64](https://github.com/abdullahdgrey8/cinema/releases/latest/download/Cinema-Setup-x64.exe). Double-click it on a Windows 10 version 1809 or later or a Windows 11 x64 PC, then select **Install**.
2. Cinema opens in its own window. For later launches, use **Cinema Player** on your desktop or in the Start menu.
3. Search for **Big Buck Bunny** to try the bundled **Cinema Open Films** source. Open **… → Source plugins** to see it alongside **Cinema Ubuntu Torrents**, which serves official Ubuntu downloads.

Setup includes Node.js, Python, and the two starter search plugins. During installation it downloads and verifies qBittorrent, FFmpeg, and ffprobe and installs Microsoft's WebView2 Runtime if needed. Cinema starts its own qBittorrent instance with a private profile and sets up the connection automatically. Keep an internet connection available during setup. The installer is unsigned, so Windows may show a publisher prompt.

Change where new downloads go under **Settings → Download location**. Setup keeps your private profile outside the program folder at `%LOCALAPPDATA%\Cinema\Installed`, and removing the app through **Settings → Apps** leaves that profile and your downloads in place.

### Build the installer

Run the installer build script from the repository folder in PowerShell on Windows x64.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\desktop\Build-Installer.ps1 -Online
```

The build verifies pinned dependencies and the Microsoft bootstrapper's signature and prints the SHA-256 of `.local\installer\Cinema-Setup-x64.exe`. The installer records component URLs and hashes in `dependency-provenance.json` and retains the accompanying license notices.

To make a private installer with your own reviewed, stateless qBittorrent search engines, pass `-SearchPluginDirectory` with their folder of `.py` files and a separate `-OutputDirectory`.

## Build from source

### 1. Install the prerequisites

| Install | When you need it |
| --- | --- |
| [Git](https://git-scm.com/downloads/win) | To clone the repository. GitHub’s **Code → Download ZIP** also works. |
| [Node.js](https://nodejs.org/en/download) | Install a current LTS release, Node 22.1 or newer. Use the standard Windows installer for the desktop launcher. |
| [qBittorrent 5.x](https://www.qbittorrent.org/download) | Runs the transfers and search plugins on the same PC. |
| [WebView2 Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section) | Required for the Windows x64 desktop window. |
| [Python 3](https://www.python.org/downloads/windows/) | Required when you use qBittorrent search plugins. |

### 2. Enable the qBittorrent Web UI

1. Open qBittorrent and go to **Tools → Options → Web UI**.
2. Enable **Web User Interface (Remote control)**.
3. Set **IP address** to `127.0.0.1` and **Port** to `8080`.
4. Set a Web UI username and a strong password. Keep authentication enabled, including for localhost, then apply the settings.
5. Keep qBittorrent running. You can check the connection by opening [the qBittorrent Web UI](http://127.0.0.1:8080/) on the same PC.

If you already use a different port, enter that same port in Cinema. [qBittorrent Web UI documentation](https://github.com/qbittorrent/qBittorrent/wiki/Explanation-of-Options-in-qBittorrent#web-ui)

### 3. Get the app

Run these commands in PowerShell. If you downloaded the ZIP, extract it, open PowerShell in the extracted folder, and start at `npm.cmd ci`.

```powershell
git clone https://github.com/abdullahdgrey8/cinema.git
cd cinema
npm.cmd ci
```

### 4. Open Cinema

**Windows desktop** · Build the desktop window and launch it from the project folder.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\desktop\Build.ps1
& .\.local\desktop\Cinema.exe (Get-Location).Path
```

The first build downloads the pinned WebView2 SDK. The desktop window starts or reuses Cinema’s local service. If you installed qBittorrent in a custom location, open it before opening Cinema.

<details>
<summary>Optional desktop shortcut</summary>

Run this from the project folder after building.

```powershell
$cinemaRoot = (Get-Location).Path
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $desktop 'Cinema.lnk'))
$shortcut.TargetPath = Join-Path $cinemaRoot '.local\desktop\Cinema.exe'
$shortcut.Arguments = '"' + $cinemaRoot + '"'
$shortcut.WorkingDirectory = $cinemaRoot
$shortcut.IconLocation = $shortcut.TargetPath + ',0'
$shortcut.Save()
```

</details>

**Browser** · For a quick start or development, run the server and open [Cinema at 127.0.0.1:3210](http://127.0.0.1:3210/).

```powershell
npm.cmd start
```

### 5. Connect and check your library

1. In Cinema, open **… → Settings**.
2. Enter `http://127.0.0.1:8080` and the Web UI credentials you set in step 2.
3. Select **Connect to qBittorrent**.
4. Open **My Library** to see your existing torrents. Use **… → Downloads** to follow transfers.

The regular desktop setup uses stock qBittorrent. The optional Scene Preview companion is a separate advanced profile that requires its own compatible runtime bundle. [Companion setup details](docs/specs/windows-scene-companion.md)

## Browse your plugins

1. The Windows installer includes two starter sources. If you build from source, turn on **View → Search Engine** in qBittorrent and use **Search → Search plugins** to add providers. [qBittorrent plugin setup guide](https://github.com/qbittorrent/search-plugins/wiki/Install-search-plugins)
2. In Cinema, open **… → Source plugins**. The list shows every installed plugin and its enabled status. Choose **Refresh plugins** after changes in qBittorrent.
3. Select **Browse plugin** on an enabled provider. Change **Category** and **Popularity period** to explore suggestions without typing a query.
4. Open a suggestion’s release details to see the reported seeders, leechers, size and available format information. **Search all releases from this plugin** opens the provider’s returned results for that suggestion.
5. Use **Search** or `Ctrl+K` for any title. Ordinary title searches check all enabled plugins. The **Source** filter lets you choose one provider.

The Plugin Guide builds suggested searches from charts and topics. Each provider supplies its own results, and availability can vary by title, region and plugin configuration.

## Watch while downloading

- **Movies** · Open a title, then choose **Play best source** when Cinema finds a suitable result, or open **Watch options** to compare releases.
- **Series and anime** · Use **Start watching** for your next episode or **Episodes** to pick one. Cinema can look in season and series packs and verifies the selected episode against the torrent’s file list before automatically opening a file.
- **Player controls** · Seek within the available parts of the timeline, jump ten seconds, adjust volume, change speed from 0.5× to 2×, or open fullscreen. Picture-in-picture appears where the browser engine supports it.
- **Playback map** · Open it in the player to inspect which parts are ready. A source can start before its full download finishes once the needed opening pieces and format information are available.
- **Subtitles** · Open **Subtitles** in the player to search available English captions, import SRT, VTT, ASS or SSA, and adjust the timing.
- **Storage** · Open **Settings → Download location** to choose where new downloads go. **Playback cache** manages prepared copies separately. Closing the player lets qBittorrent continue its transfer.

Compatible files can play directly. Other formats can use prepared HLS segments. Startup and seeking depend on the actual pieces available, the source and your machine.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Installed Cinema says the downloader is offline | Retry from the startup screen. If a bundled component is missing, run `Cinema-Setup-x64.exe` again. |
| Source build says qBittorrent is offline | Open qBittorrent, confirm that its Web UI is enabled, and check the exact address and credentials in Cinema. |
| Sources is empty or a plugin returns no results | Check Python and the plugin’s enabled state in qBittorrent. Try the same title in qBittorrent’s Search tab, then use **Refresh plugins** in Cinema. |
| A title appears without a playable source | Browse **Watch options** or search for another release. Catalog entries and torrent availability are separate. |
| A download has progress but the player is still preparing | Open **Playback map** and check the opening buffer. The total download percentage can be ahead of the pieces the player needs. |
| The desktop window fails to open | Check the WebView2 Runtime and standard Node.js install. Try the browser route to separate a local service issue from a desktop build issue. |
| `npm.ps1` is blocked by PowerShell | Use the `npm.cmd` commands in this guide. |

## Project notes

Cinema binds its service to loopback. Installed copies keep their data under `%LOCALAPPDATA%\Cinema\Installed`. Source builds keep the qBittorrent connection and prepared files under `.local/`. Cinema queries the configured providers for search, metadata, artwork and subtitles.

The app is built with Node.js, the qBittorrent Web API, FFmpeg, hls.js and a Windows WebView2 host. The tests use isolated profiles and synthetic media.

```powershell
node --test --test-concurrency=1 test/*.test.mjs
```

See the [engineering notes](docs/engineering-decisions.md) and [innovation roadmap](docs/innovation-roadmap.md) for more about the player and discovery design.

If Cinema is useful to you, a GitHub star helps other people find it.
