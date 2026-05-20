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
    log(`[Ormic:${scope}] ${msg}${extra}`);
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

// ─── Scroll helper ────────────────────────────────────────────────────────────

/**
 * Scroll a St.ScrollView so that `actor` is visible.
 * Uses ensure_actor_visible when available (GNOME 40+), otherwise
 * falls back to manual vadjustment arithmetic.
 */
function scrollToActor(scrollView: St.ScrollView, actor: Clutter.Actor) {
    try {
        // Preferred API — available on all supported shells (40+)
        if (typeof (scrollView as any).ensure_actor_visible === 'function') {
            (scrollView as any).ensure_actor_visible(actor);
            return;
        }
    } catch (_e) { /* fall through */ }

    // Manual fallback: compute actor's y offset relative to the scroll viewport
    try {
        const adj = scrollView.vadjustment;
        if (!adj) return;

        // Transform actor position into the scroll content's coordinate space
        const [ax, ay] = actor.get_transformed_position();
        const [, svy] = scrollView.get_transformed_position();

        const relY = ay - svy + adj.value;
        const viewHeight = scrollView.height;
        const actorHeight = actor.height;

        if (relY < adj.value) {
            adj.set_value(relY - 8);
        } else if (relY + actorHeight > adj.value + viewHeight) {
            adj.set_value(relY + actorHeight - viewHeight + 8);
        }
    } catch (_e) { /* nothing to do */ }
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
    private _dirty = true;

    get dirty(): boolean {
        return this._dirty;
    }

    _appsCache: Map<string, {
        app: any; category: string;
        name: string; desc: string; exec: string; kw: string;
        displayName: string; displayDesc: string;
    }> = new Map();

    constructor() {
        this._tree = new GMenu.Tree({ menu_basename: 'applications.menu' });
        this._treeChangedId = this._tree.connect('changed', () => {
            dbg('AppProvider', 'tree changed — marking dirty');
            this._dirty = true;
        });
        this._installedChangedId = this._sys.connect('installed-changed', () => {
            dbg('AppProvider', 'installed-changed — marking dirty');
            this._dirty = true;
        });
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

    onOpen() {
        if (this._dirty) {
            this.reload();
        }
    }

    reload() {
        dbg('AppProvider', 'reload() — clearing cache');
        this._dirty = false;
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
        if (this._dirty) {
            this.reload();
        }
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
    private _cachedRecent: { uri: string; name: string; path: string }[] = [];

    constructor(private _s: Gio.Settings) {
        this.onOpen();
    }

    onOpen() {
        if (!this._s.get_boolean('enable-recent-files')) {
            this._cachedRecent = [];
            return;
        }
        try {
            const bm = new GLib.BookmarkFile();
            bm.load_from_file(this.xbel);
            const items: { uri: string; name: string; path: string }[] = [];
            for (const uri of bm.get_uris()) {
                const res = GLib.filename_from_uri(uri);
                const path = res?.[0];
                if (!path) continue;
                const base = GLib.path_get_basename(path);
                items.push({ uri, name: base, path });
            }
            this._cachedRecent = items;
        } catch (_e) {
            this._cachedRecent = [];
        }
    }

    search(query: string): SearchResult[] {
        if (!this._s.get_boolean('enable-recent-files')) return [];
        const q = query.toLowerCase().trim();
        if (!q || q.length < 2) return [];
        const out: SearchResult[] = [];
        for (const item of this._cachedRecent) {
            const base = item.name.toLowerCase();
            if (!base.includes(q)) continue;
            out.push({
                id: `recent:${item.uri}`,
                name: item.name,
                description: item.path,
                score: base.startsWith(q) ? 35 : 20,
                providerPriority: this.priority,
                iconName: 'document-open-recent-symbolic',
                categoryIcon: 'document-open-recent-symbolic',
                category: _('Recent'),
                activate: () => Gio.app_info_launch_default_for_uri(item.uri, null),
            });
        }
        return out.sort((a, b) => b.score - a.score).slice(0, 5);
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
            const texture = result.createIcon(44);
            if (texture) {
                texture.set_size(44, 44);
                iconBin.set_child(texture);
            }
        } else if (result.icon) {
            result.icon.set_size(44, 44);
            iconBin.set_child(result.icon);
        } else {
            iconBin.set_child(new St.Icon({
                icon_name: result.iconName ?? 'application-x-executable-symbolic',
                icon_size: 44,
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

        this.connect('button-release-event', (actor, ev) => {
            if (ev.get_button() === 1) {
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
        } else {
            this.remove_style_class_name('selected');
        }
    }
});
type GridItem = InstanceType<typeof GridItem>;

// ─── Category Tab Component ──────────────────────────────────────────────────

const CategoryTab = GObject.registerClass({
    Signals: { 'tab-selected': {}, 'tab-hovered': {} },
}, class CategoryTab extends St.Button {
    private _categoryName!: string;
    private _iconName!: string;

    _init() {
        super._init({
            style_class: 'ormic-category-tab',
            reactive: true, track_hover: true, can_focus: false,
            x_expand: true, x_align: Clutter.ActorAlign.FILL,
        });

        this.connect('notify::hover', () => {
            if (this.hover) this.emit('tab-hovered');
        });
    }

    setup(categoryName: string, iconName: string) {
        this._categoryName = categoryName;
        this._iconName = iconName;

        const box = new St.BoxLayout({
            vertical: false,
            style_class: 'ormic-category-tab-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const icon = new St.Icon({
            icon_name: iconName,
            icon_size: 16,
            style_class: 'ormic-category-tab-icon',
        });
        box.add_child(icon);

        const label = new St.Label({
            text: categoryName,
            style_class: 'ormic-category-tab-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(label);

        this.set_child(box);

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
            favBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
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
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
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

        this.connect('button-release-event', (actor, ev) => {
            if (ev.get_button() === 1) {
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
        private _gridItemsCache!: Map<string, GridItem>;
        private _categoryGridBoxes!: Map<string, St.BoxLayout>;
        private _allAppsCache!: SearchResult[];
        private _allAppsCacheDirty!: boolean;

        // Dynamic multi-view state
        private _activeCategory = 'Library Home';
        private _isEditing = false;
        private _gridSelIdx = -1;

        get _gridBox(): St.BoxLayout {
            let box = this._categoryGridBoxes.get(this._activeCategory);
            if (!box) {
                box = new St.BoxLayout({
                    style_class: 'ormic-grid-box', vertical: true, x_expand: true,
                });
                this._categoryGridBoxes.set(this._activeCategory, box);
            }
            return box;
        }

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
        _tabsBox!: St.BoxLayout;
        _vsep!: St.Widget;

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
            this._gridItemsCache = new Map();
            this._categoryGridBoxes = new Map();
            this._allAppsCache = [];
            this._allAppsCacheDirty = true;

            // ── Search row ────────────────────────────────────────────────
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

            // ── Click outside dialog to close ─────────────────────────────
            // FIX: We handle click-to-close in the overlay actor (in OrmicLauncherExtension),
            // NOT here in the dialog's button-press-event. Handling it here caused issues
            // because the dialog consumed events before they bubbled up, and coordinate
            // math relative to the overlay was unreliable.
            //
            // Instead, we only handle clicks on non-interactive areas of the DIALOG itself
            // to restore focus to the entry (e.g. clicking on padding/margins).
            this.connect('button-press-event', (_, ev) => {
                // Set click guard on the extension to prevent key-focus watcher from closing the dialog
                this._ext._setClickGuard();

                // Walk up from click source — if it's not an interactive widget,
                // restore focus to the search entry.
                let actor: any = ev.get_source();
                let isInteractive = false;
                while (actor && actor !== (this as any)) {
                    const cName = actor.constructor?.name || '';
                    if (actor instanceof St.Entry ||
                        actor instanceof St.ScrollBar ||
                        actor instanceof St.Button ||
                        cName.includes('Button') ||
                        cName.includes('Entry') ||
                        cName.includes('ScrollBar') ||
                        cName.includes('Tab') ||
                        cName.includes('Row') ||
                        cName.includes('Item')) {
                        isInteractive = true;
                        break;
                    }
                    actor = actor.get_parent?.();
                }
                if (!isInteractive) {
                    timeoutOnce(10, () => this.focus());
                }
                // Always PROPAGATE — never stop clicks from reaching the overlay
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
            closeBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._ext.hide();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
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

            const leftSpacer = new St.Widget({ x_expand: true });
            this._headerBox.add_child(leftSpacer);

            this._headerTitleLabel = new St.Label({
                text: this._activeCategory,
                style_class: 'ormic-header-title',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._headerBox.add_child(this._headerTitleLabel);

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
            this._editBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._startEditing();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            controlBox.add_child(this._editBtn);

            this._deleteBtn = new St.Button({
                child: new St.Icon({ icon_name: 'user-trash-symbolic', icon_size: 16 }),
                style_class: 'ormic-header-btn delete-btn',
                reactive: true, track_hover: true,
            });
            this._deleteBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._deleteActiveCategory();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            controlBox.add_child(this._deleteBtn);

            this._headerBox.add_child(controlBox);

            // ── Library Grid Scroll Box ──────────────────────────────────
            this._gridScroll = new St.ScrollView({
                style_class: 'ormic-grid-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true, x_expand: true, y_expand: true,
            });
            // gridBox will be added to gridScroll dynamically in _selectCategory/_renderGridAndTabs

            // ── Left Sidebar Tabs Container ───────────────────────────────
            this._tabsBox = new St.BoxLayout({
                style_class: 'ormic-tabs-box',
                vertical: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.FILL,
                reactive: true,
            });
            this._tabsBox.connect('scroll-event', (_, ev) => {
                const dir = ev.get_scroll_direction();
                let delta = 0;
                if (dir === Clutter.ScrollDirection.UP) {
                    delta = -1;
                } else if (dir === Clutter.ScrollDirection.DOWN) {
                    delta = 1;
                } else if (dir === Clutter.ScrollDirection.SMOOTH) {
                    const [dx, dy] = ev.get_scroll_delta();
                    if (dy < 0) delta = -1;
                    else if (dy > 0) delta = 1;
                }

                if (delta !== 0) {
                    const cats = this._getCategoriesList();
                    const idx = cats.indexOf(this._activeCategory);
                    if (idx > -1) {
                        const n = cats.length;
                        this._selectCategory(cats[(idx + delta + n) % n]);
                        this.focus();
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._vsep = new St.Widget({ style_class: 'ormic-vsep', y_expand: true });

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
            cancelEdBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._stopEditing(false);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            edBtnBox.add_child(cancelEdBtn);

            const saveEdBtn = new St.Button({
                label: _('Done'), style_class: 'ormic-editor-btn save-btn',
                reactive: true, track_hover: true,
            });
            saveEdBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._stopEditing(true);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
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
                reactive: true,
            });
            this._promptOverlay.hide();

            const promptCard = new St.BoxLayout({
                style_class: 'ormic-prompt-card',
                vertical: true,
                x_expand: true,
                reactive: true,
            });
            try {
                const blur = new Shell.BlurEffect({
                    brightness: 0.90,
                    mode: Shell.BlurMode.BACKGROUND,
                });
                // @ts-ignore
                blur.sigma = 40;
                promptCard.add_effect_with_name('blur', blur);
            } catch (e: any) {
                log(`Ormic Launcher: prompt card blur error: ${e.message}`);
            }

            // Click outside the card (but on the overlay) to cancel
            this._promptOverlay.connect('button-press-event', (_, ev) => {
                const [x, y] = ev.get_coords();
                const [success, lx, ly] = promptCard.transform_stage_point(x, y);
                const insideCard = success && lx >= 0 && lx <= promptCard.width && ly >= 0 && ly <= promptCard.height;
                if (!insideCard) {
                    this._hidePromptOverlay(false);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
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
            pCancel.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._hidePromptOverlay(false);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            promptBtns.add_child(pCancel);

            const pCreate = new St.Button({
                label: _('Create'), style_class: 'ormic-prompt-btn create-btn',
                reactive: true, track_hover: true,
            });
            pCreate.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._hidePromptOverlay(true);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            promptBtns.add_child(pCreate);

            promptCard.add_child(promptBtns);
            this._promptOverlay.add_child(promptCard);

            // Assemble everything
            this.add_child(this._entryBox);
            this.add_child(new St.Widget({ style_class: 'ormic-sep', x_expand: true }));

            const contentContainer = new St.BoxLayout({
                style_class: 'ormic-content-container',
                x_expand: true, y_expand: true,
            });

            this._tabsBox.vertical = true;
            this._tabsBox.x_expand = false;
            this._tabsBox.y_expand = true;
            this._tabsBox.x_align = Clutter.ActorAlign.START;
            this._tabsBox.y_align = Clutter.ActorAlign.FILL;
            contentContainer.add_child(this._tabsBox);

            contentContainer.add_child(this._vsep);

            const rightPanel = new St.BoxLayout({
                style_class: 'ormic-right-panel',
                vertical: true,
                x_expand: true, y_expand: true,
            });
            rightPanel.add_child(this._scroll);
            rightPanel.add_child(this._headerBox);
            rightPanel.add_child(this._gridScroll);
            rightPanel.add_child(this._editorBox);
            rightPanel.add_child(this._promptOverlay);

            contentContainer.add_child(rightPanel);
            this.add_child(contentContainer);

            this.add_child(new St.Widget({ style_class: 'ormic-sep', x_expand: true }));
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

            // Shift key category change
            if (!this._scroll.visible && this._entry.text === '' && (sym === Clutter.KEY_Shift_L || sym === Clutter.KEY_Shift_R)) {
                const cats = this._getCategoriesList();
                const idx = cats.indexOf(this._activeCategory);
                if (idx > -1) {
                    this._selectCategory(cats[(idx + 1) % cats.length]);
                    this.focus();
                    return true;
                }
            }

            // 4. Navigation & Escape
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
                if (sym === Clutter.KEY_Up) { this._moveGridSel(-7); return true; }
                if (sym === Clutter.KEY_Down) { this._moveGridSel(7); return true; }
                if (sym === Clutter.KEY_Left) { this._moveGridSel(-1); return true; }
                if (sym === Clutter.KEY_Right) { this._moveGridSel(1); return true; }

                // When in grid mode and the user types a printable character,
                // route it directly into the always-visible entry and re-focus it.
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

        private _setTabsVisible(visible: boolean) {
            if (visible) {
                this._tabsBox.show();
                this._vsep.show();
            } else {
                this._tabsBox.hide();
                this._vsep.hide();
            }
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
                this._clear();
                this._scroll.hide();
                this._headerBox.show();
                this._gridScroll.show();
                this._setTabsVisible(true);
                this._renderGridAndTabs();
                return;
            }

            // Search Results Mode
            this._headerBox.hide();
            this._gridScroll.hide();
            this._setTabsVisible(false);
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
                row.connect('item-activated', () => { this._ext.hide(); r.activate(); });
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

            // FIX: Use the robust scrollToActor helper instead of manual y math.
            // The old code used row.y (relative to parent) and scroll height
            // which gave wrong offsets — items would jump or not scroll at all.
            scrollToActor(this._scroll, rows[i]);
        }

        private _moveSel(d: number) {
            const n = this._rbox.get_children().length;
            if (n) this._selectIdx((this._selIdx + d + n) % n);
        }

        private _activateSel() {
            const r = this._results[this._selIdx];
            dbg('Activate', 'list sel', this._selIdx, r?.name ?? 'none');
            if (r) { this._ext.hide(); r.activate(); }
        }

        private _activateIdx(i: number) {
            const r = this._results[i];
            if (r) { this._ext.hide(); r.activate(); }
        }

        private _complete() {
            const r = this._results[this._selIdx];
            if (r?.name) { this._entry.text = r.name; this._entry.clutter_text.set_cursor_position(-1); }
        }

        // ─── Grid View Rendering & Management ────────────────────────────────

        private _collectGridItems(): GridItem[] {
            const items: GridItem[] = [];
            const gridBox = this._gridBox;
            gridBox.get_children().forEach((row: any) => {
                if (row.get_children) {
                    row.get_children().forEach((item: GridItem) => items.push(item));
                }
            });
            return items;
        }

        private _ensureAllAppsCache() {
            if (!this._allAppsCacheDirty && this._allAppsCache.length > 0) return;
            this._allAppsCacheDirty = false;

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
            this._allAppsCache = apps;
        }

        private _selectCategory(categoryName: string) {
            if (this._activeCategory === categoryName) return;
            this._activeCategory = categoryName;

            // 1. Update tabs selected state without rebuilding them
            const tabs = this._tabsBox.get_children() as CategoryTab[];
            tabs.forEach(tab => {
                if (typeof tab.setSelected === 'function') {
                    tab.setSelected(tab.categoryName === categoryName);
                }
            });

            // 2. Update Header Area
            this._headerTitleLabel.text = this._activeCategory;
            const staticTabs = ['Library Home', 'Office', 'System', 'Utilities'];
            const isCustom = !staticTabs.includes(this._activeCategory);
            if (isCustom) {
                this._editBtn.show();
                this._deleteBtn.show();
            } else {
                this._editBtn.hide();
                this._deleteBtn.hide();
            }

            // 3. Swap the grid box in ScrollView
            const hasCachedGrid = this._categoryGridBoxes.has(categoryName);
            const gridBox = this._gridBox;
            this._gridScroll.set_child(gridBox);

            // 4. Render only if not already cached/rendered
            if (!hasCachedGrid) {
                this._renderGridOnly();
            } else {
                this._gridSelIdx = -1;
                timeoutOnce(10, () => {
                    if (this._gridSelIdx === -1 && this._gridScroll.visible) {
                        this._selectGridIdx(0);
                    }
                });
            }
        }

        private _renderGridOnly() {
            this._ensureAllAppsCache();

            // Filter apps based on active category
            let filteredApps: SearchResult[] = [];
            if (this._activeCategory === 'Library Home') {
                filteredApps = this._allAppsCache;
            } else if (this._activeCategory === 'Office') {
                filteredApps = this._allAppsCache.filter(a => a.category.toLowerCase().includes('office'));
            } else if (this._activeCategory === 'System') {
                filteredApps = this._allAppsCache.filter(a =>
                    a.category.toLowerCase().includes('system') ||
                    a.category.toLowerCase().includes('setting') ||
                    a.category.toLowerCase().includes('administration') ||
                    a.category.toLowerCase().includes('preferences')
                );
            } else if (this._activeCategory === 'Utilities') {
                filteredApps = this._allAppsCache.filter(a =>
                    a.category.toLowerCase().includes('utility') ||
                    a.category.toLowerCase().includes('utilities') ||
                    a.category.toLowerCase().includes('accessories')
                );
            } else {
                const customGroups = this._getCustomGroups();
                const customAppIds = customGroups[this._activeCategory] || [];
                filteredApps = this._allAppsCache.filter(a => customAppIds.includes(a.desktopId ?? ''));
            }

            // Render Grid Box
            const gridBox = this._gridBox;
            gridBox.get_children().forEach((row: any) => {
                if (row.get_children) {
                    row.get_children().forEach((child: any) => {
                        row.remove_child(child);
                    });
                }
            });
            gridBox.destroy_all_children();
            this._gridSelIdx = -1;

            if (!filteredApps.length) {
                const emptyLabel = new St.Label({
                    text: _('No applications in this group.\nClick the pencil icon to add apps!'),
                    style_class: 'ormic-grid-empty',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                gridBox.add_child(emptyLabel);
                return;
            }

            const columns = 7;
            let currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
            gridBox.add_child(currentRow);

            filteredApps.forEach((app, i) => {
                if (i > 0 && i % columns === 0) {
                    currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
                    gridBox.add_child(currentRow);
                }

                let item = this._gridItemsCache.get(app.id);
                if (!item) {
                    const newItem = new (GridItem as any)() as GridItem;
                    newItem.setup(app);
                    newItem.connect('item-activated', () => {
                        this._ext.hide();
                        app.activate();
                    });
                    newItem.connect('item-hovered', () => {
                        const allItems = this._collectGridItems();
                        const idx = allItems.indexOf(newItem);
                        if (idx >= 0) this._selectGridIdx(idx);
                    });
                    this._gridItemsCache.set(app.id, newItem);
                    item = newItem;
                }
                currentRow.add_child(item);
            });

            timeoutOnce(50, () => {
                if (this._gridSelIdx === -1 && this._gridScroll.visible) {
                    this._selectGridIdx(0);
                }
            });
        }

        private _renderGridAndTabs() {
            dbg('Grid', `renderGridAndTabs category=${this._activeCategory}`);

            // Clear category grid boxes cache on categories/tabs structure changes
            if (this._categoryGridBoxes) {
                this._categoryGridBoxes.forEach(box => box.destroy());
                this._categoryGridBoxes.clear();
            }
            if (this._gridItemsCache) {
                this._gridItemsCache.clear();
            }

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
                tab.connect('tab-selected', () => {
                    this._selectCategory(t.name);
                    this.focus();
                });
                tab.connect('tab-hovered', () => {
                    this._selectCategory(t.name);
                    this.focus();
                });
                this._tabsBox.add_child(tab);
            });

            // Render Custom Category Tabs
            const customGroups = this._getCustomGroups();
            for (const gName of Object.keys(customGroups)) {
                const tab = new (CategoryTab as any)() as CategoryTab;
                tab.setup(gName, 'folder-symbolic');
                tab.setSelected(this._activeCategory === gName);
                tab.connect('tab-selected', () => {
                    this._selectCategory(gName);
                    this.focus();
                });
                tab.connect('tab-hovered', () => {
                    this._selectCategory(gName);
                    this.focus();
                });
                this._tabsBox.add_child(tab);
            }

            // Render "Add group" Tab
            const addTab = new (CategoryTab as any)() as CategoryTab;
            addTab.setup(_('Add group'), 'list-add-symbolic');
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

            // Set grid child from cache or render
            const gridBox = this._gridBox;
            this._gridScroll.set_child(gridBox);

            if (this._categoryGridBoxes.size <= 1) {
                // If it's a fresh/dirty load, defer rendering slightly to allow opening animations to run buttery smooth
                timeoutOnce(20, () => {
                    if (this._activeCategory === 'Library Home') {
                        this._renderGridOnly();
                    }
                });
            } else {
                this._gridSelIdx = -1;
                timeoutOnce(10, () => {
                    if (this._gridSelIdx === -1 && this._gridScroll.visible) {
                        this._selectGridIdx(0);
                    }
                });
            }
        }

        private _selectGridIdx(i: number) {
            const items = this._collectGridItems();
            if (!items.length) return;
            i = Math.max(0, Math.min(items.length - 1, i));
            items.forEach((item, idx) => item.setSelected(idx === i));
            this._gridSelIdx = i;

            // FIX: Use the robust scrollToActor helper (same fix as list view).
            scrollToActor(this._gridScroll, items[i]);
        }

        private _moveGridSel(d: number) {
            const items = this._collectGridItems();
            const n = items.length;
            if (n) {
                this._selectGridIdx((this._gridSelIdx + d + n) % n);
            }
        }

        private _activateGridSel() {
            dbg('Activate', 'grid sel', this._gridSelIdx);
            const items = this._collectGridItems();
            const selected = items[this._gridSelIdx];
            if (selected) {
                this._ext.hide();
                selected.result.activate();
            }
        }

        // ─── Custom Group Editing checklist Mode ──────────────────────────────

        private _startEditing() {
            this._isEditing = true;
            this._headerBox.hide();
            this._gridScroll.hide();
            this._setTabsVisible(false);

            this._editorNameEntry.text = this._activeCategory;
            this._editorAppsContainer.destroy_all_children();

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
            this._setTabsVisible(true);

            if (save) {
                const newName = this._editorNameEntry.text.trim();
                const customGroups = this._getCustomGroups();

                const selectedIds: string[] = [];
                this._editorAppsContainer.get_children().forEach((child: any) => {
                    const row = child as EditAppRow;
                    if (row.selected && row.result.desktopId) {
                        selectedIds.push(row.result.desktopId);
                    }
                });

                if (newName && newName !== this._activeCategory) {
                    delete customGroups[this._activeCategory];
                    customGroups[newName] = selectedIds;
                    this._activeCategory = newName;
                } else if (newName) {
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

                    this._renderGridAndTabs();
                    this._startEditing();
                    return;
                }
            }

            this._renderGridAndTabs();
            timeoutOnce(50, () => this.focus());
        }

        // ─── Settings Helper Methods ──────────────────────────────────────────

        private _getCategoriesList(): string[] {
            const list = ['Library Home', 'Office', 'System', 'Utilities'];
            const customGroups = this._getCustomGroups();
            for (const gName of Object.keys(customGroups)) {
                list.push(gName);
            }
            return list;
        }

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
            // Check if application list is dirty on app provider BEFORE calling onOpen() (which resets it)
            const appProv = this._providers?.find(p => p.id === 'apps') as AppProvider | undefined;
            const isAppsDirty = appProv ? appProv.dirty : false;

            if (this._providers) {
                for (const p of this._providers) {
                    try {
                        if (typeof p.onOpen === 'function') {
                            p.onOpen();
                        }
                    } catch (e: any) {
                        log(`Ormic Launcher: Error calling onOpen on provider: ${e.message}`);
                    }
                }
            }

            // Invalidate caches if the apps changed or maps are empty
            if (isAppsDirty || this._allAppsCacheDirty || this._categoryGridBoxes.size === 0) {
                dbg('Performance', `Invalidating caches. Reason: isAppsDirty=${isAppsDirty}, allAppsCacheDirty=${this._allAppsCacheDirty}, categoryGridBoxesSize=${this._categoryGridBoxes.size}`);
                this._allAppsCacheDirty = true;
                if (this._gridItemsCache) {
                    this._gridItemsCache.clear();
                }
                if (this._categoryGridBoxes) {
                    this._categoryGridBoxes.forEach(box => box.destroy());
                    this._categoryGridBoxes.clear();
                }
            } else {
                dbg('Performance', 'Reusing cached category grid boxes (0ms layout change)');
            }

            this._clear();
            this._entry.text = '';
            this._activeCategory = 'Library Home';
            this._isEditing = false;
            this._gridSelIdx = -1;
            this._editorBox.hide();
            this._promptOverlay.hide();

            this._entryBox.show();

            this._scroll.hide();
            this._headerBox.show();
            this._gridScroll.show();
            this._setTabsVisible(true);

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
    _isModal = false;
    _clickGuard = false;
    _clickGuardTimer: number | null | undefined = null;
    _settings!: Gio.Settings;
    _overlay!: St.Widget | null;
    _dialog!: LauncherDialog | null;
    _indicator!: OrmicIndicator | null;
    _monId!: number | null;
    _keyId!: number | null;
    _cfgId!: number | null;
    _focusId!: number | null;

    enable() {
        dbg('Extension', 'enable() called');
        this._settings = this.getSettings();
        this.providers = [
            new AppProvider(), new CalcProvider(),
            new RecentProvider(this._settings), new CommandProvider(),
            new WindowProvider(this._settings),
        ];
        this._visible = false; this._indicator = null; this._cfgId = null; this._focusId = null;

        this._overlay = new St.Widget({
            style_class: 'ormic-overlay', reactive: true, visible: false,
            x: 0, y: 0, opacity: 0,
        });

        // Set click guard on capturing event phase for all button presses
        this._overlay.connect('captured-event', (_, ev: any) => {
            const t = typeof ev.type === 'function' ? ev.type() : ev.type;
            if (t === Clutter.EventType.BUTTON_PRESS) {
                this._setClickGuard();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // FIX: Click-outside-to-close lives here on the overlay, not on the
        // dialog. The overlay covers the full monitor. We check whether the
        // press landed inside the dialog's bounding box using d.contains(source)
        // — this is extremely reliable and immune to coordinate transform/scaling
        // issues. We must also stop the event here so it doesn't reach the shell
        // behind the launcher (which could accidentally activate panel items or
        // trigger other actions).
        this._overlay.connect('button-press-event', (_, ev) => {
            const d = this._dialog;
            if (!d) { this.hide(); return Clutter.EVENT_STOP; }

            const [x, y] = ev.get_coords();
            const [success, lx, ly] = d.transform_stage_point(x, y);
            const insideDialog = success && lx >= 0 && lx <= d.width && ly >= 0 && ly <= d.height;

            dbg('OverlayPress', `stage_click=(${x}, ${y}) local_click=(${lx}, ${ly}) dialog_size=(${d.width}, ${d.height}) inside=${insideDialog}`);

            if (!insideDialog) {
                dbg('OverlayPress', 'Click outside dialog, hiding launcher');
                this.hide();
            } else {
                // Set click guard: suppress the focus-watcher while
                // Clutter processes this button event chain (press → release).
                this._setClickGuard();
            }
            // Always stop so nothing behind the overlay gets the click
            return Clutter.EVENT_STOP;
        });

// Handle key-press on the overlay actor; guard against pushModal failure
this._overlay.connect('key-press-event', (_, ev) => {
    if (ev.get_key_symbol() === Clutter.KEY_Escape) {
        this.hide();
        return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
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

        this._focusId = global.stage.connect('notify::key-focus', () => {
            if (!this._visible || !this._overlay) return;
            // Skip if a mouse click is being processed — focus shifts
            // transiently during Clutter button events and would cause
            // the launcher to close before item-activated fires.
            if (this._clickGuard) return;
            const focus = global.stage.key_focus;
            if (focus && focus !== this._overlay && !this._overlay.contains(focus)) {
                dbg('Extension', 'Focus moved outside launcher overlay, hiding');
                this.hide();
            }
        });

        this._cfgId = this._settings.connect('changed::show-indicator', () => this._syncInd());
        this._syncInd();
    }

    disable() {
        dbg('Extension', 'disable() called');
        if (this._focusId) { global.stage.disconnect(this._focusId); this._focusId = null; }
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
        const dw = Math.min(1020, mon.width * 0.65);
        const dx = mon.x + Math.floor((mon.width - dw) / 2);
        const dy = mon.y + Math.floor(mon.height * 0.14);
        this._overlay.set_position(mon.x, mon.y);
        this._overlay.set_size(mon.width, mon.height);
        this._dialog.set_position(dx - mon.x, dy - mon.y);
        this._dialog.set_width(dw);
        this._dialog.min_width = dw;
        // @ts-ignore – max_width exists on Clutter.Actor at runtime
        this._dialog.max_width = dw;
    }

    toggle() { this._visible ? this.hide() : this.show(); }

    show() {
        dbg('Launcher', 'show()');
        if (this._visible) return;
        if (!this._dialog || !this._overlay) return;
        this._visible = true;
        this._dialog.reset();
        this._overlay.show();
        this._dialog.opacity = 0;
        this._dialog.translation_y = -20;

        // GNOME 50 Wayland: pushModal can fail (e.g. another modal is active).
        // If it does, bail out cleanly instead of leaving a frozen overlay.
        if (!Main.pushModal(this._overlay, {
            actionMode: Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
        })) {
            this._visible = false;
            this._isModal = false;
            this._overlay.hide();
            return;
        }
        this._isModal = true;

        easeActor(this._overlay, { opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        easeActor(this._dialog, { opacity: 255, translation_y: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_EXPO });
        timeoutOnce(10, () => this._dialog?.focus());
    }

    hide() {
        dbg('Launcher', 'hide()');
        if (!this._visible) return;
        if (!this._dialog || !this._overlay) return;
        this._visible = false;
        this._clickGuard = false;
        if (this._clickGuardTimer != null) {
            GLib.source_remove(this._clickGuardTimer as number);
            this._clickGuardTimer = null;
        }
        if (this._isModal) {
            this._isModal = false;
            try {
                Main.popModal(this._overlay);
            } catch (e: any) {
                dbg('Launcher', `popModal failed: ${e.message}`);
            }
        }
        const ov = this._overlay, dl = this._dialog;
        easeActor(dl, {
            opacity: 0, translation_y: -14, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => { ov.hide(); dl.reset(); dl.opacity = 255; dl.translation_y = 0; },
        });
        easeActor(ov, { opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD });
    }

    /** Briefly suppress the focus-watcher so click → activate works. */
    _setClickGuard() {
        this._clickGuard = true;
        if (this._clickGuardTimer != null) {
            GLib.source_remove(this._clickGuardTimer as number);
        }
        this._clickGuardTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._clickGuard = false;
            this._clickGuardTimer = null;
            return GLib.SOURCE_REMOVE;
        });
    }
}