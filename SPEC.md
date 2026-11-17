# pi-streaming-voice — spec (v1)

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
  are removed. Release stops recording.
- Only active when the main editor has focus. In overlays/dialogs/selectors Space behaves normally.

## Live transcription
- Stream 16 kHz mono linear16 PCM to Deepgram `wss://api.deepgram.com/v1/listen` with `model=nova-3`,
  `language=en`, `punctuate=true`, `smart_format=true`, `interim_results=true`. Auth header `Authorization: Token <key>`.
  Send KeepAlive/CloseStream per Deepgram docs; on release, flush and wait for final results before closing.
- Interim words are typed live into the editor at the cursor (as in Claude Code) and revised in place; pi's editor cannot dim part of its text, so they render normally.
  Finalized text is inserted at the cursor. Never auto-submit.
- Recording indicator + audio level meter in the status/widget area while recording.

## /voice command
- Named `/voice`, like Claude Code. Pi Voice (`pi-transcribe`) also registers `/voice`, so it is uninstalled; a duplicate name would make pi rename both to `/voice:1`/`/voice:2`.
- Toggles voice mode on/off (like Claude Code). Persist in `~/.pi/agent/pi-streaming-voice.json`. Default: on.

## Key
- `DEEPGRAM_API_KEY` from the environment. Never store or log it.
- Missing key: holding Space just types spaces; `/voice` shows how to set it (`set -Ux DEEPGRAM_API_KEY …`).

## Errors
- Network drop, mic permission denied, Deepgram error → clear `ctx.ui.notify` message; keep whatever text was
  already transcribed. No crash, no stuck recording state.

## Coexistence
- Replaces Pi Voice (`pi-transcribe`), which must be uninstalled.

## Out of scope (v1)
- Keyterm/vocabulary prompting, language selection, auto-submit.

## Done when
- In the user's terminal (Rex; also works in a Kitty-protocol terminal): holding Space streams live text,
  releasing leaves the final text in the editor, a tap still types a space, and it works in both `~/el` and `~/Code`.
- Unit tests cover the hold/tap/release state machine (both detection paths) and the Deepgram message handling
  (interim vs final, error frames) without network or mic.
- README documents install, key setup, and `/voice`.
