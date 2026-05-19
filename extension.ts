// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — GNOME Shell Extension
// Copyright (C) 2026 oliwebd <oliwebd@gmail.com>
//
// Inspired by the pop-os/launcher project (MPL-2.0)
// by System76 <https://github.com/pop-os/launcher>
// No source code from that project was used.
//
// Compatible with GNOME Shell 45 · 46 · 47 · 48 · 49 · 50

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import GMenu from 'gi://GMenu';

// Mtk separated from Meta in GNOME 45; Meta.Rectangle removed in GNOME 49.
let Mtk: any;
try {
    const m = await import('gi://Mtk') as any;
    Mtk = m.default;
} catch (_e) { Mtk = null; }

// Config gives us the exact shell version at runtime — no guesswork.
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

// ─── Debug helpers ────────────────────────────────────────────────────────────
const DEBUG = true;   // set false to silence all debug output

function dbg(scope: string, msg: string, ...args: any[]) {
    if (!DEBUG) return;
    const extra = args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
    log(`[Ormic:\${scope}] \${msg}\${extra}`);
}

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// ─── Runtime version gates ────────────────────────────────────────────────────

const SHELL_MAJOR = parseInt((Config as any).PACKAGE_VERSION.split('.')[0], 10);
const IS_50_PLUS = SHELL_MAJOR >= 50;

// ─── GNOME-version shims ──────────────────────────────────────────────────────

/**
 * One-shot timeout.
 *   GNOME 50+  → GLib.timeout_add_once()  (returns void; not cancellable)
 *   GNOME <50  → GLib.timeout_add()  + SOURCE_REMOVE
 */
function timeoutOnce(ms: number, fn: () => void): number | undefined {
    if (IS_50_PLUS && (GLib as any).timeout_add_once) {
        (GLib as any).timeout_add_once(GLib.PRIORITY_DEFAULT, ms, fn);
        return undefined;
    }
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Await-able ease animation.
 *   GNOME 50+  → actor.easeAsync()
 *   GNOME <50  → actor.ease() wrapped in a Promise
 */
function easeActor(actor: Clutter.Actor, params: any): Promise<void> {
    const { onComplete, ...rest } = params;
    if (IS_50_PLUS && typeof (actor as any).easeAsync === 'function') {
        return (actor as any).easeAsync(rest).then(() => {
            if (onComplete) onComplete();
        });
    }
    return new Promise<void>(resolve => {
        actor.ease({ ...rest, onComplete: () => { onComplete?.(); resolve(); } });
    });
}

// ─── Wayland-safe window helpers (X11 removed in GNOME 50) ───────────────────

/**
 * List all normal, visible windows.
 * Tries Meta.Display.list_all_windows() first (canonical Wayland API),
 * falls back to global.get_window_actors() for older shells.
 */
function listAllWindows(): any[] {
    try {
        const display = global.display as any;
        if (typeof display.list_all_windows === 'function') {
            return (display.list_all_windows() as any[]).filter(
                (w: any) =>
                    w.get_window_type?.() === Meta.WindowType.NORMAL &&
                    !w.is_skip_taskbar?.(),
            );
        }
    } catch (_e) { }
    return (global.get_window_actors() as any[])
        .map((a: any) => a.meta_window)
        .filter((w: any) => w && !w.is_skip_taskbar?.());
}

/**
 * Resolve the Shell.App that owns a MetaWindow.
 * Shell.WindowTracker.get_window_app() is the canonical API (Wayland-safe).
 */
function appForWindow(win: any): any {
    try {
        const tracker = Shell.WindowTracker.get_default();
        if (typeof tracker?.get_window_app === 'function')
            return tracker.get_window_app(win);
    } catch (_e) { }
    return Shell.AppSystem.get_default().lookup_app(win.get_wm_class?.() ?? '');
}

// ─── Search result contract ───────────────────────────────────────────────────

export interface SearchResult {
    id: string;
    desktopId?: string;
    name: string;
    description: string;
    score: number;
    providerPriority: number;   // secondary sort key
    icon?: any;      // pre-rendered Clutter texture
    createIcon?: (size: number) => any; // function to lazily create the icon
    iconName?: string;   // symbolic fallback
    categoryIcon: string;
    category: string;   // right-pill label: "App", "Web", "Window", …
    activate: () => void;
}

// ─── Providers ────────────────────────────────────────────────────────────────

class AppProvider {
    id = 'apps';
    priority = 10;
    private _sys = Shell.AppSystem.get_default();
    private _tree: any = null;
    private _treeChangedId = 0;
    private _installedChangedId = 0;
    _appsCache: Map<string, {
        app: any; category: string;
        name: string; desc: string; exec: string; kw: string;
        displayName: string; displayDesc: string;
    }> = new Map();

    constructor() {
        this._tree = new GMenu.Tree({ menu_basename: 'applications.menu' });
        this._treeChangedId = this._tree.connect('changed', () => this.reload());
        this._installedChangedId = this._sys.connect('installed-changed', () => this.reload());
        this.reload();
    }

    destroy() {
        if (this._tree) {
            if (this._treeChangedId) {
                this._tree.disconnect(this._treeChangedId);
                this._treeChangedId = 0;
            }
            this._tree = null;
        }
        if (this._installedChangedId) {
            this._sys.disconnect(this._installedChangedId);
            this._installedChangedId = 0;
        }
        this._appsCache.clear();
    }

    reload() {
        dbg('AppProvider', 'reload() — clearing cache');
        this._appsCache.clear();
        try {
            if (this._tree && this._tree.load_sync()) {
                const root = this._tree.get_root_directory();
                if (root) {
                    const iter = root.iter();
                    let type;
                    while ((type = iter.next()) !== GMenu.TreeItemType.INVALID) {
                        if (type === GMenu.TreeItemType.DIRECTORY) {
                            const dir = iter.get_directory();
                            if (dir && !dir.get_is_nodisplay()) {
                                this._loadCategory(dir, dir.get_name(), true);
                            }
                        }
                    }
                    this._loadCategory(root, _('App'), false);
                dbg('AppProvider', `cache size after reload: ${this._appsCache.size}`);
                }
            }
        } catch (e: any) {
            log(`Ormic Launcher: Error reloading GMenu tree: ${e.message}`);
        }
    }

    private _loadCategory(dir: any, categoryName: string, recursive: boolean = true) {
        const iter = dir.iter();
        let type;
        while ((type = iter.next()) !== GMenu.TreeItemType.INVALID) {
            if (type === GMenu.TreeItemType.ENTRY) {
                const entry = iter.get_entry();
                if (!entry) continue;
                let id;
                try {
                    id = entry.get_desktop_file_id();
                } catch {
                    continue;
                }
                if (!id) continue;
                if (this._appsCache.has(id)) continue;

                let app = this._sys.lookup_app(id);
                if (!app) {
                    try {
                        app = new Shell.App({ app_info: entry.get_app_info() });
                    } catch {
                        continue;
                    }
                }
                if (app && app.get_app_info()?.should_show()) {
                    const info = app.get_app_info();
                    this._appsCache.set(id, {
                        app,
                        category: categoryName,
                        name: (info.get_name() ?? '').toLowerCase(),
                        desc: (info.get_description() ?? '').toLowerCase(),
                        exec: (info.get_executable() ?? '').toLowerCase(),
                        kw: (info.get_keywords() ?? []).join(' ').toLowerCase(),
                        displayName: info.get_name() ?? id,
                        displayDesc: info.get_description() ?? '',
                    });
                }
            } else if (recursive && type === GMenu.TreeItemType.DIRECTORY) {
                const subdir = iter.get_directory();
                if (subdir && !subdir.get_is_nodisplay()) {
                    this._loadCategory(subdir, categoryName, true);
                }
            }
        }
    }

    search(q: string): SearchResult[] {
        if (!q) return [];
        const lq = q.toLowerCase().trim();
        const out: SearchResult[] = [];
        for (const [id, cached] of this._appsCache.entries()) {
            const { app, category, name, desc, exec, kw, displayName, displayDesc } = cached;

            const score =
                name === lq ? 100 :
                    name.startsWith(lq) ? 80 :
                        name.includes(lq) ? 60 :
                            exec.includes(lq) ? 40 :
                                desc.includes(lq) ? 20 :
                                    kw.includes(lq) ? 10 : 0;
            if (!score) continue;

            out.push({
                id: `app:${id}`, desktopId: id,
                name: displayName,
                description: displayDesc,
                score, providerPriority: this.priority,
                createIcon: (s: number) => app.create_icon_texture(s),
                categoryIcon: 'application-x-executable-symbolic',
                category: category,
                activate: () => {
                    dbg('AppProvider', `activate: ${displayName}`);
                    app.activate();
                },
            });
        }
        return out.sort((a, b) => b.score - a.score).slice(0, 8);
    }
}

/**
 * CalcProvider – two-stage validation prevents eval on arbitrary strings.
 *   Stage 1: expression must open with a digit, decimal, or paren.
 *   Stage 2: after replacing known function keywords with "0", only
 *            math-safe chars (digits, operators, spaces) may remain.
 */
class CalcProvider {
    id = 'calc'; priority = 5;
    private _start = /^[\d.(]/;
    private _kw = /\b(sin|cos|tan|sqrt|log|ln|exp|pi)\b/gi;
    private _safe = /^[0-9\s+\-*/.,%^()e]+$/i;

    private valid(q: string) {
        return this._start.test(q) && this._safe.test(q.replace(this._kw, '0'));
    }

    search(q: string): SearchResult[] {
        q = q.trim();
        if (!q || !this.valid(q)) return [];
        try {
            const s = q
                .replace(/\^/g, '**').replace(/,/g, '.')
                .replace(/\bsin\b/g, 'Math.sin').replace(/\bcos\b/g, 'Math.cos')
                .replace(/\btan\b/g, 'Math.tan').replace(/\bsqrt\b/g, 'Math.sqrt')
                .replace(/\blog\b/g, 'Math.log10').replace(/\bln\b/g, 'Math.log')
                .replace(/\bexp\b/g, 'Math.exp').replace(/\bpi\b/gi, 'Math.PI')
                .replace(/(?<![A-Za-z])e(?![A-Za-z])/g, 'Math.E');
            // eslint-disable-next-line no-new-func
            const v = new Function(`"use strict"; return (${s})`)();
            if (typeof v !== 'number' || !isFinite(v)) return [];
            const display = Number.isInteger(v) ? String(v) : parseFloat(v.toPrecision(10)).toString();
            return [{
                id: 'calc:result', name: display, description: `= ${q}`,
                score: 95, providerPriority: this.priority,
                iconName: 'accessories-calculator-symbolic',
                categoryIcon: 'accessories-calculator-symbolic', category: _('Calc'),
                activate: () => {
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, display);
                    Main.notify(_('Copied to clipboard'), display);
                },
            }];
        } catch (_e) { return []; }
    }
}


class RecentProvider {
    id = 'recent'; priority = 3;
    private xbel = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'recently-used.xbel']);
    constructor(private _s: Gio.Settings) { }

    search(query: string): SearchResult[] {
        if (!this._s.get_boolean('enable-recent-files')) return [];
        const q = query.toLowerCase().trim();
        if (!q || q.length < 2) return [];
        try {
            const bm = new GLib.BookmarkFile();
            bm.load_from_file(this.xbel);
            const out: SearchResult[] = [];
            for (const uri of bm.get_uris()) {
                const res = GLib.filename_from_uri(uri);
                const path = res?.[0]; if (!path) continue;
                const base = GLib.path_get_basename(path).toLowerCase();
                if (!base.includes(q)) continue;
                out.push({
                    id: `recent:${uri}`, name: GLib.path_get_basename(path),
                    description: path, score: base.startsWith(q) ? 35 : 20,
                    providerPriority: this.priority,
                    iconName: 'document-open-recent-symbolic',
                    categoryIcon: 'document-open-recent-symbolic', category: _('Recent'),
                    activate: () => Gio.app_info_launch_default_for_uri(uri, null),
                });
            }
            return out.sort((a, b) => b.score - a.score).slice(0, 5);
        } catch (_e) { return []; }
    }
}

