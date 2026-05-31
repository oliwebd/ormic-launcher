// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Grid Controller
//
// Performance architecture (GNOME 50 optimised)
// ───────────────────────────────────────────────
// • Chunked idle rendering — first INITIAL_ROWS rows render synchronously so
//   the launcher appears instantly. Remaining rows are added one chunk per
//   GLib.idle_add_once() tick (GLib.idle_add on older shells), keeping the
//   compositor frame budget free.
//
// • Render generation counter — if the user switches category while a chunk
//   render is in flight, stale callbacks detect the mismatch and bail out
//   immediately. No stale items, no flicker.
//
// • Flat _currentItems[] — O(1) access to every live GridItem replaces the
//   O(n) get_children() widget-tree walk that collectGridItems() used to do.
//
// • GridItem pool — items are harvested back into the pool on every category
//   switch and rebound via setup(). Zero GObject allocation, zero signal
//   churn on warm renders.
//
// • Pre-fetched GIcon (AppProvider) — icon creation is a single
//   new St.Icon({gicon}) call; no property-chain traversal per item.
//
// • Tab cache — tab widgets are rebuilt only when the custom-group list
//   changes; active-category switch just flips CSS classes.

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { SearchResult } from '../types.js';
import { dbg, timeoutOnce, idleOnce, createAppIcon } from '../utils.js';
import { AppProvider } from '../providers/apps.js';
import { GridItem } from '../components/GridItem.js';
import { CategoryTab } from '../components/CategoryTab.js';
import type { LauncherState } from './LauncherState.js';

const STATIC_TABS = [
    { name: 'Library Home', icon: 'go-home-symbolic' },
    { name: 'Favorites', icon: 'starred-symbolic' },
    { name: 'Office', icon: 'x-office-document-symbolic' },
    { name: 'System', icon: 'emblem-system-symbolic' },
    { name: 'Utilities', icon: 'accessories-calculator-symbolic' },
] as const;

const COLUMNS = 9;

// How many items to render synchronously on the first call (fills the visible
// viewport). Everything beyond this renders one chunk per idle frame.
const INITIAL_ITEMS = COLUMNS * 3;  // 30

// Items rendered per idle tick after the initial batch.
const CHUNK_ITEMS = COLUMNS * 4;

export class GridController {
    private _s: LauncherState;

    // ── Render-gen: incremented on every renderGridOnly() call.
    // Idle chunk callbacks compare their captured gen against this; if they
    // differ the render was superseded and the callback returns immediately.
    private _renderGen = 0;

    // ── Flat list of every GridItem currently visible in the grid.
    // Replaces the old O(n) get_children() tree walk.
    private _currentItems: GridItem[] = [];

    // ── Filtered app list for the active category (invalidated on switch).
    private _filteredApps: SearchResult[] = [];
    private _filteredCategory = '';

    // ── Pool of detached-but-alive GridItem widgets for reuse.
    private _itemPool: GridItem[] = [];

    // ── Tab widget cache key (custom group names joined).
    private _tabCacheKey = '';

    constructor(state: LauncherState) {
        this._s = state;
    }

    // ─── Idle/timeout job management ─────────────────────────────────────

    cancelRenderJob(): void {
        if (this._s.renderIdleId) {
            GLib.source_remove(this._s.renderIdleId);
            this._s.renderIdleId = 0;
        }
    }

    cancelBgRenderJob(): void {
        if (this._s.bgRenderIdleId) {
            GLib.source_remove(this._s.bgRenderIdleId);
            this._s.bgRenderIdleId = 0;
        }
        this._s.bgRenderQueue = [];
    }

    // ─── App cache ────────────────────────────────────────────────────────

    ensureAllAppsCache(): void {
        const s = this._s;

        const appProv = s.providers.find(p => p.id === 'apps') as AppProvider | undefined;

        const providerDirty = appProv ? appProv.dirty : false;

        // Delegate dirty-check and rebuild entirely to AppProvider.
        // It only rebuilds on real install/uninstall; we never force it.
        if (appProv) appProv.ensureCache();

        // Rebuild the GridController's SearchResult wrapper array only when
        // the underlying provider cache actually changed (or first run).
        if (!s.allAppsCacheDirty && !providerDirty && s.allAppsCache.length > 0) return;

        s.allAppsCacheDirty = false;

        const apps: SearchResult[] = [];
        if (appProv) {
            for (const [id, cached] of appProv._appsCache.entries()) {
                const { app, category, gicon } = cached;
                const info = app.get_app_info();
                if (!info) continue;
                apps.push({
                    id: `app:${id}`, desktopId: id,
                    name: cached.displayName ?? info.get_name() ?? id,
                    description: cached.displayDesc ?? info.get_description() ?? '',
                    score: 0, providerPriority: 10,
                    createIcon: gicon
                        ? (sz: number) => new St.Icon({ gicon, icon_size: sz })
                        : (sz: number) => createAppIcon(app, sz),
                    categoryIcon: 'application-x-executable-symbolic',
                    category,
                    activate: () => { dbg('LibraryGrid', `activate: ${id}`); app.activate(); },
                });
            }
        }
        apps.sort((a, b) => a.name.localeCompare(b.name));
        s.allAppsCache = apps;
    }

