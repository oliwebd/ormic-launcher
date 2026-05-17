// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — GNOME Shell Extension
// Copyright (C) 2026 oliwebd <oliwebd@gmail.com>
//
// Inspired by the pop-os/launcher project (MPL-2.0)
// by System76 <https://github.com/pop-os/launcher>
// No source code from that project was used.
//
// Compatible with GNOME Shell 45, 46, 47, 48, 49, 50

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';

// Mtk was separated from Meta in GNOME 45; Meta.Rectangle removed in GNOME 49.
// Import Mtk with a version-safe fallback so the extension loads on all targets.
let Mtk: any;
try {
    const mtkModule = await import('gi://Mtk') as any;
    Mtk = mtkModule.default;
} catch (_e) {
    Mtk = null; // GNOME 45/46 — Mtk not yet a separate module; Meta.Rectangle still works
}

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// ─── GNOME 50 Compatibility Shims ────────────────────────────────────────────

/**
 * Fire-once timeout — uses GLib.timeout_add_once() on GNOME 50+,
 * falls back to timeout_add + SOURCE_REMOVE on GNOME 45-49.
 * @param ms   Delay in milliseconds
 * @param fn Callback
 * @returns Source ID (only on fallback path; undefined on 50+)
 */
function timeoutOnce(ms: number, fn: () => void): number | undefined {
    if ((GLib as any).timeout_add_once) {
        (GLib as any).timeout_add_once(GLib.PRIORITY_DEFAULT, ms, fn);
        return undefined;
    }
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Single idle callback — uses GLib.idle_add_once() on GNOME 50+,
 * falls back to idle_add + SOURCE_REMOVE on GNOME 45-49.
 * @param fn Callback
 */
function idleOnce(fn: () => void) {
    if ((GLib as any).idle_add_once) {
        (GLib as any).idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, fn);
    } else {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }
}

/**
 * Await-able ease animation — uses actor.easeAsync() on GNOME 50+,
 * falls back to actor.ease() on GNOME 45-49.
 * @param actor
 * @param params  Clutter animation params + optional onComplete
 * @returns
 */
function easeActor(actor: Clutter.Actor, params: any): Promise<void> | any {
    if (typeof (actor as any).easeAsync === 'function')
        return (actor as any).easeAsync(params);
    return new Promise<void>(resolve => {
        const { onComplete, ...rest } = params;
        actor.ease({
            ...rest,
            onComplete: () => {
                onComplete?.();
                resolve();
            },
        });
    });
}

// ─── Search Providers ────────────────────────────────────────────────────────

export interface SearchResult {
    id: string;
    desktopId?: string;
    name: string;
    description: string;
    score: number;
    icon?: any;
    iconName?: string;
    categoryIcon: string;
    activate: () => void;
}

/**
 * AppProvider: searches installed .desktop applications
 */
class AppProvider {
    _appSystem: Shell.AppSystem;
    id: string;
    priority: number;

    constructor() {
        this._appSystem = Shell.AppSystem.get_default();
        this.id = 'apps';
        this.priority = 10;
    }

    search(query: string): SearchResult[] {
        if (!query || query.length < 1) return [];
        const q = query.toLowerCase().trim();
        const results: SearchResult[] = [];

        // Use Shell's app search
        const apps = this._appSystem.get_installed() as any[];
        for (const app of apps) {
            const info = app.get_app_info();
            if (!info) continue;
            const name = (info.get_name() ?? '').toLowerCase();
            const desc = (info.get_description() ?? '').toLowerCase();
            const exec = (info.get_executable() ?? '').toLowerCase();
            const keywords = (info.get_keywords() ?? []).join(' ').toLowerCase();

            let score = 0;
            if (name === q) score = 100;
            else if (name.startsWith(q)) score = 80;
            else if (name.includes(q)) score = 60;
            else if (exec.includes(q)) score = 40;
            else if (desc.includes(q)) score = 20;
            else if (keywords.includes(q)) score = 10;

            if (score > 0) {
                results.push({
                    id: `app:${app.get_id()}`,
                    desktopId: app.get_id(),
                    name: info.get_name() ?? app.get_id(),
                    description: info.get_description() ?? '',
                    score,
                    icon: app.create_icon_texture(32),
                    categoryIcon: 'application-x-executable-symbolic',
                    activate: () => {
                        app.open_new_window(-1);
                    },
                });
            }
        }

        return results.sort((a, b) => b.score - a.score).slice(0, 8);
    }
}