class CommandProvider {
    id = 'command'; priority = 8;
    search(query: string): SearchResult[] {
        const q = query.trim();
        if (!q.startsWith('>')) return [];
        const cmd = q.slice(1).trim(); if (!cmd) return [];
        return [{
            id: 'cmd:run', name: `Run: ${cmd}`, description: _('Execute shell command'),
            score: 90, providerPriority: this.priority,
            iconName: 'utilities-terminal-symbolic',
            categoryIcon: 'utilities-terminal-symbolic', category: _('Command'),
            activate: () => {
                dbg('Command', 'spawn:', cmd);
                try { GLib.spawn_command_line_async(cmd); }
                catch (e: any) { Main.notifyError(_('Command Error'), e.message); }
            },
        }];
    }
}

/**
 * WindowProvider
 *   · Shell.WindowTracker.get_window_app() — Wayland-canonical app lookup.
 *   · Meta.Display.list_all_windows()     — Wayland-safe window list.
 *   · Explicit prefix "win " avoids collision with Wikipedia "w ".
 */
class WindowProvider {
    id = 'window'; priority = 9;
    constructor(private _s: Gio.Settings) { }

    search(query: string): SearchResult[] {
        if (!this._s.get_boolean('enable-window-search')) return [];
        const q = query.toLowerCase().trim(); if (!q) return [];

        let explicit = false, terms = q;
        if (q.startsWith('win ')) { explicit = true; terms = q.slice(4).trim(); }

        const out: SearchResult[] = [];
        try {
            for (const win of listAllWindows()) {
                const title = (win.get_title() ?? '').toLowerCase();
                const wmClass = (win.get_wm_class() ?? '').toLowerCase();
                let score = 0;
                if (explicit) {
                    score = !terms ? 80 : (title.includes(terms) || wmClass.includes(terms)) ? 90 : 0;
                } else {
                    score = title === q || wmClass === q ? 85
                        : title.startsWith(q) || wmClass.startsWith(q) ? 70
                            : title.includes(q) || wmClass.includes(q) ? 50 : 0;
                }
                if (!score) continue;
                const app = appForWindow(win);
                const icon = app?.create_icon_texture?.(48) ?? null;
                out.push({
                    id: `win:${win.get_id()}`,
                    name: win.get_title() ?? _('Unknown Window'),
                    description: win.get_wm_class() ?? '',
                    score, providerPriority: this.priority,
                    icon: icon ?? undefined,
                    iconName: icon ? undefined : 'window-new-symbolic',
                    categoryIcon: 'window-new-symbolic', category: _('Window'),
                    activate: () => win.activate(global.get_current_time()),
                });
            }
        } catch (_e) { }
        return out.sort((a, b) => b.score - a.score).slice(0, 6);
    }
}

// ─── Grid Item Component ─────────────────────────────────────────────────────