    // ─── Category filtering ───────────────────────────────────────────────

    private _filterApps(categoryName: string): SearchResult[] {
        this.ensureAllAppsCache();
        const all = this._s.allAppsCache;

        if (categoryName === 'Favorites') {
            const favIds = this._s.shellSettings.get_strv('favorite-apps') as string[];
            const filtered = all.filter(a => favIds.includes(a.desktopId ?? ''));
            filtered.sort((a, b) =>
                favIds.indexOf(a.desktopId ?? '') - favIds.indexOf(b.desktopId ?? ''));
            return filtered;
        }
        if (categoryName === 'Library Home') return all;
        if (categoryName === 'Office')
            return all.filter(a => a.category.toLowerCase().includes('office'));
        if (categoryName === 'System')
            return all.filter(a =>
                a.category.toLowerCase().includes('system') ||
                a.category.toLowerCase().includes('setting') ||
                a.category.toLowerCase().includes('administration') ||
                a.category.toLowerCase().includes('preferences'));
        if (categoryName === 'Utilities')
            return all.filter(a =>
                a.category.toLowerCase().includes('utility') ||
                a.category.toLowerCase().includes('utilities') ||
                a.category.toLowerCase().includes('accessories'));

        const ids = this.getCustomGroups()[categoryName] ?? [];
        return all.filter(a => ids.includes(a.desktopId ?? ''));
    }

    private _getFilteredApps(): SearchResult[] {
        const s = this._s;
        if (this._filteredCategory !== s.activeCategory) {
            this._filteredApps = this._filterApps(s.activeCategory);
            this._filteredCategory = s.activeCategory;
        }
        return this._filteredApps;
    }

    // ─── GridItem pool ────────────────────────────────────────────────────

    /**
     * Detach all live items back into the pool and clear the grid rows.
     * Uses the flat _currentItems array — no widget tree traversal needed.
     */
    harvestItems(): void {
        for (const item of this._currentItems) {
            item.get_parent()?.remove_child(item);
            this._itemPool.push(item);
        }
        this._currentItems = [];
        // Remove now-empty row containers (cheap St.BoxLayouts)
        this._s.getGridBox().remove_all_children();
        // Increment render gen so any in-flight idle chunks abort
        this._renderGen++;
    }

    private _getPoolItem(): GridItem {
        return this._itemPool.pop() ?? new GridItem();
    }

    // ─── collectGridItems — O(1) via flat array ───────────────────────────

    collectGridItems(): GridItem[] {
        return this._currentItems;
    }

    // ─── No-op stubs (pagination removed) ────────────────────────────────

    nextPage(): void { }
    prevPage(): void { }

    // ─── Header button sync ───────────────────────────────────────────────

    private _syncHeaderButtons(): void {
        const s = this._s;
        s.headerTitleLabel.text = s.activeCategory;
        const isCustom = !STATIC_TABS.some(t => t.name === s.activeCategory);
        if (isCustom) { s.editBtn.show(); s.deleteBtn.show(); }
        else { s.editBtn.hide(); s.deleteBtn.hide(); }
    }

    // ─── Select category ──────────────────────────────────────────────────

    selectCategory(categoryName: string): void {
        const s = this._s;
        if (s.activeCategory === categoryName) return;
        const t0 = GLib.get_monotonic_time();
        s.activeCategory = categoryName;
        this._filteredCategory = '';

        this.cancelRenderJob();
        this.cancelBgRenderJob();

        (s.tabsBox.get_children() as CategoryTab[]).forEach(tab => {
            tab.setSelected(tab.categoryName === categoryName);
        });

        this._syncHeaderButtons();
        s.gridScroll.set_child(s.getGridBox());

        const elapsed = (GLib.get_monotonic_time() - t0) / 1000;
        dbg('Performance', `selectCategory('${categoryName}') — ${elapsed.toFixed(1)}ms`);

        this.renderGridOnly();
    }

    // ─── Core render — chunked idle ───────────────────────────────────────

