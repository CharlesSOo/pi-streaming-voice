# pi-streaming-voice

Push-to-talk voice input for [pi](https://pi.dev): **hold Space** in the editor to talk, release to stop (the key and the mode are configurable).
Speech is streamed to Deepgram Nova-3 and the text lands at your cursor as you speak. It never auto-submits.

- A quick tap of Space still types a space.
- `/voice-settings` changes the hotkey (Space or a combo such as `alt+v`), hold or tap mode, and the Deepgram region.
- Words are typed into the editor at the cursor as you speak and corrected in place as Deepgram refines them
  (like Claude Code's `/voice`). A small level meter and `listening…` show at the right end of the editor's top border.
- Only active when the main editor has focus; in dialogs, selectors and overlays the hotkey behaves normally.
- Registers `/voice`, so it replaces Pi Voice (`pi-transcribe`): uninstall that package first, or both commands get renamed to `/voice:1`/`/voice:2`.

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

Sign up at [console.deepgram.com](https://console.deepgram.com/signup): new accounts get $200 of free credit,
which covers a lot of dictation. Create an API key there.

The key is read from `DEEPGRAM_API_KEY` in pi's environment. It is sent only in the `Authorization` header
to Deepgram and is never stored or logged.

```fish
set -Ux DEEPGRAM_API_KEY <your-key>     # fish
```

```sh
export DEEPGRAM_API_KEY=<your-key>      # bash/zsh, e.g. in ~/.zshrc
```

Restart pi afterwards. Without a key, the hotkey does nothing special (holding Space just types spaces).

## `/voice`

Toggles voice mode on and off (default: on). If `DEEPGRAM_API_KEY` is missing, it says how to set it, whichever way
the toggle goes.

## `/voice-settings`

Opens a menu with four rows. Changes apply immediately and are saved, with the `/voice` toggle, in
`~/.pi/agent/pi-streaming-voice.json` as `{enabled, hotkey, mode, region}` (plus `autoPick`, the region Auto last
measured as fastest, its connect time and when it was measured).

| Row | Values | Default |
|---|---|---|
| Voice | on, off | on |
| Hotkey | Space, or a combo with ctrl, alt or cmd | `space` |
| Mode | hold, tap | hold |
| Region | Auto, Global, EU, Australia, India | Auto |

### Hotkey

Choose the row, then press the key you want; Escape cancels and keeps the old key. Keys are written in pi's key
syntax, where cmd is `super`: `alt+v`, `ctrl+space`, `super+j`.

- Allowed: Space, or any combo that includes ctrl, alt or cmd.
- Refused, with the reason shown: keys you type with (letters, digits, punctuation, also with shift), Enter, Escape,
  Tab, Backspace, and any key pi already binds (the menu names the action, e.g.
  `ctrl+k is already used by pi for tui.editor.deleteToLineEnd`). Shortcuts registered by other extensions are not
  known to the menu.
- A combo types nothing, so with a combo hotkey Space is an ordinary key again.

**Cmd combos in Rex.** Rex sends a Cmd combo to the terminal only if Rex itself has no shortcut on it; pi then sees
it as `super+<key>`. By default Rex keeps, among others, cmd with `d f g k n p r t w y`, the digits, `[ ] , . / - =`,
Enter, Backspace and the arrows (see Rex's Mac Actions reference), so `super+k` only works after
`rex.unbind("cmd+k")` in Rex's `init.lua`. Unbound ones such as `cmd+j`, `cmd+u` or `cmd+i` work as they are.
Terminals without the kitty keyboard protocol cannot report cmd at all.

### Mode

- **hold** (default): talk while the key is down. Space works as described under "How the hold is detected". A combo
  starts recording the moment it is pressed and stops on release. Hold mode needs the OS key repeat to be on; with
  it off, use tap mode with a combo.
- **tap**: one press starts recording; a second press, or Escape, stops it. You can keep typing while it records.
  Tap needs a combo hotkey, because a tapped Space has to stay a space: choosing tap while the hotkey is Space asks
  for a new hotkey first, and stays on hold if you cancel. A take also ends when a dialog takes the focus.

In a terminal without key-release events (no kitty keyboard protocol), a combo cannot be held, so it works as tap
even in hold mode; pi says so once. There, a held key arrives as a stream of presses, so a press counts as a second
press only when no other follows it within 125 ms; stopping therefore takes effect 125 ms after the press. Space
hold works there as usual.

### Region

Which Deepgram host takes connect to. The key and everything else are the same on each; the next take uses the
chosen host.

| Region | Host |
|---|---|
| Auto (default) | the fastest of the four below |
| Global | `api.deepgram.com` |
| EU | `api.eu.deepgram.com` |
| Australia | `api.au.deepgram.com` |
| India | `api.in.deepgram.com` |

A regional host keeps processing in that region and does not fall back to another one if it is unavailable. A
nearer region shortens the wait for the first words: measured from Southeast Asia, the connection opened in
1.8–2.1 s on Global and 1.0–1.1 s on India, with the same transcript.

**Auto** finds the nearest one for you. At most once a day it times a connection to each of the four hosts in the
background (three tries each, taking the median) and uses the fastest; a host that fails or does not answer within
3 s is skipped. The pick is saved with the time it was measured, and the menu shows it next to Auto, e.g.
`Auto (India, 140 ms)`. A pi session that starts (or voice being turned on) within 24 hours of the last measurement
uses the saved pick and opens no connection at all; after that it measures again. Choosing Auto in the menu
measures at once. Until the first measurement has finished, Global is used. If no host answers (for example
offline), the last saved pick is kept and the next session tries again. A take that is already running stays on
its host. The measurement only opens a TLS connection and drops it: it sends no API key and no audio, and costs
nothing.

**Auto may send your audio to any of the four regions.** If processing has to stay in one region, choose that
region explicitly; a fixed region is never measured and never changes.

## How the hold is detected

Hold mode is driven by the OS auto-repeat of the held key: the repeats are what shows the key is still down. **The
OS key repeat has to be on** (macOS: System Settings → Keyboard → Key repeat rate, not "Off"). With it off, a held
Space just types one space and a held combo records for 2 s; use tap mode with a combo instead.

**How fast the key has to repeat.** In kitty keyboard protocol terminals a hold survives repeat intervals up to
500 ms, so any macOS setting works. In other terminals (the repeat-timing path, and a combo working as tap) the
repeats have to come at most 125 ms apart: leave macOS "Key repeat rate" at its default or faster. The slowest
settings repeat more slowly than that, and a held Space then just types spaces.

Space is the only hotkey that also types:

- **Kitty keyboard protocol terminals** (key-release events): the press types a space. Its first auto-repeat makes
  it a hold: the space is removed and recording starts, so recording starts after your OS "delay until repeat". The
  release event stops it. A tap, or typing another key while Space is down, leaves an ordinary space. Text that
  merely contains spaces (a paste, text injected by another tool) does not record: spaces sooner than 120 ms after
  the first are typed as text, not taken as repeats. If spaces are still coming 120 ms after the press, it was a
  held key whose first repeats arrived early (pi was busy and processed them late, close together): recording
  starts and every space typed since the press is removed. The release counts whatever modifiers are down by then
  (Shift for the next capital, Caps Lock). This path is used once pi has negotiated the protocol *and* a
  key-release event has actually been seen.
- **Other terminals** (only auto-repeat): three consecutive spaces at most 125 ms apart (auto-repeat) mean a hold;
  the spaces typed while detecting — including the original press, if it came at most 650 ms before the first
  repeat — are removed. Recording stops when the repeats stop (below), or when another key is pressed.

A combo starts recording on the press and stops on the release.

On every path a hold also ends when its repeats stop for max(500 ms, 2.5 × the repeat interval; intervals over
250 ms are not counted, so at most 625 ms), and a combo hold ends if no repeat or release follows the press within
2 s. So a release that never arrives (focus moved away mid-hold) cannot leave the microphone open. If it was only
a stall and the key is still down, the next repeat starts a new take at once, so at most the words spoken during
the stall are lost.

Known limits:

1. In a kitty-protocol terminal, a space that arrives with no release event (text injected by another tool)
   followed by a second space 120 ms to 2 s later looks like a held key: a take starts, both spaces are removed,
   and it records for about 500 ms until the missing repeats end it.
2. For 2 s after a recording was cut because the release was lost, the next Space starts a recording instead of
   typing a space.

The indicator needs room on the editor's top border: in a terminal narrower than about 20 columns it is not drawn,
though recording works.

`listening…` appears once the microphone is delivering audio (`starting…` until then, typically 150 ms): start
talking when you see it.

## While a take is running

- Typing or moving the cursor while it listens is fine: the not-yet-final words step aside for your key and come
  back at the cursor with the next result.
- After you stop, the indicator shows `transcribing…` until Deepgram has confirmed the last words (usually well
  under a second). Keys pressed in that window, Enter included, are held back and applied right after the final
  text is in place, so nothing is duplicated and a prompt is never split in two.
- Pressing the hotkey again during `transcribing…` starts the next take as soon as the previous one has settled.

## Errors

Network drops, Deepgram errors and denied microphone access show a notification; text that was already inserted
stays. A connection that never opens says to check `DEEPGRAM_API_KEY` and the network (a rejected key and a dead
network look the same from here).

On release the stream is flushed (`Finalize`) and the take waits up to 3 s for Deepgram to confirm the final words
(3 s more if the connection was still opening); if that runs out, it says the last words may be missing. The socket
is then closed (`CloseStream`) in the background.

## Development

```sh
npm install
npm test        # typecheck + unit tests (no network, no microphone)
```