/**
 * CalcProvider: evaluates simple mathematical expressions
 */
class CalcProvider {
    id: string;
    priority: number;
    _pattern: RegExp;
    _triggerPattern: RegExp;

    constructor() {
        this.id = 'calc';
        this.priority = 5;
        // Matches expressions like: 2+2, sin(45), sqrt(16), 100 * 3.14, etc.
        this._pattern = /^[\d\s\+\-\*\/\(\)\.\,\^%sincotalqrexpog]+$/i;
        this._triggerPattern = /[\d\+\-\*\/\(]/;
    }

    search(query: string): SearchResult[] {
        const q = query.trim();
        if (!q || !this._triggerPattern.test(q[0])) return [];
        if (!this._pattern.test(q)) return [];

        try {
            // Safe evaluation using only math operations
            const sanitized = q
                .replace(/\^/g, '**')
                .replace(/,/g, '.')
                .replace(/sin/g, 'Math.sin')
                .replace(/cos/g, 'Math.cos')
                .replace(/tan/g, 'Math.tan')
                .replace(/sqrt/g, 'Math.sqrt')
                .replace(/log/g, 'Math.log10')
                .replace(/ln/g, 'Math.log')
                .replace(/exp/g, 'Math.exp')
                .replace(/pi/gi, 'Math.PI')
                .replace(/e(?![a-zA-Z])/g, 'Math.E');

            // eslint-disable-next-line no-new-func
            const result = new Function(`"use strict"; return (${sanitized})`)();
            if (typeof result !== 'number' || !isFinite(result)) return [];

            const display = Number.isInteger(result)
                ? result.toString()
                : result.toPrecision(10).replace(/\.?0+$/, '');

            return [{
                id: 'calc:result',
                name: display,
                description: `= ${q}`,
                score: 95,
                iconName: 'accessories-calculator-symbolic',
                categoryIcon: 'accessories-calculator-symbolic',
                activate: () => {
                    // Copy to clipboard
                    const clipboard = St.Clipboard.get_default();
                    clipboard.set_text(St.ClipboardType.CLIPBOARD, display);
                    Main.notify(_('Copied'), display);
                },
            }];
        } catch (_e) {
            return [];
        }
    }
}

/**
 * WebProvider: opens a browser with a web search
 */
class WebProvider {
    id: string;
    priority: number;
    _engines: Record<string, { name: string; url: string }>;

