# Ormic Launcher — GNOME Shell Extension

A modular, floating application launcher for GNOME Shell **45 – 50**, inspired by the premium aesthetics and pluggable provider architecture of the COSMIC/Pop!_OS Launcher. Re-engineered in pure TypeScript and standard GJS (GNOME JavaScript), it features a fully adaptive, glassmorphic layout, custom application grouping, and responsive mouse and keyboard event handling.

---

## 🚀 Quick Install
Run the following command in your terminal to instantly download and install this release:

```bash
curl -L -o /tmp/ormic.zip https://github.com/oliwebd/ormic-launcher/releases/download/v0.1.5/ormic-launcher@github.com.zip && gnome-extensions install /tmp/ormic.zip --force && rm /tmp/ormic.zip
```

---

*Note: After installing, you may need to restart GNOME Shell (Alt+F2 -> `r` -> Enter on X11, or log out and log back in on Wayland) and ensure the extension is enabled via the `gnome-extensions enable ormic-launcher@github.com` command or the Extension Manager app.*

## Supported GNOME Versions

| Version | Distro | Status |
|---|---|---|
| GNOME 46 | Fedora 40, Ubuntu 24.04 LTS | ✅ Supported |
| GNOME 47 | Fedora 41 | ✅ Supported |
| GNOME 48 | Fedora 42, Ubuntu 25.04 | ✅ Supported |
| GNOME 49 | Ubuntu 25.10 | ✅ Supported |
| GNOME 50 | Ubuntu 26.04 LTS | ✅ Supported |

---

## Key Features & Providers

| Feature | Description | Example Query |
|---|---|---|
| **GUI Applications (GMenu)** | Scans and lists installed GUI apps recursively from GNOME's desktop entries. Caches data lazily to keep performance fast. | `gimp`, `firefox` |
| **Library Grid View** | Grid containing all installed apps, grouped into category tabs in a left sidebar. | Library Home, Office, etc. |
| **Custom App Groups** | Fully interactive group editor. Create, rename, edit, or delete groups and select which apps belong in them. | Click **Edit** (pencil) or **New Group** (+) |
| **Window Switcher (`win `)** | Instantly search for and jump to open windows by their title or WM class. Type `win ` or enter a query. | `win terminal` |
| **Favorites First** | Empty search shows your pinned **Favorite Apps** at the top of the results list. | Direct launch |
| **Secure Calculator** | Evaluates math formulas using mathjs-like capabilities. | `2 * pi * 15`, `sqrt(144)` |
| **Recent Files** | Search and open recently used files (requires at least 2 characters). | `invoice`, `screenshot.png` |
| **Terminal Commands (`> `)** | Run shell commands directly inside GNOME Shell via GLib spawning. | `> systemctl restart bluetooth` |

---

## Adaptive Design & Interaction Details

Ormic Launcher is designed to be highly adaptive and robust across multiple user input styles, layout structures, and API differences between GNOME versions:

### 1. Adaptive Compatibility Shims
The extension uses a set of runtime shims to seamlessly adapt to changes in GNOME GJS API versions (from GNOME 45 up to 50+):
- **`timeoutOnce(ms, fn)`**: Dynamically maps to the new `GLib.timeout_add_once` on modern systems, falling back to `GLib.timeout_add` on older shells.
- **`idleOnce(fn)`**: Seamlessly falls back from `GLib.idle_add_once` to `GLib.idle_add`.
- **`easeActor(actor, params)`**: Wraps `actor.easeAsync` on newer engines and transparently falls back to Clutter's traditional promise-wrapped `actor.ease` on older versions.

### 2. Sizing & Grid Layout
- **Dynamic Columns**: Displays items in a clean 9-column layout that scales to fit various display resolutions and aspect ratios.
- **Visual Sizing**: Compact design with an aspect ratio and width optimized to fit search results and the application library sidebar cleanly on both high-DPI displays and standard monitors.
- **Glassmorphic Theme & Background Styles**: Relies on a customized translucent styling system with subtle gradients, active border highlights, and CSS animations. Includes a flexible background styling system supporting Blur, various transparency levels (20%, 30%, 50%), and Solid modes to optimize performance on low-end GPUs.

