// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Recent Files Search Provider

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SearchResult } from '../types.js';

export class RecentProvider {
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
