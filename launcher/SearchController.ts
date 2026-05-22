// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Search Controller
//
// Handles debounced text search, result rendering, list-view selection,
// and search-result activation.

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

    // ─── Debounced text handler ──────────────────────────────────────────

    onText(): void {
        const s = this._s;
        if (s.tid != null) { GLib.source_remove(s.tid as number); s.tid = null; }
        const gen = ++s.gen;
        s.tid = timeoutOnce(80, () => {
            s.tid = null;
            if (s.isDestroyed()) return;
            if (gen !== s.gen) return;
            this.search(s.entry.text);
        });
    }

    // ─── Core search ─────────────────────────────────────────────────────

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
            const gridBox = s.getGridBox();
            s.gridScroll.set_child(gridBox);
            if (gridBox.get_n_children() === 0) {
                // GridController will handle this via the dialog
            } else {
                s.gridSelIdx = -1;
                timeoutOnce(10, () => {
                    if (s.gridSelIdx === -1 && s.gridScroll.visible) {
                        // GridController will handle
                    }
                });
            }
            return;
        }

        s.headerBox.hide();
        s.gridScroll.hide();
        s.setTabsVisible(false);
        s.scroll.show();

        s.rbox.destroy_all_children();

        const combined: SearchResult[] = [];
        for (const p of s.providers) {
            try { combined.push(...p.search(q)); } catch (_e) { }
        }
        combined.sort((a, b) => b.score - a.score || b.providerPriority - a.providerPriority);
        s.results = combined.slice(0, max);
        dbg('Search', `results: ${s.results.length} (max ${max})`);
        this.renderSearchResults();
    }

    // ─── Clear ───────────────────────────────────────────────────────────

    clear(): void {
        this._s.results = [];
        this._s.selIdx = -1;
        this._s.rbox.destroy_all_children();
    }

    // ─── Render results list ─────────────────────────────────────────────

    renderSearchResults(): void {
        const s = this._s;
        if (!s.results.length) { s.scroll.hide(); return; }
        s.results.forEach((r, i) => {
            const row = new (ResultRow as any)() as ResultRow;
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

    // ─── Selection management ────────────────────────────────────────────

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
        dbg('Activate', 'list sel', s.selIdx, r?.name ?? 'none');
        if (r) { s.ext.hide(); r.activate(); }
    }

    activateIdx(i: number): void {
        const r = this._s.results[i];
        if (r) { this._s.ext.hide(); r.activate(); }
    }

    complete(): void {
        const s = this._s;
        const r = s.results[s.selIdx];
        if (r?.name) { s.entry.text = r.name; s.entry.clutter_text.set_cursor_position(-1); }
    }
}
