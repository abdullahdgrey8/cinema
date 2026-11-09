# Scene Sketchbook

Roadmap 28 begins with an in-player sketchbook. Open Scenes & sound, then Scene Sketchbook. Pause at a moment you watched and choose Save this still. This round uses existing opt-in Watched Dialogue history as its evidence source.

1. Capture only in the visible main player, with the exact completed playback attachment and a recent presented frame, while paused, nonseeking and ready. Both the frame timestamp and the current position must fit, with a small guard on either side, inside one continuous sealed watched interval. Reuse the active-file and exact timeline proof from Watched Dialogue. An asynchronous proof must match the same attachment, presented-frame record and position on return. A playing, waiting, changed, skipped, incomplete or unverifiable source has no capture path.
2. Keep at most three timestamped stills at 256 by 144 pixels or smaller, using the existing video and in-memory canvases. Saving is explicit. Keep the gallery with the same open video. Clear it when leaving the player, switching the attachment, hiding the app, disconnecting, removing the file or resetting watched history. Keep every still local to the open player. No new decoder, seek, transfer, persistent still, media server route or background sampling is needed. Use one bounded proof request at a time and preserve the original pause state.
3. Provide a nested keyboard-operated disclosure, visible focus, status feedback without focus theft, accessible still timestamps and reduced-motion support. Test a known watched frame, skipped and future colors, a disjoint interval, absence of sealed coverage, stale attachment and seek cancellation, reset, limit and gallery lifetime. Verify actual frame color and keyboard interactions in isolated Edge and Windows WebView2, then verify the exact installed app and existing library.

Library thumbnails, permanent galleries and automatic frame selection remain separate scopes.

## Capture and lifetime rules

The paused sample comes only from the existing main-player frame callback. Check its presentation count, playback revision, attachment, and paused position after verification. The requested span covers both times plus 100 ms on either side within one witnessed interval. Withhold a still if the source, frame, ready state or dialog changes.

Minimizing to the dock, hiding the app or leaving the video clears the gallery. Closing the disclosure cancels a pending save and keeps already verified stills for the same player. A fourth successful save replaces the oldest. Resetting the history clears all previews. If the history limit prunes a saved interval, remove its still.

Save from inside an already watched section. Recent playback can take a few seconds to reach saved history. A newly paused moment at the leading edge may be unavailable because its full guarded span needs to be witnessed. The player explains how to move back and try again. Saving never changes the playhead.

Keep the main frame sample within 300 ms of the paused position. A stale or missing sample has a retry state. Capture requires a positive unchanged decoded-frame counter across verification. Keep each gallery item only while the same sealed file and timeline still cover its saved interval.

WebView2 may report the new frame before its seek settles. That frame is only a candidate. Drawing still requires a paused, ready, settled player and an unchanged candidate whose timestamp and settled position both fit the guarded watched interval.
