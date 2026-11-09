# Cinema innovation backlog

The user asked to implement each feasible idea from the research list. Keep the original IDs stable across rounds. Completion needs evidence for the actual experience, and an experiment that misses its gate stays on the list with its result. The first delivery is a shared foundation, with verification tracked in the Sentinel activity record.

| ID | Idea | Dependency and evidence to collect |
| --- | --- | --- |
| 01 | Scene Relay | Verified identity and seek model. Recover a shifted scene without jumping on a repeated or missing cue. |
| 02 | Rescue Switch | 01, 06 and 12. Confirm readiness on a replacement before offering the switch, then measure continuity and added cost. |
| 03 | Edition Atlas | 01. Compare an independently verified pair and distinguish shared, uncertain and edition-only passages. |
| 04 | Portable scene cards | 01. Round-trip a bounded metadata-only card and locate it using a recipient's own release. |
| 05 | Watch together across cuts | 03 and opt-in authenticated rooms. Prove that viewers align across an inserted scene and can rejoin after stalls. |
| 06 | Verified playback map | Real duration and verified ready intervals, with accurate labels for incomplete and unknown video. |
| 07 | Scene on Arrival | 01 and 06. Allow a viewer to follow a waiting pin and offer a manual jump once ready. |
| 08 | Fetch This Scene | 06 and a separate torrent-engine experiment. Prove that the target keyframe window can be prioritized safely while preserving the current qBittorrent integration. |
| 09 | First-Frame Race | 06 and concurrent preparation limits. Compare cold startup, stalls and extra bytes against baseline. |
| 10 | Playback runway | 06 and live measurements. Compare predictions with actual stalls and surface uncertainty. |
| 11 | Watch while it gets ready | 06, 12 and an opt-in fallback. Confirm the fallback can play without starving foreground preparation. |
| 12 | Warm return | A bounded warm conversion. Return with the verified range intact and prove memory, CPU and same-torrent priority isolation. |
| 13 | Release Passport | Separate reported and locally observed release facts. Preserve evidence provenance and invalidate stale claims. |
| 14 | Source memory | 13. Compare rankings on held-out runs and keep low-sample observations separate from verified facts. |
| 15 | Tonight in Three Picks | Runtime, local readiness and current charts. Show ready, discovery and wildcard choices with honest reasons. |
| 16 | Build a movie night | 15. Fit an editable program to a time budget and export title metadata without media. |
| 17 | Ready by 8 | 10 and opt-in preparation. Report deadline uncertainty and show a ready fallback without deleting downloads. |
| 18 | Explore what a plugin is good at | Existing plugin browse. Verify representative samples and show whether the plugin exposes a catalog. |
| 19 | Follow the Week | 22. Verify local air times and keep airtime, source readiness and captions distinct. |
| 20 | Pick Together | 15. Reveal only mutual choices, ordered by readiness, with account-free voting on one PC. |
| 21 | Follow the story's orbit | 22 and provider-backed relationships. Validate alternate orders, specials and source episode numbering. |
| 22 | Story Map | Verified episode history and local season-pack reuse. Demonstrate resume, next, caught up and missing local files. |
| 23 | Scene Finder and library quote search | Search the current track first. Then add a bounded opt-in local library index with watched-only defaults. |
| 24 | Replay the exact line | 23 and 06. Show captions briefly, honor adjusted cue time, and restore the user's settings. |
| 25 | Caption Check | Verified audio and timed text. Compare proposed shifts against known fixtures and decline ambiguous cases. |
| 26 | Two-track Studio | Two explicitly selected subtitle tracks. Verify time overlap, replay, and missing counterpart behavior. |
| 27 | Catch up from what you watched | Actual played intervals. Prove that skipped and future sections remain hidden. |
| 28 | Scene Sketchbook | 06, 27 and idle CPU budget. Generate previews only from eligible footage and keep future shots hidden. |
| 29 | Accessible Sound Map | 23. Provide keyboard navigation for authored sound cues and separate support for real audio description. |
| 30 | Anime Theme Memory | 21 and audio matching. Verify starts and ends across episodes, changed themes, and post-credit scenes. |

Keep the Windows application and its original playback paths usable throughout. New motion should explain state changes and honor reduced-motion preferences. Keep account-free, local processing as the default and avoid deleting retained downloads automatically. Each round should have bounded scope, test cases, visual review where it applies, and an explicit current-state handoff.
