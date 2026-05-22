// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — App Search Provider

import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import GMenu from 'gi://GMenu';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SearchResult } from '../types.js';
import { dbg, createAppIcon } from '../utils.js';

export class AppProvider {
    id = 'apps';
    priority = 10;
    private _sys = Shell.AppSystem.get_default();
    private _tree: any = null;
    private _treeChangedId = 0;
    private _installedChangedId = 0;
    private _dirty = true;
    private _dirtyDebounceId: number | null = null;

    /** Debounce interval for tree/installed-changed signals (ms). */
    private static readonly DIRTY_DEBOUNCE_MS = 500;

    get dirty(): boolean {
        return this._dirty;
    }

    _appsCache: Map<string, {
        app: any; category: string;
        name: string; desc: string; exec: string; kw: string;
        displayName: string; displayDesc: string;
    }> = new Map();

    /**
     * Coalesce rapid GMenu signals into a single dirty-mark.
     * GNOME 50's GMenu fires `changed` much more aggressively
     * (during shell activities, app launches, etc.), so we debounce
     * to avoid triggering synchronous reload() on every signal.
     */
    private _markDirtyDebounced(): void {
        if (this._dirtyDebounceId != null) {
            GLib.source_remove(this._dirtyDebounceId);
        }
        this._dirtyDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AppProvider.DIRTY_DEBOUNCE_MS, () => {
            this._dirtyDebounceId = null;
            dbg('AppProvider', 'debounced dirty — marking cache dirty');
            this._dirty = true;
            return GLib.SOURCE_REMOVE;
        });
    }

    constructor() {
        this._tree = new GMenu.Tree({ menu_basename: 'applications.menu' });
        this._treeChangedId = this._tree.connect('changed', () => {
            dbg('AppProvider', 'tree changed signal (debouncing)');
            this._markDirtyDebounced();
        });
        this._installedChangedId = this._sys.connect('installed-changed', () => {
            dbg('AppProvider', 'installed-changed signal (debouncing)');
            this._markDirtyDebounced();
        });
        this.reload();
    }

    destroy() {
        if (this._dirtyDebounceId != null) {
            GLib.source_remove(this._dirtyDebounceId);
            this._dirtyDebounceId = null;
        }
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
                createIcon: (s: number) => createAppIcon(app, s),
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
