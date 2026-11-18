# Changelog

## [0.2.2] - 2026-11-18

### Changed
- Space hold in kitty-protocol terminals (Rex, Kitty, Ghostty) starts on the first auto-repeat of the key instead
  of after 350 ms, so it starts after the OS "delay until repeat". Hold mode needs the OS key repeat to be on; with
  it off, use tap mode with a combo.
- A hold ends when its repeats stop for max(500 ms, 2.5 × the repeat interval) (was 200 ms), so a short stall no
  longer ends it.
- `listening…` appears once the microphone is delivering audio, not when it has been opened.
- The recording indicator is drawn at the right end of the editor's top border instead of on its own row above
  the editor, so the screen no longer shifts. The red dot is gone and the level meter is grey.

### Fixed
- Text ending in a space that was not typed by a held key (a paste, `rex send`, a dictation tool) started a take
  that never stopped. Without auto-repeat nothing records now, and two spaces a few ms apart are text.
- A key release lost before the first auto-repeat left the microphone open, for Space and for combos. A combo hold
  now also ends if no repeat or release follows the press within 2 s.
- A hold cut because its repeats stalled did not come back while the key was still down. The next repeat now
  starts a new take at once, leaving no spaces behind.
- Combo as tap (terminals without key-release events): a second press within 650 ms of the first was ignored, and
  with an OS repeat delay over 650 ms the auto-repeat stopped the take it had just started. A press now counts as
  one when no other follows it within 125 ms.
- The first word was lost when speech started the moment `listening…` appeared: the label was shown before the
  microphone delivered audio.

## [0.2.1] - 2026-11-18

### Added
- Region `Auto`, the new default: at session start the connection to each of the four Deepgram hosts is timed in the
  background and the fastest is used. The pick is saved, so the next session starts with it, and
  `/voice-settings` shows it, e.g. `Auto (India, 140 ms)`. The measurement opens a TLS connection only: it sends
  no API key and no audio.

### Changed
- A settings file without `region` now loads as `auto` (was `global`). Auto may send audio to any of the four
  regions; choose a region in `/voice-settings` to keep processing in it.
- The settings file gains `autoPick`, the region Auto last measured as fastest.

## [0.2.0] - 2026-11-18

### Added
- `/voice-settings`: a menu for voice on/off, the hotkey, hold or tap mode, and the Deepgram region.
  - Hotkey: Space, or any combo with ctrl, alt or cmd (`alt+v`, `ctrl+space`, `super+j`). Keys pi already binds and
    keys you type with are refused, with the reason.
  - Mode: hold (talk while the key is down) or tap (press to start, press again or Escape to stop; needs a combo).
    In terminals without key-release events a combo works as tap.
  - Region: Global, EU, Australia or India host.
- Live typing: words are typed into the editor at the cursor as you speak and corrected in place.
- A notice when Deepgram does not confirm the last words in time.

### Changed
- The command is `/voice` (was `/stream-voice`), replacing Pi Voice's command of the same name.
- The recording indicator is right-aligned above the editor: dot, level meter, `listening…` / `transcribing…`.
- A take ends as soon as the final words have arrived; the socket closes in the background. Holding the key again
  while the previous take is still `transcribing…` starts the next take once that one has settled.
- The settings file is now `{enabled, hotkey, mode, region}`; a file with only `enabled` keeps working.

### Fixed
- Hold detection in Rex, which sends Space repeats as plain text and encodes only the release.
- A Space released with Shift or Caps Lock on was not recognised: the next character was deleted and recording
  started with no key held.
- A lost key release left the microphone recording; a hold now also ends when its auto-repeats stop.
- Typing, moving the cursor or pressing Enter during a take duplicated transcript text or split it across two
  prompts.
- Typing on while Space was still down deleted the wrong character.
- `/voice` off while the microphone was still opening left it open.
- A connection that never opened (for example a rejected key) only said "Lost connection to Deepgram".
- `/voice` with no key set only explained how to set it when turning voice on.
- Text flashed blank when a final result covered less audio than the interim shown.

## [0.1.0] - 2026-11-17

- Hold Space to dictate into pi's editor, streamed to Deepgram Nova-3; a tap still types a space.
- Hold detection for kitty-protocol terminals (press/release events) and for others (auto-repeat timing).
- Toggle command, persisted in `~/.pi/agent/pi-streaming-voice.json`; key read from `DEEPGRAM_API_KEY`.