    renderGridOnly(): void {
        const s = this._s;
        const t0 = GLib.get_monotonic_time();

        const apps = this._getFilteredApps();

        // Harvest items and bump gen before any async work
        this.harvestItems();
        const gen = this._renderGen;

        s.gridSelIdx = -1;
        s.pageNavBox.hide();

        const gridBox = s.getGridBox();

        if (!apps.length) {
            gridBox.add_child(new St.Label({
                text: s.activeCategory === 'Favorites'
                    ? _('No favourite apps yet.\nPin apps using the ★ button in search results!')
                    : _('No applications in this group.\nClick the pencil icon to add apps!'),
                style_class: 'ormic-grid-empty',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        // Pre-create all row containers in one pass (cheap; just layout hints).
        // Adding empty containers first prevents layout-pass stutter as items
        // arrive in later idle chunks.
        const numRows = Math.ceil(apps.length / COLUMNS);
        const rows: St.BoxLayout[] = [];
        for (let r = 0; r < numRows; r++) {
            const row = new St.BoxLayout({
                style_class: 'ormic-grid-row',
                x_expand: false,
                x_align: Clutter.ActorAlign.START,
            });
            gridBox.add_child(row);
            rows.push(row);
        }

        // ── Synchronous first batch — fills the visible viewport ──────────
        const syncEnd = Math.min(INITIAL_ITEMS, apps.length);
        this._fillSlice(apps, rows, 0, syncEnd, gen);

        // Auto-select first item after initial render
        if (s.gridScroll.visible) {
            s.gridSelIdx = 0;
            timeoutOnce(10, () => {
                if (s.gridScroll.visible) this.selectGridIdx(0);
            });
        }

        const elapsed = (GLib.get_monotonic_time() - t0) / 1000;
        dbg('Performance',
            `renderGridOnly('${s.activeCategory}') sync ${syncEnd}/${apps.length} items — ${elapsed.toFixed(1)}ms`);

        // ── Schedule remaining rows as idle chunks ────────────────────────
        if (apps.length > syncEnd)
            this._scheduleChunk(gen, apps, rows, syncEnd);
    }

    /**
     * Bind GridItems for apps[start..end) into the pre-created row widgets.
     * Safe to call from both sync context and idle callbacks.
     */
    private _fillSlice(
        apps: SearchResult[],
        rows: St.BoxLayout[],
        start: number,
        end: number,
        gen: number,
    ): void {
        for (let i = start; i < end; i++) {
            const app = apps[i];
            const rowIdx = Math.floor(i / COLUMNS);
            const item = this._getPoolItem();
            const capturedIdx = i;

            item.setup(
                app,
                () => { this._s.ext.hide(); app.activate(); },
                () => {
                    if (this._s.gridSelIdx !== capturedIdx) {
                        this._s.gridSelIdx = capturedIdx;
                        // O(1) iteration over flat array
                        this._currentItems.forEach(
                            (it, j) => it.setSelected(j === capturedIdx));
                    }
                },
            );

            rows[rowIdx].add_child(item);
            this._currentItems.push(item);
        }
        void gen; // suppress unused warning — gen is checked by caller
    }

    /**
     * Schedule the next idle chunk.  Captures `gen` so stale callbacks from a
     * superseded render bail out immediately without touching the widget tree.
     */
    private _scheduleChunk(
        gen: number,
        apps: SearchResult[],
        rows: St.BoxLayout[],
        startIdx: number,
    ): void {
        idleOnce(() => {
            // Bail if render was superseded by a category switch or harvest
            if (gen !== this._renderGen) return;
            if (this._s.isDestroyed()) return;

            const endIdx = Math.min(startIdx + CHUNK_ITEMS, apps.length);
            this._fillSlice(apps, rows, startIdx, endIdx, gen);

            if (endIdx < apps.length)
                this._scheduleChunk(gen, apps, rows, endIdx);
        });
    }

    // ─── Background pre-render (no-op) ────────────────────────────────────

    startBackgroundPreRender(): void { }

    // ─── Tab rendering ────────────────────────────────────────────────────

    renderTabsOnly(): void {
        const s = this._s;
        const customGroups = this.getCustomGroups();
        const groupNames = Object.keys(customGroups);
        const newKey = groupNames.join('|');

        if (newKey === this._tabCacheKey && s.tabsBox.get_n_children() > 0) {
            dbg('Grid', `renderTabsOnly — fast path (key="${newKey}")`);
            (s.tabsBox.get_children() as CategoryTab[]).forEach(tab => {
                tab.setSelected(tab.categoryName === s.activeCategory);
            });
            this._syncHeaderButtons();
            return;
        }

        dbg('Grid', `renderTabsOnly — rebuild (key="${newKey}" was "${this._tabCacheKey}")`);
        this._tabCacheKey = newKey;
        s.tabsBox.destroy_all_children();

        STATIC_TABS.forEach(t => {
            const tab = new CategoryTab();
            tab.setup(t.name, t.icon);
            tab.setSelected(s.activeCategory === t.name);
            if (t.name === 'Favorites')
                tab.add_style_class_name('ormic-favorites-tab');

            tab.connect('tab-selected', () => {
                if (t.name === 'Favorites') this._filteredCategory = '';
                this.selectCategory(t.name);
                s.focus();
            });

            s.tabsBox.add_child(tab);
        });

        for (const gName of groupNames) {
            const tab = new CategoryTab();
            tab.setup(gName, 'folder-symbolic');
            tab.setSelected(s.activeCategory === gName);
            tab.connect('tab-selected', () => {
                this.selectCategory(gName);
                s.focus();
            });

            s.tabsBox.add_child(tab);
        }

        const addTab = new CategoryTab();
        addTab.setup(_('Add group'), 'list-add-symbolic');
        addTab.connect('tab-selected', () => {
            s.headerBox.hide();
            s.gridScroll.hide();
            s.pageNavBox.hide();
            s.setTabsVisible(false);
            
            s.promptEntry.text = '';
            s.promptOverlay.show();
            s.promptEntry.grab_key_focus();
        });
        s.tabsBox.add_child(addTab);

        this._syncHeaderButtons();
    }

    renderGridAndTabs(): void {
        const s = this._s;
        dbg('Performance', `renderGridAndTabs — for: ${s.activeCategory}`);

        this.cancelRenderJob();
        this.cancelBgRenderJob();

        this.harvestItems();

        s.categoryGridBoxes.get(s.activeCategory)?.destroy();
        s.categoryGridBoxes.delete(s.activeCategory);

        this._tabCacheKey = '';
        this._filteredCategory = '';

        this.renderTabsOnly();
        s.gridScroll.set_child(s.getGridBox());
        this.renderGridOnly();
    }

    // ─── Grid selection ───────────────────────────────────────────────────

    selectGridIdx(idx: number): void {
        const apps = this._getFilteredApps();
        if (!apps.length) return;
        idx = Math.max(0, Math.min(apps.length - 1, idx));
        // O(1) flat array iteration
        this._currentItems.forEach((item, i) => item.setSelected(i === idx));
        this._s.gridSelIdx = idx;
    }

    moveGridSel(d: number): void {
        const total = this._getFilteredApps().length;
        if (!total) return;
        const cur = this._s.gridSelIdx < 0 ? 0 : this._s.gridSelIdx;
        this.selectGridIdx(((cur + d) % total + total) % total);
    }

    activateGridSel(): void {
        const s = this._s;
        dbg('Activate', 'grid sel', s.gridSelIdx);
        const selected = this._getFilteredApps()[s.gridSelIdx];
        if (selected) { s.ext.hide(); selected.activate(); }
    }

    // ─── Settings helpers ─────────────────────────────────────────────────

    getCategoriesList(): string[] {
        return [
            'Library Home', 'Favorites', 'Office', 'System', 'Utilities',
            ...Object.keys(this.getCustomGroups()),
        ];
    }

    getCustomGroups(): Record<string, string[]> {
        dbg('Groups', 'getCustomGroups()');
        try {
            return JSON.parse(this._s.ext._settings.get_string('custom-groups') || '{}');
        } catch (_e) { return {}; }
    }

    saveCustomGroups(groups: Record<string, string[]>): void {
        dbg('Groups', 'saveCustomGroups()', Object.keys(groups));
        try {
            this._s.ext._settings.set_string('custom-groups', JSON.stringify(groups));
        } catch (e: any) {
            console.error(`Ormic Launcher: Error saving custom groups: ${e.message}`);
        }
    }

    // ─── Cleanup ──────────────────────────────────────────────────────────

    cleanup(): void {
        this.cancelRenderJob();
        this.cancelBgRenderJob();
        // Bump gen so any pending idle chunks abort cleanly
        this._renderGen++;

        this._currentItems = [];
        this._itemPool.forEach(item => item?.destroy());
        this._itemPool = [];

        const s = this._s;
        if (s.tid != null) { GLib.source_remove(s.tid as number); s.tid = null; }
        if (s.categoryGridBoxes) {
            s.categoryGridBoxes.forEach(box => box?.destroy());
            s.categoryGridBoxes.clear();
        }
    }
}