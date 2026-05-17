# Ormic Launcher — GNOME Shell Extension

A modular, floating application launcher for GNOME Shell **45 – 50**, inspired by
the [pop-os/launcher](https://github.com/pop-os/launcher) project architecture.

## Supported GNOME Versions

| Version | Distro | Status |
|---|---|---|
| GNOME 45 | Fedora 39, Ubuntu 23.10 | ✅ Supported |
| GNOME 46 | Fedora 40, Ubuntu 24.04 LTS | ✅ Supported |
| GNOME 47 | Fedora 41 | ✅ Supported |
| GNOME 48 | Fedora 42, Ubuntu 25.04 | ✅ Supported |
| GNOME 49 | Ubuntu 25.10 | ✅ Supported |
| GNOME 50 | Ubuntu 26.04 LTS | ✅ Supported |

## Features

| Provider | Trigger | Example |
|---|---|---|
| **Apps** | Any text | `firefox`, `calc` |
| **Calculator** | Start with digit/operator | `2 + 2`, `sqrt(144)`, `sin(90) * pi` |
| **Web Search** | `g `, `d `, `y `, `gh `, `w ` | `g gnome extensions` |
| **Recent Files** | Any text (≥2 chars) | `report`, `screenshot` |
| **Shell Command** | `> ` | `> systemctl restart NetworkManager` |

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Super+Space` | Toggle launcher |
| `↑` / `↓` | Navigate results |
| `Enter` | Activate selected result |
| `Tab` | Auto-complete selected name |
| `Esc` | Close launcher |

## Installation

### Method 1 — Manual (recommended for development)

```bash
# 1. Copy to GNOME extensions directory
cp -r ormic-launcher-gnome@extension \
  ~/.local/share/gnome-shell/extensions/ormic-launcher@github.com

# 2. Compile the GSettings schema
glib-compile-schemas \
  ~/.local/share/gnome-shell/extensions/ormic-launcher@github.com/schemas/

# 3. Restart GNOME Shell
#    On Wayland: log out and log back in
#    On X11:     Alt+F2 → type 'r' → Enter

# 4. Enable the extension
gnome-extensions enable ormic-launcher@github.com
# or use GNOME Extensions app / Extension Manager
```

### Method 2 — Extensions Manager

1. Install **Extension Manager** from Flathub
2. Click "Install from file" and select the `.zip` archive
3. Toggle the extension on

## Preferences

Open with:
```bash
gnome-extensions prefs ormic-launcher@github.com
```

Or via GNOME Extensions / Extension Manager → ⚙ gear icon.

## Architecture

```
extension.js          ← Main entry point (GNOME 45+ ESM)
  ├── AppProvider     ← Searches Shell.AppSystem
  ├── CalcProvider    ← Evaluates math expressions
  ├── WebProvider     ← Opens browser with search query
  ├── RecentProvider  ← Reads ~/.local/share/recently-used.xbel
  └── CommandProvider ← Runs shell commands via GLib.spawn

LauncherDialog        ← St.BoxLayout floating dialog
  ├── St.Entry        ← Search input with debounced handler
  ├── St.ScrollView   ← Results list with keyboard navigation
  └── Tips bar        ← Keyboard shortcut hints

prefs.js              ← Adw-based preferences window
stylesheet.css        ← Adwaita dark + Pop!_OS orange accent
schemas/              ← GSettings schema (keybinding, options)
```

## GNOME 49 & 50 Porting Notes

### What changed in GNOME 49
| API | Change | Our handling |
|---|---|---|
| `Meta.Rectangle` | Removed — use `Mtk.Rectangle` | Not used; `Mtk` imported with try/catch fallback |
| `Clutter.ClickAction` / `TapAction` | Removed | Already using `button-press-event` signal instead |
| `AppMenuButton` | Removed from panel | Not referenced |
| X11 nested debug | `gnome-shell -r` gone | Use `dbus-run-session gnome-shell --devkit --wayland` |
| `DoNotDisturbSwitch` | Removed from `calendar.js` | Not used |

### What changed in GNOME 50
| API | Change | Our handling |
|---|---|---|
| `GLib.timeout_add_once()` | New one-shot timer | Adopted via `timeoutOnce()` shim with fallback |
| `GLib.idle_add_once()` | New one-shot idle | Adopted via `idleOnce()` shim with fallback |
| `actor.easeAsync()` | Await-able animation | Adopted via `easeActor()` shim with fallback |
| `libsigcplusplus` / `graphene` | Removed | Not used |
| X11 | Fully removed | Extension is Wayland-native |

All three shims (`timeoutOnce`, `idleOnce`, `easeActor`) automatically detect the
GNOME version at runtime and call the new API when available, falling back to the
traditional approach on older shells — **zero code duplication**.



Edit `stylesheet.css` to change colors. The accent color is `#FAB84B`
(Pop!_OS orange). Change every occurrence to your preferred color.

## Adding Custom Providers

A provider is any object with:

```js
class MyProvider {
  constructor() {
    this.id = 'my-provider';
    this.priority = 5; // higher = sorted first on equal score
  }

  /** @param {string} query @returns {SearchResult[]} */
  search(query) {
    return [{
      id: 'my-provider:result-1',
      name: 'My Result',
      description: 'A description shown below the name',
      score: 50,            // 0–100, higher shown first
      iconName: 'document-symbolic',   // fallback icon
      // icon: <Clutter.Actor>, // or a rendered texture
      activate: () => { /* do something */ },
    }];
  }
}
```

Then add it to the providers array in `extension.js`:

```js
this.providers = [
  new AppProvider(),
  new MyProvider(),   // ← add here
  // ...
];
```

## Requirements

- GNOME Shell 45, 46, 47, 48, 49, or 50
- GLib, Gio, St, Clutter, Meta, Shell (all standard GNOME dependencies)
- No external Rust daemon required — everything runs in GJS

## License

GPL-2.0-or-later — GNOME Shell extensions are inherently derived works of GNOME Shell, which is licensed GPL-2.0-or-later.

Inspired by the modular architecture and pluggable providers concept of the [pop-os/launcher](https://github.com/pop-os/launcher) project (MPL-2.0), but completely and independently reimplemented in original GJS code with no borrowed source code.
