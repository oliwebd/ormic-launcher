// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — App Search Provider


import St from 'gi://St';
import Shell from 'gi://Shell';
import GMenu from 'gi://GMenu';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SearchResult } from '../types.js';
import { dbg } from '../utils.js';

export class AppProvider {
    id = 'apps';
    priority = 10;
    private _sys = Shell.AppSystem.get_default();
    private _tree: any = null;
    private _installedChangedId = 0;
    private _dirty = true;

    get dirty(): boolean { return this._dirty; }

    /**
     * GIcon is pre-fetched once at cache-build time.
     * Icon creation during grid render then becomes just:
     *   new St.Icon({ gicon: cached.gicon, icon_size: sz })
     * — a single GObject allocation with no extra property-chain calls.
     */
    _appsCache: Map<string, {
        app: any;
        category: string;
        name: string;
        desc: string;
        exec: string;
        kw: string;
        displayName: string;
        displayDesc: string;
        gicon: any | null;  // pre-fetched GIcon
    }> = new Map();

    constructor() {
        this._tree = new GMenu.Tree({ menu_basename: 'applications.menu' });
        this._installedChangedId = this._sys.connect('installed-changed', () => {
            dbg('AppProvider', 'installed-changed signal — marking cache dirty');
            this._dirty = true;
        });
        this._buildCache();
    }

    destroy() {
        if (this._tree) {
            this._tree = null;
        }
        if (this._installedChangedId) {
            this._sys.disconnect(this._installedChangedId);
            this._installedChangedId = 0;
        }
        this._appsCache.clear();
    }

    onOpen() {}

    ensureCache() {
        if (this._dirty) this._buildCache();
    }

    reload() {
        this._buildCache();
    }

    private _buildCache() {
        dbg('AppProvider', '_buildCache() — clearing cache');
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
                            if (dir && !dir.get_is_nodisplay())
                                this._loadCategory(dir, dir.get_name(), true);
                        }
                    }
                    this._loadCategory(root, _('App'), false);
                    dbg('AppProvider', `cache size after build: ${this._appsCache.size}`);
                }
            }
        } catch (e: any) {
            log(`Ormic Launcher: Error rebuilding GMenu tree: ${e.message}`);
        }
    }

    private _loadCategory(dir: any, categoryName: string, recursive = true) {
        const iter = dir.iter();
        let type;
        while ((type = iter.next()) !== GMenu.TreeItemType.INVALID) {
            if (type === GMenu.TreeItemType.ENTRY) {
                const entry = iter.get_entry();
                if (!entry) continue;
                let id: string | null;
                try { id = entry.get_desktop_file_id(); } catch { continue; }
                if (!id || this._appsCache.has(id)) continue;

                let app = this._sys.lookup_app(id);
                if (!app) {
                    try { app = new Shell.App({ app_info: entry.get_app_info() }); }
                    catch { continue; }
                }
                if (!app?.get_app_info()?.should_show()) continue;

                const info = app.get_app_info();

                // Pre-fetch GIcon once — avoids repeated property chain at render time
                let gicon: any = null;
                try { gicon = info.get_icon() ?? null; } catch (_) {}

                this._appsCache.set(id, {
                    app, category: categoryName,
                    name: (info.get_name() ?? '').toLowerCase(),
                    desc: (info.get_description() ?? '').toLowerCase(),
                    exec: (info.get_executable() ?? '').toLowerCase(),
                    kw: (info.get_keywords() ?? []).join(' ').toLowerCase(),
                    displayName: info.get_name() ?? id,
                    displayDesc: info.get_description() ?? '',
                    gicon,
                });

            } else if (recursive && type === GMenu.TreeItemType.DIRECTORY) {
                const subdir = iter.get_directory();
                if (subdir && !subdir.get_is_nodisplay())
                    this._loadCategory(subdir, categoryName, true);
            }
        }
    }

    search(q: string): SearchResult[] {
        this.ensureCache();
        if (!q) return [];
        const lq = q.toLowerCase().trim();
        const out: SearchResult[] = [];

        for (const [id, cached] of this._appsCache.entries()) {
            const { app, category, name, desc, exec, kw,
                displayName, displayDesc, gicon } = cached;

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
                name: displayName, description: displayDesc,
                score, providerPriority: this.priority,
                // Use pre-cached GIcon when available
                createIcon: gicon
                    ? (sz: number) => new St.Icon({ gicon, icon_size: sz })
                    : (sz: number) => app.create_icon_texture?.(sz) ?? null,
                categoryIcon: 'application-x-executable-symbolic',
                category,
                activate: () => {
                    dbg('AppProvider', `activate: ${displayName}`);
                    app.activate();
                },
            });
        }
        return out.sort((a, b) => b.score - a.score).slice(0, 8);
    }
}