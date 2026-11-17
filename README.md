# pi-streaming-voice

Push-to-talk voice input for [pi](https://pi.dev): **hold Space** in the editor to talk, release to stop.
Speech is streamed to Deepgram Nova-3 and the text lands at your cursor as you speak. It never auto-submits.

- A quick tap of Space still types a space.
- While you hold Space, a widget above the editor shows a recording dot, a level meter, elapsed time, and the
  words Deepgram is still guessing at (dim). Finalized phrases are inserted into the editor at the cursor.
- Only active when the main editor has focus; in dialogs, selectors and overlays Space behaves normally.
- Works alongside Pi Voice (`ctrl+i`, local model); no shared keys or commands.

## Install

Requires macOS microphone access for your terminal and Node ≥ 22.19 (pi's bundled Node is fine).

```sh
git clone https://github.com/CharlesSOo/pi-streaming-voice ~/Code/pi-streaming-voice
cd ~/Code/pi-streaming-voice
npm install            # local-path packages are not installed by pi; this fetches the mic library
pi install ~/Code/pi-streaming-voice
```

Or install straight from git (pi runs `npm install` for you):

```sh
pi install git:github.com/CharlesSOo/pi-streaming-voice
```

Personal installs go into `~/.pi/agent/settings.json`, so the extension loads in every directory.
To try it once without installing: `pi -e ~/Code/pi-streaming-voice`.

## Deepgram key

The key is read from `DEEPGRAM_API_KEY` in pi's environment. It is sent only in the `Authorization` header
to Deepgram and is never stored or logged.

```fish
set -Ux DEEPGRAM_API_KEY <your-key>     # fish
```

```sh
export DEEPGRAM_API_KEY=<your-key>      # bash/zsh, e.g. in ~/.zshrc
```

Restart pi afterwards. Without a key, holding Space just types spaces.

## `/stream-voice`

Toggles voice mode on and off (default: on). The choice is saved in `~/.pi/agent/pi-streaming-voice.json`.
If the key is missing, it tells you how to set it.

(It is not called `/voice` because Pi Voice already owns that command.)

## How the hold is detected

- **Kitty keyboard protocol terminals** (press/repeat/release events): Space is a hold once it has been down for
  350 ms without a release. The space the press typed is removed, recording starts, and the release event stops it.
  This path is used once pi has negotiated the protocol *and* a key-release event has actually been seen.
- **Other terminals** (only auto-repeat): three consecutive spaces at most 125 ms apart (auto-repeat) mean a hold;
  the spaces typed while detecting — including the original press, if it came at most 650 ms before the first
  repeat — are removed. Recording stops when no repeat arrives for max(200 ms, 2.5 × the repeat interval), or when
  another key is pressed. Hold detection therefore starts after your OS key-repeat delay.

## Errors

Network drops, Deepgram errors and denied microphone access show a notification; text that was already inserted
stays. On release the stream is flushed (`Finalize`) and closed (`CloseStream`), waiting up to 3 s for the final words.

## Development

```sh
npm install
npm test        # typecheck + unit tests (no network, no microphone)
```
