# Download location

The main Cinema Windows app can save a local destination for newly submitted torrents. Settings shows whether Cinema uses a custom folder or lets qBittorrent decide. The separately paired Scene Preview app shows its dedicated folder and keeps the profile's storage boundary.

## Acceptance

1. In Settings, enter an existing absolute local folder or use the Windows folder picker. Choosing a folder edits the draft. Save commits after verifying the folder is writable. Canceling the picker or closing Settings without saving leaves the committed choice as it was. A browser can enter a path. A rejected path keeps the draft and explains the error.
2. The choice survives reopening, a service restart and reconnecting to qBittorrent. Use qBittorrent default restores the usual category and temporary-folder behavior for new downloads. A custom-folder add carries its exact save path, manual torrent management and no separate incomplete folder. Cinema never changes global qBittorrent preferences or moves existing files.
3. An explicit retry uses its original custom destination. A disappeared or redirected custom folder stops an add before submission and never falls back to another location. Duplicate detection keeps the original torrent and its destination. Preexisting operations without a stored override retain their original qBittorrent routing behavior.
4. The local API uses the existing Host, Origin and mutation-token checks. The native picker accepts a single request from Cinema's top-level local page, binds its answer to the same document, and never applies a path. Scene Preview's existing storage ownership and delete checks remain intact.

## Verification

Exercise selection, cancellation, saving, reset and the read-only profile in the real Windows window where applicable. Test requests against isolated qBittorrent or its fixture, including folder validation, retry, restart, reconnect and duplicate handling. Inspect the production profile identities and existing torrent paths without adding or changing a user's download.
