// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Window Search Provider

import Gio from 'gi://Gio';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SearchResult } from '../types.js';
import { listAllWindows, appForWindow } from '../utils.js';

export class WindowProvider {
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
