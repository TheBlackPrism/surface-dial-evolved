# Surface Dial Evolved

The Microsoft Surface Dial on GNOME (Wayland): a radial ring of
context-aware actions, rotate modes per application, and haptic feedback.

- **Press and hold** the dial: a ring opens at the mouse pointer with
  actions for the focused application. **Turn** to choose (the dial clicks
  on every step), **click** to run. Hold again, or wait, to close it.
- **Turn** without the ring: the application's current rotate mode —
  scroll, zoom, volume, seek, brush size, switch tabs, jump between methods …
- **Press and turn**: switch between the application's rotate modes.
- Prefer turning to open the ring? Set *Turning the Dial* to *Opens the Ring*
  in the preferences; then the first step opens the ring and the next ones
  choose.
- **Click** without the ring: the application's click action.

| Application | Ring | Rotate modes · click |
|---|---|---|
| IntelliJ IDEA | Debug with HotSwap, Rerun HotSwap Debug, Reload Changed Classes, Stop, Sync All Maven Projects, Recompile File, Build Project, Reformat Code | scroll · methods · problems — click: Recent Files |
| SourceGit | Fetch, Pull, Push, Commit & Push, New Branch, Local Changes, Refresh, Command Palette | scroll · tabs — click: Refresh |
| Firefox | Back, Forward, Reload, New Tab, Close Tab, Reopen Closed Tab, Reset Zoom | scroll · tabs · zoom — click: Reload |
| VS Code | Run, Debug, Stop, Git: Sync, Format Document, Terminal, Quick Open | scroll · tabs · zoom — click: Quick Open |
| Spotify | Play/Pause, Next, Previous, Shuffle, Mute | volume · seek — click: Play/Pause |
| mpv, Showtime | Play/Pause, ±30 s, Fullscreen, Mute | seek · volume — click: Play/Pause |
| Ptyxis | New Tab, Close Tab, Copy, Paste, Find, Reset Zoom | scroll · tabs · zoom — click: Paste |
| Files | Back, Forward, Parent Folder, New Folder, Hidden Files, Grid/List View | scroll · zoom — click: Back |
| GIMP | Undo, Redo, Paintbrush, Eraser, Swap Colors, Fit Image | brush size · zoom · scroll — click: Undo |
| LibreOffice | Undo, Redo, Bold, Italic, Underline, Save | scroll · zoom — click: Undo |
| everything else | Play/Pause, Next, Previous, Mute, Screenshot, Dial Settings, Dark Style, Overview | volume · scroll — click: Play/Pause |

## How it works

```
Surface Dial ──evdev/hidraw──▶ GNOME Shell extension ──HTTP + token──▶ IntelliJ plugin
                               device → gestures → profile of focused window
                               → ring overlay → actions (virtual keyboard/pointer,
                                 MPRIS, volume, IntelliJ action ids)
```

- `extension/` — the GNOME Shell extension. It reads the dial's evdev node
  directly (GNOME/libinput ignores the dial's rotation), and injects keys
  and scrolling through Mutter's virtual input devices, so no `/dev/uinput`
  access is needed.
- `extension/helpers/dial-haptics.py` — sets the dial's steps per turn and
  haptic feedback (a click per step, or a stronger buzz) through a HID feature report (needs an ioctl, which GJS
  cannot do).
- `intellij-plugin/` — "Surface Dial Bridge", a small IntelliJ plugin that
  runs actions by id on `http://127.0.0.1:63342/api/dial/action?id=…`. It
  only answers loopback requests without an `Origin` header that carry the
  token from `~/.config/surface-dial-evolved/intellij-token` (created by the
  plugin, mode 0600).
- `udev/70-surface-dial.rules` — gives the logged-in user access to the dial.

## Installation

```bash
make install-udev
```

```bash
make install
```

Then log out and back in and enable the extension:

```bash
gnome-extensions enable surface-dial-evolved@theblackprism.ch
```

For IntelliJ, build the plugin and install
`intellij-plugin/build/distributions/surface-dial-intellij-*.zip` with
*Settings → Plugins → ⚙ → Install Plugin from Disk…* (no restart needed):

```bash
make plugin
```

SourceGit's *Fetch* uses SourceGit's own "Fetch all remotes" choice, so tick
that option once in its Fetch dialog.

## Custom profiles

Open the extension's preferences → *Edit Profiles*, or edit
`~/.config/surface-dial-evolved/profiles.json`; it is reloaded on save.
A profile with the id of a built-in one (see
`extension/profiles/default.json`) overrides the fields it sets; other
profiles are added and win over the built-in ones.

```json
{
  "profiles": [
    {
      "id": "calculator",
      "name": "Calculator",
      "match": {"appIds": ["org.gnome.Calculator"]},
      "ring": [
        {"label": "Clear", "icon": "edit-clear-all-symbolic", "action": {"type": "keys", "keys": "Escape"}}
      ],
      "modes": [
        {"id": "digits", "label": "Digits", "icon": "input-dialpad-symbolic",
         "cw": {"type": "keys", "keys": "plus"}, "ccw": {"type": "keys", "keys": "minus"}}
      ],
      "click": {"type": "keys", "keys": "Return"}
    }
  ]
}
```

`match` takes `appIds` (desktop file ids) and regular expressions for
`appId`, `wmClass` and `title`. A mode has either `cw`/`ccw` actions or a
`rotate` action (`scroll` with optional `modifiers`, `volume`,
`mpris-volume`, `mpris-seek`). Actions:

| type | fields |
|---|---|
| `keys` | `keys`: `ctrl+shift+Down`, `F5`, `bracketleft` … (keysym names) |
| `text` | `text`: typed character by character |
| `intellij` | `id`: IntelliJ action id, or `dial.rerunHotSwap` |
| `mpris` | `method`: `PlayPause`, `Next`, `Previous`, `Seek` (+`seconds`), `ToggleShuffle`; optional `player` |
| `mute` | — |
| `shell` | `call`: `screenshot`, `overview`, `preferences` (this extension's settings), `night-light`, `dark-style` |
| `command` | `argv`: program and arguments |
| `mode` | `mode`: id of a rotate mode to switch to |
| `sequence` | `actions`: run in order; `delay` actions (`ms`) wait in between |

Every action may have a `fallback` action that runs when it fails.
Icons are symbolic icon names of the icon theme, or `dial-…` icons from
`extension/icons/`.

## Development

```bash
make test
```

```bash
make nested
```

`make nested` starts a nested GNOME Shell in a window, with throwaway
settings and development D-Bus hooks (`extension/lib/devtools.js`) that
simulate the dial and take screenshots:

```bash
gdbus call --session --dest org.gnome.Shell --object-path /ch/theblackprism/SurfaceDial/Dev --method ch.theblackprism.SurfaceDial.Dev.Hold intellij
```

(run it with `DBUS_SESSION_BUS_ADDRESS` set to the nested session's bus, which
`tools/nested.sh` writes to `$XDG_RUNTIME_DIR/surface-dial-nested/bus`).
Turn on *Debug Logging* in the preferences and follow the journal:

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```
