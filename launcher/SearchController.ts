// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { SearchResult } from '../types.js';
import { dbg, timeoutOnce, scrollToActor } from '../utils.js';
import { ResultRow } from '../components/ResultRow.js';
import type { LauncherState } from './LauncherState.js';

export class SearchController {
    private _s: LauncherState;

    constructor(state: LauncherState) {
        this._s = state;
    }

    onText(): void {
        const s = this._s;
        if (s.tid != null) { GLib.source_remove(s.tid as number); s.tid = null; }
        const gen = ++s.gen;
        s.tid = timeoutOnce(80, () => {
            s.tid = null;
            if (s.isDestroyed()) return;
            if (gen !== s.gen) return;
            this.search(s.entry.get_text());
        });
    }

    search(query: string): void {
        const s = this._s;
        dbg('Search', 'query:', query);
        const q = query.trim();
        const max = s.ext._settings.get_int('max-results');

        if (!q) {
            this.clear();
            s.scroll.hide();
            s.headerBox.show();
            s.gridScroll.show();
            s.setTabsVisible(true);
            s.headerTitleLabel.text = s.activeCategory;
            s.gridScroll.set_child(s.getGridBox());
            return;
        }

        s.headerBox.hide();
        s.gridScroll.hide();
        s.setTabsVisible(false);
        s.scroll.show();

        s.rbox.destroy_all_children();

        const combined: SearchResult[] = [];
        for (const p of s.providers) {
            combined.push(...p.search(q));
        }
        combined.sort((a, b) => b.score - a.score || b.providerPriority - a.providerPriority);
        s.results = combined.slice(0, max);
        dbg('Search', `results: ${s.results.length} (max ${max})`);
        this.renderSearchResults();
    }

    clear(): void {
        this._s.results = [];
        this._s.selIdx = -1;
        this._s.rbox.destroy_all_children();
    }

    renderSearchResults(): void {
        const s = this._s;
        if (!s.results.length) { s.scroll.hide(); return; }
        s.results.forEach((r, i) => {
            const row = new ResultRow();
            row.setup(r, i, s.ext._settings, s.shellSettings);
            row.connect('item-activated', () => { s.ext.hide(); r.activate(); });
            row.connect('item-hovered', () => {
                this.selectIdx(i);
            });
            s.rbox.add_child(row);
        });
        s.scroll.show();
        s.selIdx = -1;
        this.selectIdx(0);
    }

    selectIdx(i: number): void {
        const s = this._s;
        const rows = s.rbox.get_children() as ResultRow[];
        if (!rows.length) return;
        i = Math.max(0, Math.min(rows.length - 1, i));
        rows.forEach((r, j) => r.setSelected(j === i));
        s.selIdx = i;

        scrollToActor(s.scroll, rows[i]);
    }

    moveSel(d: number): void {
        const n = this._s.rbox.get_children().length;
        if (n) this.selectIdx((this._s.selIdx + d + n) % n);
    }

    activateSel(): void {
        const s = this._s;
        const r = s.results[s.selIdx];
        dbg('Activate', 'list sel', s.selIdx, r ? r.name : 'none');
        if (r) { s.ext.hide(); r.activate(); }
    }

    activateIdx(i: number): void {
        const r = this._s.results[i];
        if (r) { this._s.ext.hide(); r.activate(); }
    }

    complete(): void {
        const s = this._s;
        const r = s.results[s.selIdx];
        if (r && r.name) { s.entry.set_text(r.name); s.entry.clutter_text.set_cursor_position(-1); }
    }
}
