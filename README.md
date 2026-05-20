# Ormic Launcher — GNOME Shell Extension [BETA]

A modular, floating application launcher for GNOME Shell **45 – 50**, inspired by the [pop-os/launcher](https://github.com/pop-os/launcher) project architecture. Re-engineered in pure TypeScript and standard GJS, it matches the premium glassmorphic dark theme and features of the Pop!_OS Launcher window.

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

| Feature | Description | Example |
|---|---|---|
| **Apps (GMenu)** | Standard GUI apps loaded recursively from `GMenu.Tree` | `firefox`, `gimp` |
| **Library Grid View** | Switch between the search list and a full application library grid view categorized by tabs | Library Home, Office, System, etc. |
| **Custom App Groups** | Create, rename, edit, and delete custom application groups using a built-in checklist editor | Click the "+" tab or edit icon |
| **Window Switcher** | Find and focus currently open windows using title or WM class, or trigger explicitly with `win ` | `win firefox`, `terminal` |
| **Favorites First** | Empty search shows your **Favorite Apps** prioritized at the top | Direct launch |
| **Calculator** | Evaluates math expressions securely with fallback | `2 + 2`, `sqrt(144)`, `sin(90) * pi` |
| **Recent Files** | Search files you have recently opened (≥2 chars) | `report`, `screenshot` |
| **Shell Command** | Run shell commands directly with `> ` trigger | `> systemctl restart bluetooth` |

*Each search result highlights its source on the right side of the list (e.g. `Window`, `Office`, `Calc`, `Command`, `Recent`) matching the premium look of the Pop!_OS Launcher.*

## Keyboard Shortcuts

| Key | Action | Mode |
|---|---|---|
| `Super+Space` | Toggle launcher | System-wide |
| `↑` / `↓` | Navigate search results or move up/down in the library grid | Search / Grid |
| `←` / `→` | Navigate left/right in the library grid | Grid |
| `Enter` | Activate selected result / Accept modal actions | All |
| `Tab` | Auto-complete selected name | Search |
| `Ctrl + 1..9` | Quick-select and launch search results instantly | Search |
| `Esc` | Close launcher / Cancel modal editing | All |
| *Any character* | Typing automatically focuses and routes input to the search bar | Grid |

## Installation

### Method 1 — Build and Install (Recommended for Development)

Ensure you have `pnpm` installed on your machine. This method compiles the TypeScript code, bundles GSettings schemas, and installs the extension locally:

```bash
# 1. Build the extension (compiles TypeScript to dist/)
make build

# 2. Copy compiled artifacts to local GNOME directory
make install

# 3. Restart GNOME Shell
#    On Wayland: log out and log back in
#    On X11:     Alt+F2 → type 'r' → Enter

# 4. Enable the extension
gnome-extensions enable ormic-launcher@github.com
# or use GNOME Extensions / Extension Manager app
```

### Method 2 — Extension Manager (Zip Archive)

1. Build the project using `make build`.
2. Package the `dist/` directory into a `.zip` archive.
3. Open **Extension Manager**, click "Install from file" and select the `.zip` archive.
4. Toggle the extension on.

### Development & Live Debugging

For active development, you can use:
```bash
# Installs, enables the extension, and tails logs matching 'Ormic'
make dev-install
```

## Preferences

Open the Libadwaita-based settings UI with:
```bash
gnome-extensions prefs ormic-launcher@github.com
```

Or via GNOME Extensions / Extension Manager → ⚙ gear icon.

## Architecture

```
extension.ts          ← Main TypeScript entry point (compiles to dist/extension.js)
  ├── AppProvider     ← Caches and indexes GUI apps recursively via GMenu.Tree
  ├── CalcProvider    ← Evaluates math expressions
  ├── RecentProvider  ← Reads ~/.local/share/recently-used.xbel
  ├── CommandProvider ← Runs shell commands via GLib.spawn
  └── WindowProvider  ← Searches open windows via Meta.Display

LauncherDialog        ← St.BoxLayout floating dialog (Pop!_OS glassmorphic aesthetic)
  ├── St.Entry        ← Search input with debounced handler
  ├── St.ScrollView   ← Results list with keyboard navigation
  ├── Library Grid    ← Grid view of applications categorized by tabs
  ├── Group Editor    ← Checklist UI to create, rename, edit, and delete custom groups
  └── Tips bar        ← Keyboard shortcut hints

prefs.ts              ← Adw-based preferences window (Libadwaita UI)
stylesheet.css        ← COSMIC Dark + Pop!_OS orange accent (#FAB84B)
gmenu.d.ts            ← Global GMenu typings for TypeScript compilation
schemas/              ← GSettings schema (keybindings, maximum results, providers)
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

All three shims (`timeoutOnce`, `idleOnce`, `easeActor`) automatically detect the GNOME version at runtime and call the new API when available, falling back to the traditional approach on older shells — **zero code duplication**.

## Customizing styling
Edit `stylesheet.css` to change colors. The default accent color is `#FAB84B` (Pop!_OS orange). Change every occurrence to your preferred color.

## Adding Custom Providers

A provider is any object with:

```typescript
class MyProvider {
  id = 'my-provider';
  priority = 5; // higher = sorted first on equal score

  /** @param {string} query @returns {SearchResult[]} */
  search(query: string): SearchResult[] {
    return [{
      id: 'my-provider:result-1',
      name: 'My Result',
      description: 'A description shown below the name',
      score: 50,            // 0–100, higher shown first
      iconName: 'document-symbolic',   // fallback icon
      categoryIcon: 'document-symbolic',
      category: 'Custom',
      activate: () => { /* do something */ },
    }];
  }
}
```

Then add it to the providers array in `extension.ts`:

```typescript
this.providers = [
  new AppProvider(),
  new MyProvider(),   // ← add here
  // ...
];
```

## Requirements

- GNOME Shell 45, 46, 47, 48, 49, or 50
- GLib, Gio, St, Clutter, Meta, Shell, and **GMenu** (standard GNOME libraries)
- No external Rust daemon required — everything runs directly inside GNOME Shell GJS!

## License

GPL-2.0-or-later — GNOME Shell extensions are inherently derived works of GNOME Shell, which is licensed GPL-2.0-or-later.

Inspired by the modular architecture and pluggable providers concept of the [pop-os/launcher](https://github.com/pop-os/launcher) project (MPL-2.0), but completely and independently reimplemented in original TypeScript & GJS code with no borrowed source code.
