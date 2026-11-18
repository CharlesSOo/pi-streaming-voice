# pi-streaming-voice — spec (v1, with the 0.2.x additions below)

Goal: a global pi extension that mirrors Claude Code's `/voice` push-to-talk 1:1, using Deepgram
Nova-3 streaming STT instead of Anthropic's private endpoint.

## Package
- Repo: `github.com/CharlesSOo/pi-streaming-voice` (local: `~/Code/pi-streaming-voice`, Mac — needs the mic).
- TypeScript, strict, ESM. A pi package (see pi docs: docs/packages.md, docs/extensions.md, docs/tui.md,
  examples/extensions). Installed globally (`pi install` from the local path or git), so it loads in
  every directory (`~/el` and elsewhere share `~/.pi/agent`).
- Pi docs: `/Users/charles/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/{README.md,docs,examples}`.
- Reference implementation for mic capture and editor/status UI patterns: Pi Voice at
  `~/.pi/agent/git/github.com/earendil-works/pi-transcribe` (`src/audio.ts`, `src/pcm-chunker.ts`,
  `src/runtime.ts`, `src/visualizer.ts`). Read, do not modify. Mic library: `@handy-computer/recorder`.

## Push-to-talk on Space (like Claude Code)
- Hook raw input via `ctx.ui.onTerminalInput` (runs before key-release filtering, pi-tui `dist/tui.js:719`).
- Two detection paths:
  1. Kitty keyboard protocol active (pi-tui requests flags 7, incl. event types; see `isKittyProtocolActive`,
     `isKeyRelease`, `isKeyRepeat` exported from `@earendil-works/pi-tui`): real press/repeat/release.
  2. Fallback (no release events): detect a hold from terminal auto-repeat timing, as Claude Code does; release =
     repeats stop for a gap threshold.
- A quick tap types a normal space. A hold starts recording once detected; any spaces inserted during detection
  are removed. Release stops recording. (Detection is driven by auto-repeat since 0.2.2, see "Hold detection".)
- Only active when the main editor has focus. In overlays/dialogs/selectors Space behaves normally.

## Live transcription
- Stream 16 kHz mono linear16 PCM to Deepgram `wss://api.deepgram.com/v1/listen` with `model=nova-3`,
  `language=en`, `punctuate=true`, `smart_format=true`, `interim_results=true`. Auth header `Authorization: Token <key>`.
  Send KeepAlive/CloseStream per Deepgram docs; on release, flush and wait for final results before closing.
- Interim words are typed live into the editor at the cursor (as in Claude Code) and revised in place; pi's editor cannot dim part of its text, so they render normally.
  Finalized text is inserted at the cursor. Never auto-submit.
- While recording, a level meter and `listening…` are drawn at the right end of the editor's top border (no extra row).

## /voice command
- Named `/voice`, like Claude Code. Pi Voice (`pi-transcribe`) also registers `/voice`, so it is uninstalled; a duplicate name would make pi rename both to `/voice:1`/`/voice:2`.
- Toggles voice mode on/off (like Claude Code). Persist in `~/.pi/agent/pi-streaming-voice.json`. Default: on.

## /voice-settings (0.2.0)
- Menu with four rows: Voice (on/off), Hotkey, Mode (hold/tap), Region.
- Persist in `~/.pi/agent/pi-streaming-voice.json` as `{enabled, hotkey, mode, region}` (plus `autoPick`, see "Region: Auto"). Defaults: `hotkey: "space"`,
  `mode: "hold"`, `region: "auto"` (0.2.1; was `"global"`). A file that only has `enabled` loads with those defaults.

### Hotkey
- Choosing Hotkey shows "press the key you want"; Escape cancels and keeps the old key. Keys are parsed by pi-tui
  (`parseKey`), not by this package.
- Allowed: Space, or any combo with ctrl, alt or cmd (`super` in pi key syntax), e.g. `super+k`, `alt+v`, `ctrl+space`.
- Rejected, with a message saying why: bare letters/digits/punctuation, Enter, Escape, Tab, Backspace, and any key pi
  already binds (the message names the action that owns it).
- A press must carry exactly the hotkey's modifiers (lock keys aside); a release is recognised whatever modifier or
  lock bits it carries.
- The recording indicator shows no key hint and no dot: only the meter (while listening, in the theme's muted
  grey) and `listening…` / `transcribing…` (`starting…` while connecting). The hotkey is shown in `/voice-settings` and the `/voice` on message only.

### Mode
- Hold (default): Space behaves as under "Push-to-talk on Space". A combo starts recording immediately on press (it
  types nothing) and stops on release.
- Tap: one press starts recording; a second press or Escape stops it.
- Tap requires a combo hotkey. Selecting tap while the hotkey is Space asks for a new hotkey first; if that capture
  is cancelled, mode stays hold.
- Terminals without key-release events: Space hold works (repeat-timing path); a combo hotkey behaves as tap there,
  with a one-time notice.

### Region
- Global (`api.deepgram.com`, the default until 0.2.1), EU (`api.eu.deepgram.com`), Australia (`api.au.deepgram.com`), India
  (`api.in.deepgram.com`). Same key and paths; only the host changes. The next take uses the chosen host.

### Region: Auto (0.2.1)
- Region gains `auto`, the default: Auto, Global, EU, Australia, India. A settings file without `region` loads as
  `auto`.