    constructor() {
        this.id = 'web';
        this.priority = 1;
        this._engines = {
            'g ': { name: 'Google', url: 'https://www.google.com/search?q=%s' },
            'gg ': { name: 'Google', url: 'https://www.google.com/search?q=%s' },
            'd ': { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
            'ddg ': { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
            'y ': { name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' },
            'gh ': { name: 'GitHub', url: 'https://github.com/search?q=%s' },
            'w ': { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Special:Search/%s' },
        };
    }

    search(query: string): SearchResult[] {
        const q = query.trim();
        if (!q) return [];

        // Check for explicit engine prefix
        for (const [prefix, engine] of Object.entries(this._engines)) {
            if (q.toLowerCase().startsWith(prefix)) {
                const terms = encodeURIComponent(q.slice(prefix.length));
                if (!terms) continue;
                return [{
                    id: `web:${prefix}`,
                    name: `Search ${engine.name} for "${q.slice(prefix.length)}"`,
                    description: engine.url.replace('%s', decodeURIComponent(terms)),
                    score: 50,
                    iconName: 'web-browser-symbolic',
                    categoryIcon: 'web-browser-symbolic',
                    activate: () => {
                        Gio.app_info_launch_default_for_uri(
                            engine.url.replace('%s', terms), null);
                    },
                }];
            }
        }

        // Generic web search suggestion (lower score)
        if (q.length > 2) {
            const terms = encodeURIComponent(q);
            return [{
                id: 'web:default',
                name: `Search the web for "${q}"`,
                description: `https://duckduckgo.com/?q=${q}`,
                score: 5,
                iconName: 'web-browser-symbolic',
                categoryIcon: 'web-browser-symbolic',
                activate: () => {
                    Gio.app_info_launch_default_for_uri(
                        `https://duckduckgo.com/?q=${terms}`, null);
                },
            }];
        }

        return [];
    }
}

/**
 * RecentProvider: searches recently used files (via GtkRecentManager)
 */
class RecentProvider {
    id: string;
    priority: number;
    _recentPath: string;

    constructor() {
        this.id = 'recent';
        this.priority = 3;
        // GLib.BookmarkFile can read ~/.local/share/recently-used.xbel
        this._recentPath = GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'share', 'recently-used.xbel']);
    }

    search(query: string): SearchResult[] {
        const q = query.toLowerCase().trim();
        if (!q || q.length < 2) return [];

        try {
            const bm = new GLib.BookmarkFile();
            bm.load_from_file(this._recentPath);
            const uris = bm.get_uris();
            const results: SearchResult[] = [];

            for (const uri of uris) {
                const pathResult = GLib.filename_from_uri(uri);
                const path = pathResult ? pathResult[0] : null;
                if (!path) continue;
                const basename = GLib.path_get_basename(path).toLowerCase();
                if (!basename.includes(q)) continue;

                results.push({
                    id: `recent:${uri}`,
                    name: GLib.path_get_basename(path),
                    description: path,
                    score: basename.startsWith(q) ? 35 : 20,
                    iconName: 'document-open-recent-symbolic',
                    categoryIcon: 'document-open-recent-symbolic',
                    activate: () => {
                        Gio.app_info_launch_default_for_uri(uri, null);
                    },
                });
            }

            return results.sort((a, b) => b.score - a.score).slice(0, 5);
        } catch (_e) {
            return [];
        }
    }
}

/**
 * CommandProvider: run shell commands prefixed with `>`
 */
class CommandProvider {
    id: string;
    priority: number;

    constructor() {
        this.id = 'command';
        this.priority = 8;
    }

    search(query: string): SearchResult[] {
        const q = query.trim();
        if (!q.startsWith('>')) return [];
        const cmd = q.slice(1).trim();
        if (!cmd) return [];

        return [{
            id: 'command:run',
            name: `Run: ${cmd}`,
            description: 'Execute shell command',
            score: 90,
            iconName: 'utilities-terminal-symbolic',
            categoryIcon: 'utilities-terminal-symbolic',
            activate: () => {
                try {
                    GLib.spawn_command_line_async(cmd);
                } catch (e: any) {
                    Main.notifyError(_('Command Error'), e.message);
                }
            },
        }];
    }
}

// ─── Result Row Widget ────────────────────────────────────────────────────────

const ResultRow = GObject.registerClass({
    Signals: {
        'activate': {},
    },
}, class ResultRow extends St.BoxLayout {
        _result!: SearchResult;
        _index!: number;
        _selected!: boolean;
        _favButton?: St.Button;

        _init(result: SearchResult, index: number) {
            super._init({
                style_class: 'ormic-launcher-result',
                reactive: true,
                track_hover: true,
                can_focus: true,
            });

            this._result = result;
            this._index = index;
            this._selected = false;

            // Icon area
            const iconBox = new St.Bin({
                style_class: 'ormic-launcher-result-icon',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });

            if (result.icon) {
                // Pre-rendered texture from app
                result.icon.set_size(32, 32);
                iconBox.set_child(result.icon);
            } else {
                const icon = new St.Icon({
                    icon_name: result.iconName ?? 'application-x-executable-symbolic',
                    icon_size: 32,
                    style_class: 'ormic-launcher-result-gicon',
                });
                iconBox.set_child(icon);
            }

            // Text area
            const textBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'ormic-launcher-result-text',
            });

            const nameLabel = new St.Label({
                text: result.name,
                style_class: 'ormic-launcher-result-name',
                x_align: Clutter.ActorAlign.START,
            });
            nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

            textBox.add_child(nameLabel);

            if (result.description) {
                const descLabel = new St.Label({
                    text: result.description,
                    style_class: 'ormic-launcher-result-description',
                    x_align: Clutter.ActorAlign.START,
                });
                descLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                textBox.add_child(descLabel);
            }

            // Category icon (right side)
            const categoryIcon = new St.Icon({
                icon_name: result.categoryIcon ?? 'application-x-executable-symbolic',
                icon_size: 16,
                style_class: 'ormic-launcher-result-category',
                opacity: 120,
            });

            this.add_child(iconBox);
            this.add_child(textBox);

            if (result.desktopId) {
                const appId = result.desktopId;
                const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
                
                const isFavorite = () => {
                    const favorites = shellSettings.get_strv('favorite-apps');
                    return favorites.includes(appId);
                };

                const favIcon = new St.Icon({
                    icon_name: isFavorite() ? 'emblem-favorite-symbolic' : 'bookmark-new-symbolic',
                    icon_size: 16,
                    style_class: 'ormic-launcher-result-fav-icon',
                });

                const favButton = new St.Button({
                    child: favIcon,
                    style_class: 'ormic-launcher-fav-button',
                    reactive: true,
                    can_focus: false,
                    track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                this._favButton = favButton;

                if (isFavorite()) {
                    favButton.add_style_class_name('is-fav');
                }

                const toggleFavorite = () => {
                    const favorites = shellSettings.get_strv('favorite-apps');
                    const index = favorites.indexOf(appId);
                    if (index > -1) {
                        favorites.splice(index, 1);
                        favIcon.icon_name = 'bookmark-new-symbolic';
                        favButton.remove_style_class_name('is-fav');
                    } else {
                        favorites.push(appId);
                        favIcon.icon_name = 'emblem-favorite-symbolic';
                        favButton.add_style_class_name('is-fav');
                    }
                    shellSettings.set_strv('favorite-apps', favorites);
                };

                favButton.connect('clicked', () => {
                    toggleFavorite();
                });

                this.add_child(favButton);
            }

            this.add_child(categoryIcon);

            // Hover / focus feedback
            this.connect('notify::hover', () => this._onHoverChanged());
            this.connect('button-press-event', (actor, event) => {
                const source = event.get_source();
                if (this._favButton && (source === this._favButton || this._favButton.contains(source))) {
                    return false; // propagate to let the button handle it via 'clicked' signal
                }
                this.emit('activate');
                return true; // stop event
            });
        }

        get result() { return this._result; }

        _onHoverChanged() {
            // Hover highlight is handled by CSS :hover
        }

        setSelected(selected: boolean) {
            this._selected = selected;
            if (selected) {
                this.add_style_class_name('selected');
                this.grab_key_focus();
            } else {
                this.remove_style_class_name('selected');
            }
        }
    });
type ResultRow = InstanceType<typeof ResultRow>;

// ─── Launcher Dialog ──────────────────────────────────────────────────────────

const LauncherDialog = GObject.registerClass(
    class LauncherDialog extends St.BoxLayout {
        _extension!: OrmicLauncherExtension;
        _providers!: any[];
        _results!: SearchResult[];
        _selectedIndex!: number;
        _searchTimeoutId!: number | null | undefined;
        _entry!: St.Entry;
        _scrollView!: St.ScrollView;
        _resultsBox!: St.BoxLayout;
        _tipBar!: St.BoxLayout;

        _init(extension: OrmicLauncherExtension) {
            super._init({
                style_class: 'ormic-launcher',
                vertical: true,
                reactive: true,
            });

            this._extension = extension;
            this._providers = extension.providers;
            this._results = [];
            this._selectedIndex = -1;
            this._searchTimeoutId = null;

            // ── Search bar ──────────────────────────────────────────────────
            const searchBox = new St.BoxLayout({
                style_class: 'ormic-launcher-search-box',
                x_expand: true,
            });

            const searchIcon = new St.Icon({
                icon_name: 'system-search-symbolic',
                style_class: 'ormic-launcher-search-icon',
                icon_size: 20,
            });

            this._entry = new St.Entry({
                style_class: 'ormic-launcher-entry',
                hint_text: _('Search apps, calculate, or type > for commands…'),
                x_expand: true,
                can_focus: true,
            });
            this._entry.clutter_text.connect('text-changed', () => this._onTextChanged());
            this._entry.clutter_text.connect('key-press-event', (_, event) =>
                this._onKeyPress(event));

            searchBox.add_child(searchIcon);
            searchBox.add_child(this._entry);

            // ── Results scroller ────────────────────────────────────────────
            this._scrollView = new St.ScrollView({
                style_class: 'ormic-launcher-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
                x_expand: true,
            });

            this._resultsBox = new St.BoxLayout({
                style_class: 'ormic-launcher-results',
                vertical: true,
                x_expand: true,
            });
            this._scrollView.set_child(this._resultsBox);
            this._scrollView.hide();

            // ── Tip bar ─────────────────────────────────────────────────────
            this._tipBar = new St.BoxLayout({
                style_class: 'ormic-launcher-tips',
                x_expand: true,
            });
            this._buildTips();

            this.add_child(searchBox);
            this.add_child(this._scrollView);
            this.add_child(this._tipBar);
        }

        _buildTips() {
            const tips = [
                { key: '↑↓', label: 'Navigate' },
                { key: '↵', label: 'Open' },
                { key: 'Tab', label: 'Complete' },
                { key: 'Esc', label: 'Close' },
                { key: '>', label: 'Run command' },
                { key: 'g / d / y', label: 'Web search' },
            ];
            tips.forEach(({ key, label }) => {
                const tip = new St.BoxLayout({ style_class: 'ormic-launcher-tip' });
                tip.add_child(new St.Label({
                    text: key, style_class: 'ormic-launcher-tip-key'
                }));
                tip.add_child(new St.Label({
                    text: ` ${label}`, style_class: 'ormic-launcher-tip-label'
                }));
                this._tipBar.add_child(tip);
            });
        }

        vfunc_key_press_event(event: Clutter.Event): boolean {
            return this._onKeyPress(event);
        }

        _onKeyPress(event: any): boolean {
            const sym = event.get_key_symbol();

            if (sym === Clutter.KEY_Escape) {
                this._extension.hide();
                return true;
            }
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                this._activateSelected();
                return true;
            }
            if (sym === Clutter.KEY_Up) {
                this._moveSelection(-1);
                return true;
            }
            if (sym === Clutter.KEY_Down) {
                this._moveSelection(1);
                return true;
            }
            if (sym === Clutter.KEY_Tab) {
                this._completeSelected();
                return true;
            }
            return false;
        }

        _onTextChanged() {
            // On GNOME 45-49, timeoutOnce() returns a source ID we can cancel.
            // On GNOME 50+ it returns undefined (timeout_add_once is not cancellable),
            // so we just let the stale callback no-op by checking _searchTimeoutId inside.
            if (this._searchTimeoutId !== null && this._searchTimeoutId !== undefined) {
                GLib.source_remove(this._searchTimeoutId);
                this._searchTimeoutId = null;
            }
            // Debounce 80ms — uses GLib.timeout_add_once() on GNOME 50+, timeout_add on 45-49
            this._searchTimeoutId = timeoutOnce(80, () => {
                this._searchTimeoutId = null;
                this._runSearch(this._entry.text);
            });
        }

        _runSearch(query: string) {
            this._clearResults();
            const q = query.trim();

            if (!q) {
                this._scrollView.hide();
                return;
            }

            // Gather from all providers
            const allResults: SearchResult[] = [];
            for (const provider of this._providers) {
                try {
                    const r = provider.search(q);
                    allResults.push(...r);
                } catch (_e) {
                    // Provider crash: continue gracefully
                }
            }

            // Sort by score desc, then priority desc
            allResults.sort((a, b) => b.score - a.score || 0);

            this._results = allResults.slice(0, 12);
            this._renderResults();
        }

        _clearResults() {
            this._results = [];
            this._selectedIndex = -1;
            this._resultsBox.destroy_all_children();
        }

        _renderResults() {
            if (this._results.length === 0) {
                this._scrollView.hide();
                return;
            }

            this._results.forEach((result, i) => {
                const row = new ResultRow(result, i);
                row.connect('activate', () => {
                    result.activate();
                    this._extension.hide();
                });
                this._resultsBox.add_child(row);
            });

            this._scrollView.show();
            this._selectIndex(0);
        }

        _selectIndex(index: number) {
            const rows = this._resultsBox.get_children() as ResultRow[];
            if (!rows.length) return;

            index = Math.max(0, Math.min(rows.length - 1, index));
            rows.forEach((row, i) => row.setSelected(i === index));
            this._selectedIndex = index;

            // Scroll into view
            const row = rows[index];
            (this._scrollView as any).get_vscroll_bar()?.get_adjustment().set_value(
                row.y - this._scrollView.height / 2 + row.height / 2);
        }

        _moveSelection(delta: number) {
            const rows = this._resultsBox.get_children();
            if (!rows.length) return;
            const next = (this._selectedIndex + delta + rows.length) % rows.length;
            this._selectIndex(next);
        }

        _activateSelected() {
            const rows = this._resultsBox.get_children();
            const idx = this._selectedIndex;
            if (idx >= 0 && idx < rows.length) {
                const result = this._results[idx];
                if (result) {
                    result.activate();
                    this._extension.hide();
                }
            }
        }

        _completeSelected() {
            const result = this._results[this._selectedIndex];
            if (result?.name) {
                this._entry.text = result.name;
                this._entry.clutter_text.set_cursor_position(-1);
            }
        }

        focus() {
            this._entry.grab_key_focus();
        }

        reset() {
            this._clearResults();
            this._entry.text = '';
            this._scrollView.hide();
        }
    }
);
type LauncherDialog = InstanceType<typeof LauncherDialog>;

// ─── Top Panel Indicator ──────────────────────────────────────────────────────

const OrmicLauncherIndicator = GObject.registerClass(
    class OrmicLauncherIndicator extends PanelMenu.Button {
        _extension!: OrmicLauncherExtension;

        _init() {
            super._init(0.0, 'Ormic Launcher Indicator', true);

            const icon = new St.Icon({
                icon_name: 'system-search-symbolic',
                style_class: 'system-status-icon',
            });
            this.add_child(icon);

            // Redirect the menu toggle function directly to toggle the launcher
            this.menu.toggle = () => {
                this._extension.toggle();
            };

            this.connect('button-press-event', (_, event) => {
                const button = typeof event.get_button === 'function' ? event.get_button() : 1;
                if (button === 1) {
                    this._extension.toggle();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }
);
type OrmicLauncherIndicator = InstanceType<typeof OrmicLauncherIndicator>;

// ─── Extension ────────────────────────────────────────────────────────────────

export default class OrmicLauncherExtension extends Extension {
    providers!: any[];
    _visible!: boolean;
    _keybindingName!: string;
    _overlay!: St.Widget | null;
    _dialog!: LauncherDialog | null;
    _monitorChangedId!: number | null;
    _keyPressId!: number | null;
    _settings!: Gio.Settings;
    _indicator!: OrmicLauncherIndicator | null;
    _settingsChangedId!: number | null;

    enable() {
        this.providers = [
            new AppProvider(),
            new CalcProvider(),
            new WebProvider(),
            new RecentProvider(),
            new CommandProvider(),
        ];

        this._visible = false;
        this._keybindingName = 'toggle-ormic-launcher';
        this._settings = this.getSettings();
        this._indicator = null;
        this._settingsChangedId = null;

        // Build the dialog container (overlay on top of everything)
        this._overlay = new St.Widget({
            style_class: 'ormic-launcher-overlay',
            reactive: true,
            visible: false,
            x: 0, y: 0,
        });
        this._overlay.connect('button-press-event', (_, event) => {
            // Click outside dialog closes it
            const [cx, cy] = event.get_coords();
            const dialog = this._dialog!;
            const [dx, dy] = dialog.get_transformed_position();
            const [dw, dh] = [dialog.width, dialog.height];
            if (cx < dx || cx > dx + dw || cy < dy || cy > dy + dh)
                this.hide();
            return Clutter.EVENT_STOP;
        });

        this._dialog = new (LauncherDialog as any)(this);
        this._overlay.add_child(this._dialog!);

        Main.layoutManager.addTopChrome(this._overlay);

        // Position on primary monitor
        this._monitorChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._reposition());
        this._reposition();

        // Register Super+Space keybinding
        Main.wm.addKeybinding(
            this._keybindingName,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL |
            Shell.ActionMode.OVERVIEW |
            Shell.ActionMode.POPUP,
            () => this.toggle()
        );

        // ESC anywhere when visible
        this._keyPressId = global.stage.connect('key-press-event', (_, event) => {
            if (this._visible && event.get_key_symbol() === Clutter.KEY_Escape) {
                this.hide();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Initialize and watch top panel indicator setting
        this._settingsChangedId = this._settings.connect('changed::show-indicator', () => {
            this._updateIndicatorVisibility();
        });
        this._updateIndicatorVisibility();
    }

    disable() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._keyPressId) {
            global.stage.disconnect(this._keyPressId);
            this._keyPressId = null;
        }
        if (this._monitorChangedId) {
            Main.layoutManager.disconnect(this._monitorChangedId);
            this._monitorChangedId = null;
        }
        Main.wm.removeKeybinding(this._keybindingName);

        this._overlay?.destroy();
        this._overlay = null;
        this._dialog = null;
        this.providers = [];
        this._visible = false;
    }

    _updateIndicatorVisibility() {
        const show = this._settings.get_boolean('show-indicator');
        if (show) {
            if (!this._indicator) {
                const ind = new (OrmicLauncherIndicator as any)();
                ind._extension = this;
                this._indicator = ind;
                // Add to panel left-box, index 0, position 'left'
                Main.panel.addToStatusArea('ormic-launcher-indicator', this._indicator!, 0, 'left');
            }
        } else {
            if (this._indicator) {
                this._indicator.destroy();
                this._indicator = null;
            }
        }
    }

    _reposition() {
        if (!this._overlay || !this._dialog) return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        const dialogWidth = Math.min(680, monitor.width * 0.5);
        const dialogX = monitor.x + Math.floor((monitor.width - dialogWidth) / 2);
        // Place at ~30% from top
        const dialogY = monitor.y + Math.floor(monitor.height * 0.18);

        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);

        this._dialog.set_position(dialogX - monitor.x, dialogY - monitor.y);
        this._dialog.set_width(dialogWidth);
    }

    toggle() {
        if (this._visible) this.hide();
        else this.show();
    }

    show() {
        if (!this._dialog || !this._overlay) return;

        this._visible = true;
        this._dialog.reset();
        this._overlay.show();

        // Animate in — easeActor uses easeAsync() on GNOME 50+, ease() on 45–49
        this._dialog.opacity = 0;
        this._dialog.translation_y = -18;
        easeActor(this._dialog, {
            opacity: 255,
            translation_y: 0,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });
        easeActor(this._overlay, {
            opacity: 255,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Focus after animation settles — timeoutOnce uses timeout_add_once() on GNOME 50+
        timeoutOnce(50, () => this._dialog!.focus());
    }

    hide() {
        if (!this._dialog || !this._overlay) return;

        this._visible = false;
        easeActor(this._dialog, {
            opacity: 0,
            translation_y: -12,
            duration: 130,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._overlay!.hide();
                this._dialog!.reset();
                this._dialog!.opacity = 255;
                this._dialog!.translation_y = 0;
            },
        });
    }
}