// FIX (Bug 1): Signal renamed from 'activate' to 'item-activated' to avoid
// clashing with Clutter's built-in 'activate' action on St.Button actors.
const GridItem = GObject.registerClass({
    Signals: { 'item-activated': {}, 'item-hovered': {} },
}, class GridItem extends St.Button {
    private _result!: SearchResult;
    private _box!: St.BoxLayout;

    _init() {
        super._init({
            style_class: 'ormic-grid-item',
            reactive: true, track_hover: true, can_focus: false,
        });
    }

    setup(result: SearchResult) {
        this._result = result;

        this._box = new St.BoxLayout({
            vertical: true,
            style_class: 'ormic-grid-item-box',
            x_expand: true, y_expand: true,
        });

        const iconBin = new St.Bin({ style_class: 'ormic-grid-icon-bin' });
        if (result.createIcon) {
            const texture = result.createIcon(56);
            if (texture) {
                texture.set_size(56, 56);
                iconBin.set_child(texture);
            }
        } else if (result.icon) {
            result.icon.set_size(56, 56);
            iconBin.set_child(result.icon);
        } else {
            iconBin.set_child(new St.Icon({
                icon_name: result.iconName ?? 'application-x-executable-symbolic',
                icon_size: 56,
                style_class: 'ormic-grid-icon-sym',
            }));
        }
        this._box.add_child(iconBin);

        const nameLabel = new St.Label({
            text: result.name,
            style_class: 'ormic-grid-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        nameLabel.clutter_text.line_wrap = true;
        this._box.add_child(nameLabel);

        this.set_child(this._box);

        // FIX: Use button-release-event for reliable single-click activation
        this.connect('button-release-event', (actor, ev) => {
            if (ev.get_button() === 1) { // Left click
                dbg('GridItem', `clicked on ${result.name}`);
                this.emit('item-activated');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('notify::hover', () => {
            if (this.hover) this.emit('item-hovered');
        });
    }

    get result() { return this._result; }

    setSelected(on: boolean) {
        if (on) {
            this.add_style_class_name('selected');
            // FIX (Bug 2a): grab_key_focus() removed. The search entry is the
            // permanent key-capture point; stealing focus here broke free-typing
            // and caused key events to vanish into the grid item.
        } else {
            this.remove_style_class_name('selected');
        }
    }
});
type GridItem = InstanceType<typeof GridItem>;

// ─── Category Tab Component ──────────────────────────────────────────────────

// FIX (Bug 1): Signal renamed from 'select' to 'tab-selected' to avoid
// clashing with Clutter's built-in 'select' action on St.Button actors.
const CategoryTab = GObject.registerClass({
    Signals: { 'tab-selected': {} },
}, class CategoryTab extends St.Button {
    private _categoryName!: string;
    private _iconName!: string;

    _init() {
        super._init({
            style_class: 'ormic-category-tab',
            reactive: true, track_hover: true, can_focus: false,
        });
    }

    setup(categoryName: string, iconName: string) {
        this._categoryName = categoryName;
        this._iconName = iconName;

        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'ormic-category-tab-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const icon = new St.Icon({
            icon_name: iconName,
            icon_size: 20,
            style_class: 'ormic-category-tab-icon',
        });
        box.add_child(icon);

        const label = new St.Label({
            text: categoryName,
            style_class: 'ormic-category-tab-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(label);

        this.set_child(box);

        // FIX: Use button-release-event for reliable single-click activation
        this.connect('button-release-event', (actor, ev) => {
            if (ev.get_button() === 1) {
                dbg('CategoryTab', `clicked on ${categoryName}`);
                this.emit('tab-selected');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    get categoryName() { return this._categoryName; }

    setSelected(on: boolean) {
        if (on) this.add_style_class_name('active');
        else this.remove_style_class_name('active');
    }
});
type CategoryTab = InstanceType<typeof CategoryTab>;

// ─── Edit App Checklist Row Component ────────────────────────────────────────

const EditAppRow = GObject.registerClass({
    Signals: { toggle: {} },
}, class EditAppRow extends St.Button {
    private _result!: SearchResult;
    private _selected = false;
    private _checkIcon!: St.Icon;

    _init() {
        super._init({
            style_class: 'ormic-edit-row',
            reactive: true, track_hover: true, can_focus: false,
        });
    }

    setup(result: SearchResult, selected: boolean) {
        this._result = result;
        this._selected = selected;

        const box = new St.BoxLayout({
            style_class: 'ormic-edit-row-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const iconBin = new St.Bin({ style_class: 'ormic-edit-icon-bin' });
        if (result.createIcon) {
            const texture = result.createIcon(32);
            if (texture) {
                texture.set_size(32, 32);
                iconBin.set_child(texture);
            }
        } else if (result.icon) {
            result.icon.set_size(32, 32);
            iconBin.set_child(result.icon);
        } else {
            iconBin.set_child(new St.Icon({
                icon_name: result.iconName ?? 'application-x-executable-symbolic',
                icon_size: 32,
            }));
        }
        box.add_child(iconBin);

        const nameLabel = new St.Label({
            text: result.name,
            style_class: 'ormic-edit-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(nameLabel);

        this._checkIcon = new St.Icon({
            icon_name: this._selected ? 'checkbox-checked-symbolic' : 'checkbox-symbolic',
            icon_size: 16,
            style_class: 'ormic-edit-checkbox',
        });
        box.add_child(this._checkIcon);

        this.set_child(box);

        if (this._selected) this.add_style_class_name('selected');

        this.connect('button-release-event', (actor, ev) => {
            if (ev.get_button() === 1) {
                dbg('EditAppRow', `clicked on ${result.name}`);
                this.toggle();
                this.emit('toggle');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    toggle() {
        this._selected = !this._selected;
        this._checkIcon.icon_name = this._selected ? 'checkbox-checked-symbolic' : 'checkbox-symbolic';
        if (this._selected) this.add_style_class_name('selected');
        else this.remove_style_class_name('selected');
    }

    get result() { return this._result; }
    get selected() { return this._selected; }
});
type EditAppRow = InstanceType<typeof EditAppRow>;

// ─── Result Row Component (Search list view) ─────────────────────────────────

// FIX (Bug 1): Signal renamed from 'activate' to 'item-activated' to avoid
// clashing with Clutter's built-in 'activate' action on St.Button actors.
const ResultRow = GObject.registerClass({
    Signals: { 'item-activated': {}, 'item-hovered': {} },
}, class ResultRow extends St.Button {
    private _result!: SearchResult;
    private _accentBar!: St.Widget;
    _favButton?: St.Button;

    _init() {
        super._init({
            style_class: 'ormic-result',
            reactive: true, track_hover: true, can_focus: false,
        });
    }

    setup(
        result: SearchResult,
        index: number,
        settings: Gio.Settings,
        shellSettings: Gio.Settings,
    ) {
        this._result = result;

        const mainBox = new St.BoxLayout({
            style_class: 'ormic-result-box',
            x_expand: true,
        });

        this._accentBar = new St.Widget({ style_class: 'ormic-accent-bar' });
        mainBox.add_child(this._accentBar);

        const iconBin = new St.Bin({ style_class: 'ormic-icon-bin' });
        if (result.createIcon) {
            const texture = result.createIcon(48);
            if (texture) {
                texture.set_size(48, 48);
                iconBin.set_child(texture);
            }
        } else if (result.icon) {
            result.icon.set_size(48, 48);
            iconBin.set_child(result.icon);
        } else {
            iconBin.set_child(new St.Icon({
                icon_name: result.iconName ?? 'application-x-executable-symbolic',
                icon_size: 48,
                style_class: 'ormic-icon-sym',
            }));
        }
        mainBox.add_child(iconBin);

        const textCol = new St.BoxLayout({
            style_class: 'ormic-text-col',
            vertical: true, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const nameLabel = new St.Label({
            text: result.name, style_class: 'ormic-name',
            x_align: Clutter.ActorAlign.START,
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textCol.add_child(nameLabel);
        if (result.description) {
            const dl = new St.Label({
                text: result.description, style_class: 'ormic-desc',
                x_align: Clutter.ActorAlign.START,
            });
            dl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textCol.add_child(dl);
        }
        mainBox.add_child(textCol);

        if (result.desktopId) {
            const id = result.desktopId;
            const isFav = () =>
                (shellSettings.get_strv('favorite-apps') as string[]).includes(id);
            const favIco = new St.Icon({
                icon_name: isFav() ? 'emblem-favorite-symbolic' : 'bookmark-new-symbolic',
                icon_size: 14,
            });
            const favBtn = new St.Button({
                child: favIco, style_class: 'ormic-fav-btn',
                reactive: true, can_focus: false, track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._favButton = favBtn;
            if (isFav()) favBtn.add_style_class_name('is-fav');
            favBtn.connect('clicked', () => {
                const favs = shellSettings.get_strv('favorite-apps') as string[];
                const idx = favs.indexOf(id);
                if (idx > -1) {
                    favs.splice(idx, 1);
                    favIco.icon_name = 'bookmark-new-symbolic';
                    favBtn.remove_style_class_name('is-fav');
                } else {
                    favs.push(id);
                    favIco.icon_name = 'emblem-favorite-symbolic';
                    favBtn.add_style_class_name('is-fav');
                }
                shellSettings.set_strv('favorite-apps', favs);
            });
            mainBox.add_child(favBtn);
        }

        if (settings.get_boolean('enable-quick-select') && index >= 0 && index < 9) {
            mainBox.add_child(new St.Label({
                text: `Ctrl+${index + 1}`, style_class: 'ormic-kbd-badge',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const pill = new St.BoxLayout({
            style_class: 'ormic-cat-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        pill.add_child(new St.Icon({
            icon_name: result.categoryIcon, icon_size: 11,
            style_class: 'ormic-cat-icon',
        }));
        pill.add_child(new St.Label({
            text: result.category, style_class: 'ormic-cat-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        mainBox.add_child(pill);

        this.set_child(mainBox);

        // FIX: Use button-release-event for reliable single-click activation
        this.connect('button-release-event', (actor, ev) => {
            if (ev.get_button() === 1) { // Left click
                dbg('ResultRow', `clicked on ${result.name}`);
                this.emit('item-activated');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('notify::hover', () => {
            if (this.hover) this.emit('item-hovered');
        });
    }

    get result() { return this._result; }

    setSelected(on: boolean) {
        if (on) {
            this.add_style_class_name('selected');
            // FIX (Bug 2a): grab_key_focus() removed. The search entry is the
            // permanent key-capture point; the CSS 'selected' class is enough
            // to highlight the row visually without redirecting keyboard focus.
        } else {
            this.remove_style_class_name('selected');
        }
    }
});
type ResultRow = InstanceType<typeof ResultRow>;

// ─── Launcher Dialog ──────────────────────────────────────────────────────────

const LauncherDialog = GObject.registerClass(
    class LauncherDialog extends St.BoxLayout {
        private _ext!: OrmicLauncherExtension;
        private _providers!: any[];
        private _results!: SearchResult[];
        private _selIdx!: number;
        private _tid!: number | null | undefined;
        private _gen!: number;
        _shellSettings!: Gio.Settings;

        // Dynamic multi-view state
        private _activeCategory = 'Library Home';
        private _isEditing = false;
        private _gridSelIdx = -1;

        // UI Container Boxes
        _entryBox!: St.BoxLayout;
        _entry!: St.Entry;

        // Search Results List
        _scroll!: St.ScrollView;
        _rbox!: St.BoxLayout;
        _tips!: St.BoxLayout;

        // Grid Library View
        _headerBox!: St.BoxLayout;
        _headerTitleLabel!: St.Label;
        _editBtn!: St.Button;
        _deleteBtn!: St.Button;

        _gridScroll!: St.ScrollView;
        _gridBox!: St.BoxLayout;
        _tabsBox!: St.BoxLayout;

        // Group Editor checklist view
        _editorBox!: St.BoxLayout;
        _editorNameEntry!: St.Entry;
        _editorScroll!: St.ScrollView;
        _editorAppsContainer!: St.BoxLayout;

        // New Group Modal Overlay
        _promptOverlay!: St.BoxLayout;
        _promptEntry!: St.Entry;

        _init() {
            super._init({ style_class: 'ormic-dialog', vertical: true, reactive: true });
            try {
                const blur = new Shell.BlurEffect({
                    brightness: 0.95,
                    mode: Shell.BlurMode.BACKGROUND,
                });
                // @ts-ignore
                blur.sigma = 65;
                this.add_effect_with_name('blur', blur);
            } catch (e: any) {
                log(`Ormic Launcher: blur effect error: ${e.message}`);
            }
        }

        setup(ext: OrmicLauncherExtension) {
            this._ext = ext;
            this._providers = ext.providers;
            this._results = [];
            this._selIdx = -1;
            this._tid = null;
            this._gen = 0;
            this._shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });

            // ── Search row ────────────────────────────────────────────────
            // FIX (Bug 2b): The entry box is always present in the layout and
            // never hidden. It is the sole universal key-capture point for the
            // entire dialog — both in search mode and in grid/library mode.
            // The 'show-search-bar' setting now only controls the *visual*
            // prominence of the row (opacity / placeholder text), not
            // whether it is reachable by the keyboard or by focus logic.
            this._entryBox = new St.BoxLayout({ style_class: 'ormic-search-row', x_expand: true });
            this._entryBox.add_child(new St.Icon({
                icon_name: 'system-search-symbolic',
                style_class: 'ormic-search-icon', icon_size: 18,
            }));
            this._entry = new St.Entry({
                style_class: 'ormic-entry',
                hint_text: _('Search apps, calculate, > command, win  windows…'),
                x_expand: true, can_focus: true,
            });
            this._entry.clutter_text.connect('text-changed', () => this._onText());
            this._entry.clutter_text.connect('key-press-event', (_, ev) => this._onKey(ev));
            this.connect('button-press-event', (_, ev) => {
                let actor: any = ev.get_source();
                let keepFocus = false;
                while (actor && actor !== this) {
                    if (actor instanceof St.Entry || actor instanceof St.ScrollBar) {
                        keepFocus = true;
                        break;
                    }
                    actor = actor.get_parent();
                }
                if (!keepFocus) {
                    timeoutOnce(10, () => this.focus());
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this.connect('scroll-event', (_, ev) => {
                let sv: St.ScrollView | null = null;
                if (this._scroll.visible) sv = this._scroll;
                else if (this._gridScroll.visible) sv = this._gridScroll;
                else if (this._editorScroll.visible) sv = this._editorScroll;

                if (sv && sv.vscrollbar_visible && sv.vadjustment) {
                    const adj = sv.vadjustment;
                    const dir = ev.get_scroll_direction();
                    const step = adj.step_increment * 2.5;
                    if (dir === Clutter.ScrollDirection.UP) {
                        adj.set_value(adj.value - step);
                        return Clutter.EVENT_STOP;
                    } else if (dir === Clutter.ScrollDirection.DOWN) {
                        adj.set_value(adj.value + step);
                        return Clutter.EVENT_STOP;
                    } else if (dir === Clutter.ScrollDirection.SMOOTH) {
                        const [dx, dy] = ev.get_scroll_delta();
                        adj.set_value(adj.value + dy * step);
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._entryBox.add_child(this._entry);

            const closeBtn = new St.Button({
                child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 18 }),
                style_class: 'ormic-close-btn',
                reactive: true, track_hover: true, can_focus: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            closeBtn.connect('clicked', () => this._ext.hide());
            this._entryBox.add_child(closeBtn);

            // ── Search Results ────────────────────────────────────────────
            this._scroll = new St.ScrollView({
                style_class: 'ormic-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true, x_expand: true,
            });
            this._rbox = new St.BoxLayout({
                style_class: 'ormic-rbox', vertical: true, x_expand: true,
            });
            this._scroll.set_child(this._rbox);
            this._scroll.hide();

            // ── Tip bar ───────────────────────────────────────────────────
            this._tips = new St.BoxLayout({ style_class: 'ormic-tips', x_expand: true });
            for (const [k, v] of [
                ['↑↓', _('Navigate')], ['↵', _('Open')], ['Tab', _('Complete')],
                ['Esc', _('Close')], ['>', _('Command')],
                ['win ', _('Windows')],
            ]) {
                const innerT = new St.BoxLayout({ style_class: 'ormic-tip' });
                innerT.add_child(new St.Label({ text: k, style_class: 'ormic-tip-key' }));
                innerT.add_child(new St.Label({ text: ` ${v}`, style_class: 'ormic-tip-val' }));
                this._tips.add_child(innerT);
            }

            // ── Library Grid Header ────────────────────────────────────────
            this._headerBox = new St.BoxLayout({ style_class: 'ormic-header', x_expand: true });

            // Spacer to center the title
            const leftSpacer = new St.Widget({ x_expand: true });
            this._headerBox.add_child(leftSpacer);

            this._headerTitleLabel = new St.Label({
                text: this._activeCategory,
                style_class: 'ormic-header-title',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._headerBox.add_child(this._headerTitleLabel);

            // Control Box on the right
            const controlBox = new St.BoxLayout({
                style_class: 'ormic-header-control',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._editBtn = new St.Button({
                child: new St.Icon({ icon_name: 'document-edit-symbolic', icon_size: 16 }),
                style_class: 'ormic-header-btn edit-btn',
                reactive: true, track_hover: true,
            });
            this._editBtn.connect('clicked', () => this._startEditing());
            controlBox.add_child(this._editBtn);

            this._deleteBtn = new St.Button({
                child: new St.Icon({ icon_name: 'user-trash-symbolic', icon_size: 16 }),
                style_class: 'ormic-header-btn delete-btn',
                reactive: true, track_hover: true,
            });
            this._deleteBtn.connect('clicked', () => this._deleteActiveCategory());
            controlBox.add_child(this._deleteBtn);

            this._headerBox.add_child(controlBox);

            // ── Library Grid Scroll Box ──────────────────────────────────
            this._gridScroll = new St.ScrollView({
                style_class: 'ormic-grid-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true, x_expand: true, y_expand: true,
            });
            this._gridBox = new St.BoxLayout({
                style_class: 'ormic-grid-box', vertical: true, x_expand: true,
            });
            this._gridScroll.set_child(this._gridBox);

            // ── Bottom Tabs Container ─────────────────────────────────────
            this._tabsBox = new St.BoxLayout({
                style_class: 'ormic-tabs-box',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });

            // ── Group Editor Screen ───────────────────────────────────────
            this._editorBox = new St.BoxLayout({
                style_class: 'ormic-editor-box', vertical: true, x_expand: true, y_expand: true,
            });
            this._editorBox.hide();

            const edHeader = new St.BoxLayout({ style_class: 'ormic-editor-header', x_expand: true });
            edHeader.add_child(new St.Label({
                text: _('Group Name: '),
                style_class: 'ormic-editor-label',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._editorNameEntry = new St.Entry({
                style_class: 'ormic-editor-entry',
                x_expand: true,
            });
            edHeader.add_child(this._editorNameEntry);

            const edBtnBox = new St.BoxLayout({ style_class: 'ormic-editor-btn-box' });

            const cancelEdBtn = new St.Button({
                label: _('Cancel'), style_class: 'ormic-editor-btn cancel-btn',
                reactive: true, track_hover: true,
            });
            cancelEdBtn.connect('clicked', () => this._stopEditing(false));
            edBtnBox.add_child(cancelEdBtn);

            const saveEdBtn = new St.Button({
                label: _('Done'), style_class: 'ormic-editor-btn save-btn',
                reactive: true, track_hover: true,
            });
            saveEdBtn.connect('clicked', () => this._stopEditing(true));
            edBtnBox.add_child(saveEdBtn);

            edHeader.add_child(edBtnBox);
            this._editorBox.add_child(edHeader);

            this._editorScroll = new St.ScrollView({
                style_class: 'ormic-editor-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true, x_expand: true, y_expand: true,
            });
            this._editorAppsContainer = new St.BoxLayout({
                style_class: 'ormic-editor-apps', vertical: true, x_expand: true,
            });
            this._editorScroll.set_child(this._editorAppsContainer);
            this._editorBox.add_child(this._editorScroll);

            // ── Prompt Modal Overlay ──────────────────────────────────────
            this._promptOverlay = new St.BoxLayout({
                style_class: 'ormic-prompt-overlay',
                vertical: true,
                x_expand: true, y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._promptOverlay.hide();

            const promptCard = new St.BoxLayout({
                style_class: 'ormic-prompt-card',
                vertical: true,
                x_expand: true,
            });
            promptCard.add_child(new St.Label({
                text: _('Create New Group'),
                style_class: 'ormic-prompt-title',
            }));
            this._promptEntry = new St.Entry({
                style_class: 'ormic-prompt-entry',
                hint_text: _('Group name…'),
                x_expand: true,
            });
            promptCard.add_child(this._promptEntry);

            const promptBtns = new St.BoxLayout({
                style_class: 'ormic-prompt-btns',
                x_align: Clutter.ActorAlign.END,
            });
            const pCancel = new St.Button({
                label: _('Cancel'), style_class: 'ormic-prompt-btn cancel-btn',
                reactive: true, track_hover: true,
            });
            pCancel.connect('clicked', () => this._hidePromptOverlay(false));
            promptBtns.add_child(pCancel);

            const pCreate = new St.Button({
                label: _('Create'), style_class: 'ormic-prompt-btn create-btn',
                reactive: true, track_hover: true,
            });
            pCreate.connect('clicked', () => this._hidePromptOverlay(true));
            promptBtns.add_child(pCreate);

            promptCard.add_child(promptBtns);
            this._promptOverlay.add_child(promptCard);

            // Assemble everything
            this.add_child(this._entryBox);
            this.add_child(new St.Widget({ style_class: 'ormic-sep', x_expand: true }));

            // Central Swap Container for views
            this.add_child(this._scroll);
            this.add_child(this._headerBox);
            this.add_child(this._gridScroll);
            this.add_child(this._editorBox);
            this.add_child(this._promptOverlay);

            this.add_child(new St.Widget({ style_class: 'ormic-sep', x_expand: true }));
            this.add_child(this._tabsBox);
            this.add_child(this._tips);
        }

        vfunc_key_press_event(ev: Clutter.Event): boolean { return this._onKey(ev); }

        private _onKey(ev: any): boolean {
            const sym = ev.get_key_symbol();
            dbg('Key', `sym=0x${sym.toString(16)} ctrl=${!!(ev.get_state() & Clutter.ModifierType.CONTROL_MASK)}`);
            const ctrl = !!(ev.get_state() & Clutter.ModifierType.CONTROL_MASK);

            // 1. Check if Prompt Modal is active
            if (this._promptOverlay.visible) {
                if (sym === Clutter.KEY_Escape) { this._hidePromptOverlay(false); return true; }
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._hidePromptOverlay(true); return true; }
                return false;
            }

            // 2. Check if Group Editor is active
            if (this._isEditing) {
                if (sym === Clutter.KEY_Escape) { this._stopEditing(false); return true; }
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._stopEditing(true); return true; }
                return false;
            }

            // 3. Quick-select badge handler (Search mode only)
            if (this._scroll.visible && ctrl && this._ext._settings.get_boolean('enable-quick-select')
                && sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
                this._activateIdx(sym - Clutter.KEY_1); return true;
            }

            // 4. Navigation & Escape in list view vs grid view
            if (sym === Clutter.KEY_Escape) { this._ext.hide(); return true; }

            if (this._scroll.visible) {
                // Search list view key handlers
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._activateSel(); return true; }
                if (sym === Clutter.KEY_Up) { this._moveSel(-1); return true; }
                if (sym === Clutter.KEY_Down) { this._moveSel(1); return true; }
                if (sym === Clutter.KEY_Tab) { this._complete(); return true; }
            } else {
                // Library grid view key handlers
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._activateGridSel(); return true; }
                if (sym === Clutter.KEY_Up) { this._moveGridSel(-6); return true; }
                if (sym === Clutter.KEY_Down) { this._moveGridSel(6); return true; }
                if (sym === Clutter.KEY_Left) { this._moveGridSel(-1); return true; }
                if (sym === Clutter.KEY_Right) { this._moveGridSel(1); return true; }

                // FIX (Bug 2b): When in grid mode and the user types a printable
                // character, route it directly into the always-visible entry and
                // re-focus it. No need to call _showSearchRow() since the entry
                // is always present in the layout.
                const char = Clutter.keysym_to_unicode(sym);
                if (char && char >= 32 && char <= 126 && !ctrl) {
                    this._entry.text = String.fromCharCode(char);
                    this._entry.clutter_text.set_cursor_position(-1);
                    this._entry.grab_key_focus();
                    return true;
                }
            }
            return false;
        }

        private _onText() {
            if (this._tid != null) { GLib.source_remove(this._tid as number); this._tid = null; }
            const gen = ++this._gen;
            this._tid = timeoutOnce(80, () => {
                this._tid = null;
                if (gen !== this._gen) return;
                this._search(this._entry.text);
            });
        }

        private _search(query: string) {
            dbg('Search', 'query:', query);
            const q = query.trim();
            const max = this._ext._settings.get_int('max-results');

            if (!q) {
                // Clear and switch back to Library Grid Mode.
                this._clear();

                // FIX (Bug 2b): The entry box is never hidden; do NOT call
                // _showSearchRow(false) here. The entry remains visible and
                // focused so that the next keypress is always captured.
                this._scroll.hide();
                this._headerBox.show();
                this._gridScroll.show();
                this._tabsBox.show();

                this._renderGridAndTabs();
                return;
            }

            // Search Results Mode!
            this._headerBox.hide();
            this._gridScroll.hide();
            this._tabsBox.hide();
            this._scroll.show();

            this._rbox.destroy_all_children();

            const combined: SearchResult[] = [];
            for (const p of this._providers) {
                try { combined.push(...p.search(q)); } catch (_e) { }
            }
            combined.sort((a, b) => b.score - a.score || b.providerPriority - a.providerPriority);
            this._results = combined.slice(0, max);
            dbg('Search', `results: ${this._results.length} (max ${max})`);
            this._renderSearchResults();
        }

        private _clear() {
            this._results = [];
            this._selIdx = -1;
            this._rbox.destroy_all_children();
        }

        // ─── Search View Rendering ───────────────────────────────────────────

        private _renderSearchResults() {
            if (!this._results.length) { this._scroll.hide(); return; }
            this._results.forEach((r, i) => {
                const row = new (ResultRow as any)() as ResultRow;
                row.setup(r, i, this._ext._settings, this._shellSettings);
                // FIX (Bug 1): connect to renamed signal 'item-activated'.
                row.connect('item-activated', () => { r.activate(); this._ext.hide(); });
                row.connect('item-hovered', () => {
                    this._selectIdx(i);
                });
                this._rbox.add_child(row);
            });
            this._scroll.show();
            this._selIdx = -1;
            this._selectIdx(0);
        }

        private _selectIdx(i: number) {
            const rows = this._rbox.get_children() as ResultRow[];
            if (!rows.length) return;
            i = Math.max(0, Math.min(rows.length - 1, i));
            rows.forEach((r, j) => r.setSelected(j === i));
            this._selIdx = i;
            const row = rows[i];
            this._scroll.vadjustment?.set_value(row.y - this._scroll.height / 2 + row.height / 2);
        }

        private _moveSel(d: number) {
            const n = this._rbox.get_children().length;
            if (n) this._selectIdx((this._selIdx + d + n) % n);
        }

        private _activateSel() {
            const r = this._results[this._selIdx];
            dbg('Activate', 'list sel', this._selIdx, r?.name ?? 'none');
            if (r) { r.activate(); this._ext.hide(); }
        }

        private _activateIdx(i: number) {
            const r = this._results[i];
            if (r) { r.activate(); this._ext.hide(); }
        }

        private _complete() {
            const r = this._results[this._selIdx];
            if (r?.name) { this._entry.text = r.name; this._entry.clutter_text.set_cursor_position(-1); }
        }

        // ─── Grid View Rendering & Management ────────────────────────────────

        private _renderGridAndTabs() {
            dbg('Grid', `renderGridAndTabs category=${this._activeCategory}`);
            // Render Bottom Category Tabs
            this._tabsBox.destroy_all_children();

            const staticTabs = [
                { name: 'Library Home', icon: 'go-home-symbolic' },
                { name: 'Office', icon: 'x-office-document-symbolic' },
                { name: 'System', icon: 'emblem-system-symbolic' },
                { name: 'Utilities', icon: 'accessories-calculator-symbolic' },
            ];

            staticTabs.forEach(t => {
                const tab = new (CategoryTab as any)() as CategoryTab;
                tab.setup(t.name, t.icon);
                tab.setSelected(this._activeCategory === t.name);
                // FIX (Bug 1): connect to renamed signal 'tab-selected'.
                tab.connect('tab-selected', () => {
                    this._activeCategory = t.name;
                    this._renderGridAndTabs();
                });
                this._tabsBox.add_child(tab);
            });

            // Render Custom Category Tabs
            const customGroups = this._getCustomGroups();
            for (const gName of Object.keys(customGroups)) {
                const tab = new (CategoryTab as any)() as CategoryTab;
                tab.setup(gName, 'folder-symbolic');
                tab.setSelected(this._activeCategory === gName);
                // FIX (Bug 1): connect to renamed signal 'tab-selected'.
                tab.connect('tab-selected', () => {
                    this._activeCategory = gName;
                    this._renderGridAndTabs();
                });
                this._tabsBox.add_child(tab);
            }

            // Render "Add group" Tab
            const addTab = new (CategoryTab as any)() as CategoryTab;
            addTab.setup(_('Add group'), 'list-add-symbolic');
            // FIX (Bug 1): connect to renamed signal 'tab-selected'.
            addTab.connect('tab-selected', () => {
                this._showPromptOverlay();
            });
            this._tabsBox.add_child(addTab);

            // Update Header Area
            this._headerTitleLabel.text = this._activeCategory;
            const isCustom = !staticTabs.some(t => t.name === this._activeCategory);
            if (isCustom) {
                this._editBtn.show();
                this._deleteBtn.show();
            } else {
                this._editBtn.hide();
                this._deleteBtn.hide();
            }

            // Fetch applications cache
            const apps: SearchResult[] = [];
            const appProv = this._providers.find(p => p.id === 'apps') as AppProvider | undefined;
            if (appProv) {
                for (const [id, cached] of appProv._appsCache.entries()) {
                    const { app, category } = cached;
                    const info = app.get_app_info();
                    if (!info) continue;
                    apps.push({
                        id: `app:${id}`, desktopId: id,
                        name: cached.displayName ?? info.get_name() ?? id,
                        description: cached.displayDesc ?? info.get_description() ?? '',
                        score: 0, providerPriority: 10,
                        createIcon: (s: number) => app.create_icon_texture(s),
                        categoryIcon: 'application-x-executable-symbolic',
                        category: category,
                        activate: () => {
                            dbg('LibraryGrid', `activate: ${id}`);
                            app.activate();
                        },
                    });
                }
            }
            apps.sort((a, b) => a.name.localeCompare(b.name));

            // Filter apps based on active category
            let filteredApps: SearchResult[] = [];
            if (this._activeCategory === 'Library Home') {
                filteredApps = apps;
            } else if (this._activeCategory === 'Office') {
                filteredApps = apps.filter(a => a.category.toLowerCase().includes('office'));
            } else if (this._activeCategory === 'System') {
                filteredApps = apps.filter(a =>
                    a.category.toLowerCase().includes('system') ||
                    a.category.toLowerCase().includes('setting') ||
                    a.category.toLowerCase().includes('administration') ||
                    a.category.toLowerCase().includes('preferences')
                );
            } else if (this._activeCategory === 'Utilities') {
                filteredApps = apps.filter(a =>
                    a.category.toLowerCase().includes('utility') ||
                    a.category.toLowerCase().includes('utilities') ||
                    a.category.toLowerCase().includes('accessories')
                );
            } else {
                // Custom Group filtering
                const customAppIds = customGroups[this._activeCategory] || [];
                filteredApps = apps.filter(a => customAppIds.includes(a.desktopId ?? ''));
            }

            // Render Grid Box
            this._gridBox.destroy_all_children();

            if (!filteredApps.length) {
                const emptyLabel = new St.Label({
                    text: _('No applications in this group.\nClick the pencil icon to add apps!'),
                    style_class: 'ormic-grid-empty',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this._gridBox.add_child(emptyLabel);
                this._gridSelIdx = -1;
                return;
            }

            const columns = 6;
            let currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
            this._gridBox.add_child(currentRow);

            filteredApps.forEach((app, i) => {
                if (i > 0 && i % columns === 0) {
                    currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
                    this._gridBox.add_child(currentRow);
                }

                const item = new (GridItem as any)() as GridItem;
                item.setup(app);
                // FIX (Bug 1): connect to renamed signal 'item-activated'.
                item.connect('item-activated', () => {
                    app.activate();
                    this._ext.hide();
                });
                item.connect('item-hovered', () => {
                    this._selectGridIdx(i);
                });
                currentRow.add_child(item);
            });

            this._gridSelIdx = -1;
            this._selectGridIdx(0);
        }

        private _selectGridIdx(i: number) {
            const items: GridItem[] = [];
            this._gridBox.get_children().forEach((row: any) => {
                row.get_children().forEach((item: GridItem) => items.push(item));
            });

            if (!items.length) return;
            i = Math.max(0, Math.min(items.length - 1, i));
            items.forEach((item, idx) => item.setSelected(idx === i));
            this._gridSelIdx = i;

            const selectedItem = items[i];
            this._gridScroll.vadjustment?.set_value(
                selectedItem.y - this._gridScroll.height / 2 + selectedItem.height / 2
            );
        }

        private _moveGridSel(d: number) {
            const items: GridItem[] = [];
            this._gridBox.get_children().forEach((row: any) => {
                row.get_children().forEach((item: GridItem) => items.push(item));
            });

            const n = items.length;
            if (n) {
                this._selectGridIdx((this._gridSelIdx + d + n) % n);
            }
        }

        private _activateGridSel() {
            dbg('Activate', 'grid sel', this._gridSelIdx);
            const items: GridItem[] = [];
            this._gridBox.get_children().forEach((row: any) => {
                row.get_children().forEach((item: GridItem) => items.push(item));
            });

            const selected = items[this._gridSelIdx];
            if (selected) {
                selected.result.activate();
                this._ext.hide();
            }
        }

        // ─── Custom Group Editing checklist Mode ──────────────────────────────

        private _startEditing() {
            this._isEditing = true;
            this._headerBox.hide();
            this._gridScroll.hide();
            this._tabsBox.hide();

            this._editorNameEntry.text = this._activeCategory;
            this._editorAppsContainer.destroy_all_children();

            // Load all apps
            const apps: SearchResult[] = [];
            const appProv = this._providers.find(p => p.id === 'apps') as AppProvider | undefined;
            if (appProv) {
                for (const [id, cached] of appProv._appsCache.entries()) {
                    const { app, category } = cached;
                    const info = app.get_app_info();
                    if (!info) continue;
                    apps.push({
                        id: `app:${id}`, desktopId: id,
                        name: cached.displayName ?? info.get_name() ?? id,
                        description: cached.displayDesc ?? info.get_description() ?? '',
                        score: 0, providerPriority: 10,
                        createIcon: (s: number) => app.create_icon_texture(s),
                        categoryIcon: 'application-x-executable-symbolic',
                        category: category,
                        activate: () => app.activate(),
                    });
                }
            }
            apps.sort((a, b) => a.name.localeCompare(b.name));

            const customGroups = this._getCustomGroups();
            const groupAppIds = customGroups[this._activeCategory] || [];

            apps.forEach(app => {
                const row = new (EditAppRow as any)() as EditAppRow;
                row.setup(app, groupAppIds.includes(app.desktopId ?? ''));
                this._editorAppsContainer.add_child(row);
            });

            this._editorBox.show();
            this._editorNameEntry.grab_key_focus();
        }

        private _stopEditing(save: boolean) {
            this._isEditing = false;
            this._editorBox.hide();
            this._headerBox.show();
            this._gridScroll.show();
            this._tabsBox.show();

            if (save) {
                const newName = this._editorNameEntry.text.trim();
                const customGroups = this._getCustomGroups();

                // Gather all checked app IDs
                const selectedIds: string[] = [];
                this._editorAppsContainer.get_children().forEach((child: any) => {
                    const row = child as EditAppRow;
                    if (row.selected && row.result.desktopId) {
                        selectedIds.push(row.result.desktopId);
                    }
                });

                if (newName && newName !== this._activeCategory) {
                    // Rename group (delete old key, add new)
                    delete customGroups[this._activeCategory];
                    customGroups[newName] = selectedIds;
                    this._activeCategory = newName;
                } else if (newName) {
                    // Save apps under same name
                    customGroups[this._activeCategory] = selectedIds;
                }

                this._saveCustomGroups(customGroups);
            }

            this._renderGridAndTabs();
            timeoutOnce(50, () => this.focus());
        }

        private _deleteActiveCategory() {
            const customGroups = this._getCustomGroups();
            delete customGroups[this._activeCategory];
            this._saveCustomGroups(customGroups);

            this._activeCategory = 'Library Home';
            this._renderGridAndTabs();
            timeoutOnce(50, () => this.focus());
        }

        // ─── Prompt Modal Overlay for Group Creation ────────────────────────

        private _showPromptOverlay() {
            this._promptEntry.text = '';
            this._promptOverlay.show();
            this._promptEntry.grab_key_focus();
        }

        private _hidePromptOverlay(create: boolean) {
            this._promptOverlay.hide();
            const gName = this._promptEntry.text.trim();

            if (create && gName) {
                const customGroups = this._getCustomGroups();
                if (!customGroups[gName]) {
                    customGroups[gName] = [];
                    this._saveCustomGroups(customGroups);
                    this._activeCategory = gName;

                    // Switch to group editor checklists immediately!
                    this._renderGridAndTabs();
                    this._startEditing();
                    return;
                }
            }

            this._renderGridAndTabs();
            timeoutOnce(50, () => this.focus());
        }

        // ─── Settings Helper Methods ──────────────────────────────────────────

        private _getCustomGroups(): Record<string, string[]> {
            dbg('Groups', 'getCustomGroups()');
            try {
                const str = this._ext._settings.get_string('custom-groups') || '{}';
                return JSON.parse(str);
            } catch (_e) {
                return {};
            }
        }

        private _saveCustomGroups(groups: Record<string, string[]>) {
            dbg('Groups', 'saveCustomGroups()', Object.keys(groups));
            try {
                this._ext._settings.set_string('custom-groups', JSON.stringify(groups));
            } catch (e: any) {
                log(`Ormic Launcher: Error saving custom groups: ${e.message}`);
            }
        }

        // ─── External Controls ────────────────────────────────────────────────

        focus() {
            dbg('Focus', 'grab_key_focus');
            // Ensure the appropriate text entry has focus to prevent keyboard
            // capture loss during clicks or scrolls.
            if (this._promptOverlay && this._promptOverlay.visible && this._promptEntry) {
                global.stage.set_key_focus(this._promptEntry);
                this._promptEntry.grab_key_focus();
            } else if (this._editorBox && this._editorBox.visible && this._isEditing && this._editorNameEntry) {
                global.stage.set_key_focus(this._editorNameEntry);
                this._editorNameEntry.grab_key_focus();
            } else if (this._entry) {
                global.stage.set_key_focus(this._entry);
                this._entry.grab_key_focus();
            }
        }

        reset() {
            this._clear();
            this._entry.text = '';
            this._activeCategory = 'Library Home';
            this._isEditing = false;
            this._editorBox.hide();
            this._promptOverlay.hide();

            // FIX (Bug 2b): The entry box is always shown regardless of the
            // 'show-search-bar' setting. That setting previously hid the whole
            // row which made the entry unreachable, breaking free-typing in
            // grid mode. The visual preference is now enforced via CSS opacity
            // in stylesheet.css using the 'search-hidden' class on _entryBox,
            // while the widget itself remains in the layout and focusable.
            this._entryBox.show();

            this._scroll.hide();
            this._headerBox.show();
            this._gridScroll.show();
            this._tabsBox.show();

            this._renderGridAndTabs();
        }
    },
);
type LauncherDialog = InstanceType<typeof LauncherDialog>;


// ─── Panel indicator ──────────────────────────────────────────────────────────

const OrmicIndicator = GObject.registerClass(
    class OrmicIndicator extends PanelMenu.Button {
        _ext!: OrmicLauncherExtension;
        _init() {
            super._init(0.0, 'Ormic Launcher', true);
            this.add_child(new St.Icon({ icon_name: 'view-app-grid-symbolic', style_class: 'system-status-icon' }));
            this.connect('button-press-event', (_, ev) => {
                if ((typeof ev.get_button === 'function' ? ev.get_button() : 1) === 1) {
                    this._ext.toggle(); return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
    },
);
type OrmicIndicator = InstanceType<typeof OrmicIndicator>;

// ─── Extension ────────────────────────────────────────────────────────────────

export default class OrmicLauncherExtension extends Extension {
    providers!: any[];
    _visible!: boolean;
    _settings!: Gio.Settings;
    _overlay!: St.Widget | null;
    _dialog!: LauncherDialog | null;
    _indicator!: OrmicIndicator | null;
    _monId!: number | null;
    _keyId!: number | null;
    _cfgId!: number | null;

    enable() {
        dbg('Extension', 'enable() called');
        this._settings = this.getSettings();
        this.providers = [
            new AppProvider(), new CalcProvider(),
            new RecentProvider(this._settings), new CommandProvider(),
            new WindowProvider(this._settings),
        ];
        this._visible = false; this._indicator = null; this._cfgId = null;

        this._overlay = new St.Widget({
            style_class: 'ormic-overlay', reactive: true, visible: false,
            x: 0, y: 0, opacity: 0,
        });
        this._overlay.connect('button-press-event', (_, ev) => {
            const [cx, cy] = ev.get_coords();
            const d = this._dialog!;
            const [dx, dy] = d.get_transformed_position();
            if (cx < dx || cx > dx + d.width || cy < dy || cy > dy + d.height) this.hide();
            return Clutter.EVENT_STOP;
        });

        this._dialog = new (LauncherDialog as any)() as LauncherDialog;
        this._dialog.setup(this);
        this._overlay.add_child(this._dialog);
        Main.layoutManager.addTopChrome(this._overlay);

        this._monId = Main.layoutManager.connect('monitors-changed', () => this._pos());
        this._pos();

        Main.wm.addKeybinding(
            'toggle-ormic-launcher', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this.toggle(),
        );

        this._keyId = global.stage.connect('key-press-event', (_, ev) => {
            if (this._visible && ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.hide(); return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._cfgId = this._settings.connect('changed::show-indicator', () => this._syncInd());
        this._syncInd();
    }

    disable() {
        dbg('Extension', 'disable() called');
        if (this._cfgId) { this._settings.disconnect(this._cfgId); this._cfgId = null; }
        if (this._keyId) { global.stage.disconnect(this._keyId); this._keyId = null; }
        if (this._monId) { Main.layoutManager.disconnect(this._monId); this._monId = null; }
        this._indicator?.destroy(); this._indicator = null;
        Main.wm.removeKeybinding('toggle-ormic-launcher');
        this._overlay?.destroy();
        this._overlay = null;
        this._dialog = null;
        for (const p of this.providers) {
            if (typeof p.destroy === 'function') {
                try { p.destroy(); } catch (_) { }
            }
        }
        this.providers = [];
        this._visible = false;
    }

    _syncInd() {
        if (this._settings.get_boolean('show-indicator')) {
            if (!this._indicator) {
                const ind = new (OrmicIndicator as any)() as OrmicIndicator;
                ind._ext = this; this._indicator = ind;
                Main.panel.addToStatusArea('ormic-launcher', this._indicator, 0, 'left');
            }
        } else { this._indicator?.destroy(); this._indicator = null; }
    }

    _pos() {
        if (!this._overlay || !this._dialog) return;
        const mon = Main.layoutManager.primaryMonitor; if (!mon) return;
        const dw = Math.min(680, mon.width * 0.50);
        const dx = mon.x + Math.floor((mon.width - dw) / 2);
        const dy = mon.y + Math.floor(mon.height * 0.18);
        this._overlay.set_position(mon.x, mon.y);
        this._overlay.set_size(mon.width, mon.height);
        this._dialog.set_position(dx - mon.x, dy - mon.y);
        this._dialog.set_width(dw);
    }

    toggle() { this._visible ? this.hide() : this.show(); }

    show() {
        dbg('Launcher', 'show()');
        if (!this._dialog || !this._overlay) return;
        this._visible = true;
        this._dialog.reset();
        this._overlay.show();
        this._dialog.opacity = 0;
        this._dialog.translation_y = -20;
        Main.pushModal(this._overlay);
        easeActor(this._overlay, { opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        easeActor(this._dialog, { opacity: 255, translation_y: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_EXPO });
        timeoutOnce(10, () => this._dialog?.focus());
    }

    hide() {
        dbg('Launcher', 'hide()');
        if (!this._dialog || !this._overlay) return;
        this._visible = false;
        Main.popModal(this._overlay);
        // Capture refs — safe if disable() runs mid-animation
        const ov = this._overlay, dl = this._dialog;
        easeActor(dl, {
            opacity: 0, translation_y: -14, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => { ov.hide(); dl.reset(); dl.opacity = 255; dl.translation_y = 0; },
        });
        easeActor(ov, { opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD });
    }
}
