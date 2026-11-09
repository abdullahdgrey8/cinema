# Playable search and source browsing

Cinema should offer a usable source after finding a title. Boston Legal exposed the gap between finding a show in the catalog and finding a release that contains the selected episode.

## Acceptance

1. Ordinary title and episode searches ask every enabled qBittorrent plugin. Explicit plugin searches and native categories keep their scope. The app reports coverage and preserves usable results when an individual query is interrupted.
2. For a series, prefer an exact episode that has a reasonable chance of streaming. Include relevant season and explicit multi-season or complete-series packs as fallback. A pack label is a search hint. The chosen video must match the actual episode in the torrent before playback. Other episodes and ambiguous file matches keep their existing safeguards.
3. Offer a clear Play best source action for an eligible candidate. Prefer positive swarm evidence, a practical playback format and release size, and reuse of suitable local copies. Report unknown or low availability honestly and retain manual choices. One explicit Play action starts at most one add.
4. Sources automatically shows all installed plugins with enabled status. Open a plugin to browse its suggested titles and categories without entering a search. From each title, open the full returned release list for that plugin. Show the reported seeds, peers, size, quality and source details. Explain the difference between a native provider catalog and searches Cinema builds for a search-only plugin.

## Verification

Use bounded, isolated fixtures to prove all-enabled versus explicit-plugin routing, release rejection, partial results, duplicate handling, pack coverage and exact episode-file selection, stable source activation and release details. Compare with a read-only live Boston Legal search and verify native player behavior on synthetic content. Keep user downloads and plugin settings intact.