### 3. Mouse Interaction & Input Grabbing
- **Input Grab Guard**: Uses GNOME Shell's `Main.pushModal` to lock input focus to the launcher. All interactive UI elements (`GridItem`, `CategoryTab`, `ResultRow`, etc.) are configured with `can_focus: false` to ensure that key-focus remains centered on the text entry at all times.
- **Low-Level Button Releases**: Because focus grabbing restricts standard high-level button clicks on unfocused widgets, all clickable items are bound directly to `button-release-event` listeners. This guarantees that mouse clicks are registered reliably under the modal grab.
- **Focus Watcher Click Guard**: An internal 300ms click guard suppresses the extension's key-focus monitor during clicks. This prevents transient focus losses (caused by mouse presses) from triggering a premature closure of the launcher before actions complete.

### 4. Sidebar Category Selection
- **Hover Switching**: Moving the mouse cursor over a sidebar category tab automatically activates it, allowing swift browsing without needing explicit clicks.
- **Scroll Support**: Use the mouse scroll wheel over the sidebar to browse categories sequentially.
- **Keyboard & Shortcuts**: Press the **Left/Right arrow keys** or the **Shift key** (when the search entry is empty) to switch active category groups instantly.

---

## Keyboard Shortcuts

| Shortcut | Action | Scope / Context |
|---|---|---|
| `Super + Space` | Toggle the launcher overlay open/closed | System-wide |
| `↑` / `↓` | Move selection up/down in list views or navigate grids | Search / Grid |
| `←` / `→` | Move selection left/right | Library Grid |
| `Enter` | Activate selected item / Submit input in dialogs | Dialog active |
| `Tab` | Autocomplete search queries | Search list |
| `Ctrl + 1..9` | Launch the corresponding 1st to 9th search result instantly | Search list |
| `Shift` (L or R) | Cycle to the next category tab | Grid mode (Empty query) |
| `Esc` | Close launcher / Quit group editor / Hide prompt overlay | Dialog active |
| *Any character* | Focuses and starts typing into the search entry | Library Grid |

---

## Project Structure & Architecture

```
ormic-launcher/
  ├── extension.ts        # Primary extension lifecycle entry point (compiles to dist/extension.js)
  │     ├── AppProvider     # Recursively indexes GUI application desktop entries
  │     ├── CalcProvider    # Secure math expression evaluator
  │     ├── RecentProvider  # Scans ~/.local/share/recently-used.xbel for file paths
  │     ├── CommandProvider # Spawns CLI commands directly inside the shell environment
  │     └── WindowProvider  # Searches and switches active window focus
  │
  ├── LauncherDialog      # Floating container component managing layout screens:
  │     ├── St.Entry        # Text input entry with key-event processing
  │     ├── St.ScrollView   # Handles result lists and grid scrolling
  │     ├── Library Grid    # App list layout categorized by categories
  │     ├── Group Editor    # Category checklist editor for custom groups
  │     └── Tips bar        # Keyboard hint overlay footer
  │
  ├── prefs.ts            # GTK/Libadwaita preferences configuration window
  ├── stylesheet.css      # Glassmorphic dark styling and Pop!_OS accent styles
  ├── metadata.json       # GNOME extension identifier and version requirements
  ├── gmenu.d.ts          # GMenu typing definitions for TypeScript
  └── schemas/            # GSettings schema definition
```

---

## Installation & Development

### 1. Build and Install (Recommended for Development)

Ensure you have `pnpm` installed.

```bash
# Compile TypeScript files, bundle schemas, and compile GSettings
make build

# Install files to your local GNOME Shell extensions directory
make install

# Restart GNOME Shell:
# - On X11: Alt + F2, type 'r', press Enter
# - On Wayland: Log out and log back in

# Enable the extension:
gnome-extensions enable ormic-launcher@github.com
```

### 2. Live Debugging
To install the extension, enable it, and tail logs in real-time, run:
```bash
make dev-install
```

### 3. Preferences Dialog
Configure extension options and maximum results:
```bash
gnome-extensions prefs ormic-launcher@github.com
```

### 4. Code Quality & Linting
Run the linter to verify code quality and style:
```bash
# Check code style and rules
make lint

# Automatically fix fixable code style and rule violations
make lint-fix
```

### 5. Packaging
Prepare a release package zip file:
```bash
make pack
```

## License

This project is licensed under the GPL-2.0-or-later license.
Inspired by the modular provider architecture of the Pop!_OS Launcher project, rewritten from scratch in TypeScript and native GJS.
