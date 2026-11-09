# Engineering decisions

## CIN-001 · 2026-11-08 · Accepted

Use verified title identity and nearby subtitle dialogue for portable scene pins. A pin carries its original file position for same-file replay, plus a bounded fingerprint that can be located on another release. Multiple credible matches remain unresolved. Seek authorization stays with the active player. The user delegated product choices and asked for a genuinely new streaming capability. [Current specification](specs/scene-relay.md)

## CIN-002 · 2026-11-08 · Accepted

Warm Return keeps the original playback preparation alive for 75 seconds while the viewer explicitly switches to a second, already verified local video. Both actions reuse the exact playback sessions. A completed direct file or prepared HLS copy can be a fallback. This keeps the single conversion worker available to the original title and limits how long a detached player can retain it. Returning is always explicit. A second concurrent conversion would require its own admission and resource evidence. The user delegated product and implementation choices. [Current specification](specs/warm-return.md)

## CIN-003 · 2026-11-08 · Accepted

Portable Scene Cards carry exact story identity and a bounded dialogue fingerprint. A recipient opens their own verified release and explicitly jumps only after Cinema locates the dialogue in an available range. Atlas compares tracks captured from two independently verified releases. It marks uncertainty when captions cannot support a shared span or one-track difference. This keeps private notes and source details local, and avoids treating caption differences as proof of different footage. [Current specification](specs/scene-editions.md)

## CIN-004 · 2026-11-08 · Accepted

Rescue Switch proves a selected replacement can decode before it offers a switch. It matches a last presented frame only through unique dialogue in a supported shared span. Starting over remains explicit. An in-progress direct file can be checked through verified pieces, or Cinema can reuse a completed playback copy. One bounded inspector and muted preview leave the original converter and transfers available. Search only adds a download through its explicit rescue action. [Current specification](specs/rescue-switch.md)

## CIN-005 · 2026-11-08 · Accepted

This Week stores explicit follows against canonical episode-guide identities on this device. A TVmaze row needs both an explicit airtime and a zoned timestamp before Cinema shows a local clock. Date-only records keep their provider date. Calendar metadata, an exact episode file in My Library and an existing per-file caption each require their own evidence. Opening the calendar or an episode row leaves watch-option searches idle. [Current specification](specs/follow-the-week.md)

## CIN-006 · 2026-11-08 · Accepted

Fast Start checks one existing exact alternate while the selected copy prepares normally. The alternate uses a bounded verified MP4 prefix and must decode both an opening frame and three seconds of forward progress. The original wins on its own first visible frame. A provisional alternate attachment leaves the original session and transfers eligible until the player accepts the switch. Release depends on paired visible-start measurements and early stall behavior. [Current specification](specs/first-frame-race.md)

## CIN-007 · 2026-11-08 · Accepted

Story Orbit uses TVmaze’s explicit alternate-to-original episode links. Original episode IDs remain the sole identities for history and watch actions. Split and merged entries describe each verified original, and the handoff warns that release numbering can differ. Related titles use direct Wikidata claims and exact TVmaze or film IDs. Both metadata views are loaded on request. [Current specification](specs/story-orbit.md)

## CIN-008 · 2026-11-08 · Accepted

Watched Dialogue and Catch Up use only local, opt-in evidence from continuous playback in the main player. The exact file and timeline must be provable. A caption needs its own verified content, offset and coverage inside the video witness. Reading the library keeps transfer controls idle. Opening a result and jumping to its timestamp are distinct actions. [Current specification](specs/watched-dialogue.md)

## CIN-009 · 2026-11-09 · Accepted

Plugin Guide uses current chart suggestions and the exact advertised search categories of an installed plugin. Korean drama suggestions use its TV category. Search evidence is dated and applies to the visible cards. Timed-out and failed checks stay distinct from completed searches with no seeded match. Settled shelves reuse bounded local evidence and start new searches on explicit navigation or a page recheck. [Current specification](specs/plugin-guide.md)

## CIN-010 · 2026-11-09 · Accepted

Sound Map reads authored sound labels from the exact selected captions when the viewer opens it. It uses original cue times and the chosen offset, shows cues up to the current playback position by default, and routes explicit jumps through the verified player map. Actual audio description needs an independently identified and selected audio track. [Current specification](specs/sound-map.md)

## CIN-011 · 2026-11-09 · Accepted

Two-track Studio compares the selected primary caption with a separately chosen local file. A saved pair contains only exact file and caption identities, original-content digests and the second offset. Restoring the second track requires an explicit action. A jump uses the verified player range and a span where the same two selected cues overlap. [Current specification](specs/two-track-studio.md)

## CIN-012 · 2026-11-09 · Accepted

Scene Sketchbook captures a paused picture inside an already watched, verified interval of the exact completed video. The viewer saves each still explicitly. The gallery stays in the open player and holds at most three stills. Reuse the existing frame callback and sealed playback proof. No second decoder, automatic seek, persistent screenshot or download action is needed. Recent playback may need time to enter watched history. [Current specification](specs/scene-sketchbook.md)

## CIN-013 · 2026-11-09 · Accepted

Source Memory begins with opt-in, on-device evidence for exact single-video releases. Keep preparation-to-first-picture observations separate by download condition and playback path. Store them under Windows Local AppData with restricted permissions. Correlate results only through a unique current full-alias match. Keep existing sorting and source actions while a later held-out comparison establishes whether learning can improve them. [Current specification](specs/source-memory.md)

## CIN-014 · 2026-11-09 · Accepted

Keep the player opening cover through video metadata and release it with an exact current picture, a verified paused landing, or decoded progress when a browser misses the first callback. Preserve an accessible manual Play action and honor reduced motion. Shorten incomplete H.264 copy recovery only when the current converter is waiting on an unavailable verified piece and a fresh manifest confirms the opening still lacks two published segments. The existing piece gate and slower recovery continue to govern ambiguous inputs. [Current specification](specs/playback-opening.md)

## CIN-015 · 2026-11-09 · Accepted

Use one explicit in-window watch appointment and optional exact backup. Keep the download estimate separate from any readiness claim. Detached checks can confirm a completed direct file while the player is idle and must release the probe before removing its file. Treat missed or hidden observations honestly. An exact checked file still goes through the ordinary player on explicit Play. [Current specification](specs/watch-appointment.md)

## CIN-016 · 2026-11-09 · Accepted

Audio description uses only the exact release's independently declared role. Ordinary preparation keeps the packaged probe and canonical muxed playback. An early separate read-only role check may admit one aligned AAC-LC alternate for the exact Matroska source. The same converter keeps its mandatory canonical output and uses failure-isolated audio-only outputs. The master starts on embedded Original, and explicit normal switches use URI-backed renditions to preserve the video buffer and clock. A saved description needs full backing and rendition proof. See [Audio description](specs/audio-description.md).

## CIN-017 · 2026-11-09 · Accepted for candidate verification

Preview an available late scene using a separate bounded lease, a packaged timing index and immutable full torrent pieces checked against authenticated metadata. The preview card lands at the translated moment and leaves ordinary playback and qBittorrent ownership independent. Missing pieces get an immediate status. [Current specification](specs/available-scene-preview.md)