- With `auto`, the extension times a connection to each of the four hosts in the background: three tries per host,
  median, 3 s timeout per try. It never blocks startup or a take. The fastest host is used. A host with a failed or
  timed-out try is skipped; if none is left, the last cached pick is kept, or Global when there is none.
- The pick is cached in the settings file as `autoPick: {region, ms, at}` (`at`: epoch ms of the measurement; no
  `ms` and no `at` when no host answered), so the next session starts with it; until the first measurement
  finishes, Global is used. A take in progress never changes host.
- 0.2.3: measured at most once a day. At session start, and when voice is turned on, it measures only if there is
  no pick or the pick is older than 24 hours (a pick without `at` counts as stale); otherwise no connection is
  made. Choosing Auto in `/voice-settings` measures at once. A measurement where every host failed leaves the pick
  and its `at` as they were, so the next session tries again.
- 0.2.3: a result re-reads the settings file and changes only `autoPick` in it, and only if the file still says
  region `auto`. Session shutdown destroys the sockets of a measurement in flight and drops its result.
- `/voice-settings` shows the pick next to Auto, e.g. `Auto (India, 140 ms)`.
- Choosing a fixed region turns measuring off; so does turning voice off.
- The probe times a TCP+TLS connect to port 443 and drops the connection: no HTTP request, no API key, no stream.

## Take behaviour (0.2.0)
- A hold ends when its auto-repeats stop for the release gap, on every path: a take never keeps the mic open with no
  key held (0.2.2: also before the first repeat, see "Hold detection").
- Other keys cancel a pending kitty Space hold (`ab`, Space down, `x`, `y` gives `ab xy`, no recording).
- Typing or moving the cursor during a take never duplicates or loses transcript text: while listening, the shown
  interim is removed before the key goes through and comes back at the cursor; during `transcribing…`, keys are held
  back and replayed in order once the final text is in place (bounded by the finalize timeout), so Enter does not
  split the text across two prompts.
- A take is settled as soon as the finalized result has arrived; the socket closes in the background. A hold started
  while the previous take is finishing starts as soon as that one has settled, if the key is still held.
- If the finalize timeout (3 s) hits, a notice says the last words may be missing.

## Hold detection (0.2.2)
- Hold mode is driven by the OS auto-repeat of the held key, which must be on (with it off: tap mode with a combo).
  A take in hold mode never keeps the mic open when no key is held, and is not cut while the key is still down.
- Kitty path, Space: the press types a space; the first auto-repeat (plain `" "` as in Rex, or encoded) within 2 s
  starts the take and removes that space; the release ends it. A plain space sooner than 120 ms after the press is
  typed as text, not taken as a repeat. So text that is not a held key (`word ` injected with no release, two or
  three spaces a few ms apart) never records and its spaces stay. This replaces the 350 ms threshold.
- 0.2.3: the 120 ms count from the press, not from the previous space. When the press and its first repeats are
  processed close together (busy event loop), the hold starts at the first plain space at least 120 ms after the
  press, and every space typed since the press is removed. A release or any other key resets this.
- Key repeat speed: the kitty path tolerates repeat intervals up to 500 ms; the repeat-timing path and the tap
  fallback need at most 125 ms.
- Known limits: without release events, a second space 120 ms to 2 s after an unreleased one looks like a hold and
  records for about 500 ms; for 2 s after a recording was cut for a lost release, the next Space starts a recording
  instead of typing a space.
- Watchdog: every hold ends when no repeat arrives for max(500 ms, 2.5 × the repeat interval), armed from the first
  repeat. A combo hold (which starts on the press) ends if neither a repeat nor a release follows within 2 s.
- Resume: if the watchdog cut a kitty-path take (Space or combo) and a repeat of the hotkey arrives within 2 s with
  no release or other key in between, the key is still down: a new take starts at once and no space is typed. On
  the repeat-timing path the hold is detected again as usual (three rapid spaces, the typed ones removed).
- Combo as tap where releases are not reported: the first press starts the take. After that a press within 125 ms of
  another is auto-repeat and is ignored; a lone press toggles once 125 ms have passed with nothing following. A press
  more than 2 s after the last one, with nothing recording, starts at once. Where releases are reported (tap mode),
  a press after a release toggles at once.
- `listening…` is shown from the first audio chunk the microphone delivers (`starting…` before), so it means audio is
  being captured.

## Key
- `DEEPGRAM_API_KEY` from the environment. Never store or log it.
- Missing key: holding Space just types spaces; `/voice` shows how to set it (`set -Ux DEEPGRAM_API_KEY …`) whichever
  way the toggle goes.

## Errors
- Network drop, mic permission denied, Deepgram error → clear `ctx.ui.notify` message; keep whatever text was
  already transcribed. No crash, no stuck recording state.
- A connection that fails before it opens says the key may be invalid ("check DEEPGRAM_API_KEY").

## Coexistence
- Replaces Pi Voice (`pi-transcribe`), which must be uninstalled.

## Out of scope (v1)
- Keyterm/vocabulary prompting, language selection, auto-submit.

## Done when
- In the user's terminal (Rex; also works in a Kitty-protocol terminal): holding Space streams live text,
  releasing leaves the final text in the editor, a tap still types a space, and it works in both `~/el` and `~/Code`.
- Unit tests cover the hold/tap/release state machine (both detection paths, combo hold, tap mode), key validation,
  settings loading (a file that only has `enabled`, region default), the Auto region pick, the listen URL per region, and the Deepgram
  message handling (interim vs final, error frames) without network or mic.
- README documents install, key setup, `/voice` and `/voice-settings`.
