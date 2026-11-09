# Scene Relay and playback continuity

Cinema may play the same movie from releases with different opening logos, scene trims, or subtitle timing. A timestamp belongs to a file. A scene pin should follow the dialogue when a reliable match exists.

## Acceptance

1. A viewer can pin the moment they are watching with a loaded subtitle track. Cinema keeps the pin on this device and reopens it on the same file. It can relocate the pin on another verified release of the same movie or episode using the cue and neighboring dialogue. An ambiguous match, unknown title identity, or an unavailable part of the video must leave playback in place.
2. A viewer can search dialogue in the loaded track and replay a recent line. Matching uses the adjusted subtitle times. Activation checks the current file and seek range again. Keyboard navigation, reduced motion, and accessible empty and loading states apply.
3. The episode guide identifies watched, in-progress, and next aired episodes from verified local history. A guide action may offer the existing watch options. It requires an explicit Play action to add a release. Older history with uncertain episode identity is left unmarked.
4. Test the matching seam with a shifted cut, repeated dialogue, unavailable data, and title boundaries. Verify scene search, keyboard navigation, and episode recommendations in the actual Windows interface. Run the affected checks and full suite, review the current candidate independently, then release locally.
5. The playback map shows the actual movie duration when known and distinguishes ready ranges from the rest. While duration is unknown it shows available time without inventing a percentage. A waiting pin can be followed until its matched range is ready. The jump remains an explicit action.

## Scope

- Store a bounded set of user-created pins locally. Keep a short normalized dialogue fingerprint and its original position. Titles and subtitle files already use their existing storage and lookup paths.
- Use an exact movie title and release year, or a verified episode identity, to match across files. Older or unclassified releases may still support a file-specific pin. A name match alone is insufficient across releases.
- Scene operations share the same verified seek boundary as playback. A matched cue outside that range remains unavailable until the player can seek there.
- The implementation has three disjoint slices. Dialogue search provides the loaded-cue and safe-seek interface. Scene Relay depends on that interface for integration, while matching and local persistence can be tested independently. Series history is independent except for its recording seam in the player. Local review and Windows verification depend on the three slices.

## Playback and matching boundaries

- One verified-range model drives the map and interactive seek checks. A partial direct stream uses the media element's buffered ranges. HLS combines the active manifest ranges with the media element's seekable ranges and includes ranges already buffered. A completed direct file uses media seekable ranges. An advertised duration or download percentage alone proves no time range. Ignore stale generations and refuse seeks before metadata or during a resume choice or failure. Recheck on activation, preserve pause state, and confirm the actual landing before reporting success. Keep the existing resume startup path working before metadata is available.
- Portable movie identity requires the exact normalized name and year from the selected video file to agree with remembered catalog metadata. Portable episode identity requires a server-verified single-episode file and exact show and episode IDs. A compound episode file or manually selected unverified file is file-specific. Scene actions bind to the current file, playback generation, and subtitle revision.
- Match a sufficiently distinctive normalized phrase with at least one independent neighboring phrase in order and near the same candidate. Cues may be split across adjacent lines. Ignore markup and non-dialogue bracket tags, require adjusted subtitle timing, and reject an equally supported or weak result. A silent or uncertain pin remains file-specific. With the current subtitle path, the first portable version assumes equivalent dialogue in the target track.
- Keep at most 120 explicit pins in a versioned local store. Offer deletion and surface a full store or a failed write. A waiting-scene selection lasts for the open watch session. No dialogue is transmitted for local scene search, pinning, or matching.
- Episode history records a verified episode only for its matched file. A finished record may mark an episode watched after the torrent leaves the library. A local Resume action requires a present torrent. Next follows aired numbered catalog order, offers a known file or opens watch options, and requires explicit Play to add a release.
- The map and scene panels are keyboard accessible with 44px controls and reduced motion. QA covers a known shifted pair, missing and repeated dialogue, a mismatched title, a blocked partial seek, native keyboard navigation, and the episode states. Synthetic media can verify the mechanics. Cold real-world performance and broad subtitle/cut matching require separate measurements.

The active product goal covers wider Cinema functionality and experience. This specification describes the current delivery round.
