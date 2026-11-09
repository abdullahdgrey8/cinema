# Two-track Studio

Roadmap 26 adds paired subtitle comparison in the Windows player's existing Subtitle settings. Open Two-track Studio, select a second local caption file and adjust its timing while keeping the primary caption independent.

## Viewer controls

- A nested native disclosure contains Track 1 (Primary), Track 2 (Second), a separate file picker, second offset, Reset, Remove, Restore and Forget controls, and one quiet status. The cards show filename and generic role labels, with plain caption text and automatic text direction. Both lines are available inside Studio. The primary native caption mode and settings store remain on their existing paths.
- Load SRT, VTT, ASS or SSA through the existing local import route only on explicit file selection. Decode strict UTF-8 or BOM-marked UTF-16 LE/BE and reject input above 1 MiB. Read the normalized local track through the existing bounded detached browser VTT reader. Require a valid cue array and digest. Some malformed or incompatible converted subtitles, including an ASS cue with consecutive hard line breaks, can be rejected by this reader. No new online lookup or media request starts. A failed same-attachment replacement keeps the valid current pair.
- Show the active cue in each track at the current position. Show a missing counterpart when its track has no active cue. A newly imported second track starts at zero offset. Restore uses its saved offset. Track 2 offset accepts finite values from -120 through 120 seconds and preserves its last valid value on invalid edits. Changing either offset does not seek. A track selection alone does not play the video.

## Matching and Jump

- Read the exact current primary file, caption ID, label, element, original cue tuples, existing offset and revision from the shared read-only loaded-caption accessor. Apply both offsets exactly once to original integer millisecond times. Clip at zero and discard intervals ending at or before zero or with no remaining duration. Match active cues with half-open intervals. Both tracks prefer the latest original start, then earliest original end, then ascending Unicode code-point text. Starts clipped to zero retain original ordering. Exact duplicate cues have the same presentation.
- Each index is bounded and built once per raw snapshot. Effective spans are the intervals where a cue is selected under that ordering. Intersect the two effective spans at the current position. These spans are subsets of the original authored intervals. There is a comparison for any positive overlap. Jump is offered only for an effective overlap of at least 200 ms and targets exactly 50 ms after its start.
- A click uses fresh nonseeking `video.currentTime` and verifies the displayed pair and effective span still match, the existing playback map is ready, and the attachment and primary revision are current. A changed pair or span updates the display without seeking. Use the existing revision-bound seek. Confirm only if the exact operation is still current and actual nonseeking position sampled immediately after the promise resolves is inside the same half-open overlap. Preserve paused or playing state. Closing an already-started seek suppresses stale status and focus. It leaves the existing player seek lifecycle intact.

## Attachment, visibility and saved pairs

- Require the open player dialog, Subtitle settings, Studio details and a visible document. Listen to both details toggle events, dialog close and open-attribute changes, and document visibility. In a visible playing Studio sample with requestAnimationFrame at most once per 50 ms. Cancel the frame on hide, pause or ended. Refresh paused or boundary cases from native media events. During a seek keep the last settled position and disable Jump. Playback changes do not announce each line. Escape closes Studio and returns focus to its summary before the normal parent behavior.
- A pairing uses the exact video hash/file and selected primary caption ID. A live handle adds playback generation and URL, exact primary element and revision, and the current secondary selection and offset revision. Cancel stale imports, parses and jumps across track, timing, attachment or visibility changes. Use operation identity and AbortSignal.aborted before and after each await. Pass the signal as the fourth argument of the existing app API wrapper. Never infer an abort from its error name.
- A timing-only primary change on the same loaded element preserves the loaded second track and its offset. A new attachment, primary ID or element drops the active pair and offers Restore for a separately saved exact pair. Closing and reopening Studio within the same attachment may reuse its loaded pair. An already imported file from an abandoned or rejected selection can remain in local subtitle storage. Remove clears the active second track and keeps the saved pair available for Restore. Forget removes the preference record and keeps the caption file. When an active pair is forgotten, subsequent timing changes do not silently save it again.
- Store at most 32 validated pairings under `cinema-two-track-v1` in at most 24 KiB serialized UTF-8. Each record holds the exact video file key, both local caption IDs, both original-content digests, a filename limited to 60 Unicode code points and the second integer offset. Store no caption text. Preserve recency order and ignore corrupt entries. Storage failures do not invalidate an active comparison. Save after successful import and parse and when changing the second offset of a saved pairing. Restore explicitly rereads and verifies both original-content digests. Reject identical verified digests. The primary digest uses existing original cue tuples without calling Watched Dialogue state. Report a digest mismatch as changed. Otherwise describe an unavailable native result as unreadable or over the 1 MiB read limit. The shared reader is unchanged.

## Delivery and verification

The owned release paths are:

- `docs/specs/two-track-studio.md`
- `docs/engineering-decisions.md`
- `package.json`
- `package-lock.json`
- `server.mjs`
- `public/index.html`
- `public/app.js`
- `public/enrichment.js`
- `public/two-track-model.js`
- `public/two-track-studio.js`
- `public/two-track-studio.css`
- `test/two-track-model.test.mjs`
- `test/player.test.mjs`
- `test/two-track-studio.test.mjs`

- Public tests exercise the decoder and bounds, corrupt or oversized preferences, independent offsets, half-open cue selection, exact winning spans and overlap seek. Component tests exercise parent hide with the nested flag still open, restore, stale and failed imports, playing and paused positions, short and expired overlap, and quiet current status. Player tests retain the existing unavailable HLS and stale primary revision guard.
- Headless Edge and isolated Windows WebView2 use a synthetic bilingual caption fixture. Verify valid and invalid encoding, missing counterpart, paused exact Jump, primary timing and visibility, actual right-to-left text, explicit Restore, changed primary, keyboard, narrow layout and reduced motion. No qBittorrent mutation or extra prepare accompanies comparison. Capture the actual fixture and results for exact source review.
- The server serves three new same-origin assets through its static allowlist. Confirm all three return 200, the app boots, and the exact staged rollback, Windows shortcut and local library connection pass.

[WebVTT cue timing specification](https://www.w3.org/TR/webvtt1/)
