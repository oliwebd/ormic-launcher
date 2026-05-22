// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Grid Controller
//
// Manages the library grid view: category filtering, chunked rendering,
// background pre-rendering of off-screen categories, grid selection,
// and the category tabs sidebar.

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { SearchResult } from '../types.js';
import { dbg, timeoutOnce, scrollToActor, createAppIcon } from '../utils.js';
import { AppProvider } from '../providers/apps.js';
import { GridItem } from '../components/GridItem.js';
import { CategoryTab } from '../components/CategoryTab.js';
import type { LauncherState } from './LauncherState.js';

/** Static category definitions shared by tabs & filtering. */
const STATIC_TABS = [
    { name: 'Library Home', icon: 'go-home-symbolic' },
    { name: 'Office', icon: 'x-office-document-symbolic' },
    { name: 'System', icon: 'emblem-system-symbolic' },
    { name: 'Utilities', icon: 'accessories-calculator-symbolic' },
] as const;

const COLUMNS = 7;
const CHUNK_SIZE = 8;

/** Debounce interval for tab-hover category switching (ms). */
const TAB_HOVER_DEBOUNCE_MS = 150;

/** Guard interval after a programmatic scroll to suppress re-entrant hover events (ms). */
const SCROLL_HOVER_GUARD_MS = 50;

export class GridController {
    private _s: LauncherState;

    /** Timer id for debounced tab-hover category switching. */
    private _tabHoverTimerId: number | null = null;

    /**
     * When true, item-hovered signals are suppressed to prevent the
     * scroll → hover → scroll feedback loop.
     */
    private _scrollHoverGuard = false;
    private _scrollGuardTimerId: number | null = null;

    constructor(state: LauncherState) {
        this._s = state;
    }

    // ─── Idle job management ─────────────────────────────────────────────

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

    /** Cancel any pending tab-hover debounce timer. */
    private _cancelTabHoverTimer(): void {
        if (this._tabHoverTimerId != null) {
            GLib.source_remove(this._tabHoverTimerId);
            this._tabHoverTimerId = null;
        }
    }

    /** Cancel the scroll-hover guard timer. */
    private _cancelScrollGuard(): void {
        this._scrollHoverGuard = false;
        if (this._scrollGuardTimerId != null) {
            GLib.source_remove(this._scrollGuardTimerId);
            this._scrollGuardTimerId = null;
        }
    }

    // ─── App cache ───────────────────────────────────────────────────────

    ensureAllAppsCache(): void {
        const s = this._s;
        if (!s.allAppsCacheDirty && s.allAppsCache.length > 0) return;
        s.allAppsCacheDirty = false;

        const apps: SearchResult[] = [];
        const appProv = s.providers.find(p => p.id === 'apps') as AppProvider | undefined;
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
                    createIcon: (sz: number) => createAppIcon(app, sz),
                    categoryIcon: 'application-x-executable-symbolic',
                    category,
                    activate: () => {
                        dbg('LibraryGrid', `activate: ${id}`);
                        app.activate();
                    },
                });
            }
        }
        apps.sort((a, b) => a.name.localeCompare(b.name));
        s.allAppsCache = apps;
    }

    // ─── Category filtering ──────────────────────────────────────────────

    private _filterApps(categoryName: string): SearchResult[] {
        this.ensureAllAppsCache();
        const all = this._s.allAppsCache;

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

        // Custom group
        const customGroups = this.getCustomGroups();
        const ids = customGroups[categoryName] || [];
        return all.filter(a => ids.includes(a.desktopId ?? ''));
    }

    // ─── Grid items helpers ──────────────────────────────────────────────

    collectGridItems(): GridItem[] {
        const items: GridItem[] = [];
        const gridBox = this._s.getGridBox();
        gridBox.get_children().forEach((row: any) => {
            if (row.get_children) {
                row.get_children().forEach((item: GridItem) => items.push(item));
            }
        });
        return items;
    }

    // ─── Select category ─────────────────────────────────────────────────

    selectCategory(categoryName: string): void {
        const s = this._s;
        if (s.activeCategory === categoryName) return;
        const t0 = GLib.get_monotonic_time();
        s.activeCategory = categoryName;

        this.cancelRenderJob();
        this.cancelBgRenderJob();
        this._cancelTabHoverTimer();

        const tabs = s.tabsBox.get_children() as CategoryTab[];
        tabs.forEach(tab => {
            if (typeof tab.setSelected === 'function') {
                tab.setSelected(tab.categoryName === categoryName);
            }
        });

        s.headerTitleLabel.text = s.activeCategory;
        const isCustom = !STATIC_TABS.some(t => t.name === s.activeCategory);
        if (isCustom) { s.editBtn.show(); s.deleteBtn.show(); }
        else { s.editBtn.hide(); s.deleteBtn.hide(); }

        const hasCachedGrid = s.categoryGridBoxes.has(categoryName);
        const gridBox = s.getGridBox();
        s.gridScroll.set_child(gridBox);

        if (!hasCachedGrid) {
            dbg('Performance', `selectCategory('${categoryName}') — CACHE MISS, rendering grid`);
            this.renderGridOnly();
        } else {
            const elapsed = (GLib.get_monotonic_time() - t0) / 1000;
            dbg('Performance', `selectCategory('${categoryName}') — CACHE HIT, took ${elapsed.toFixed(1)}ms`);
            s.gridSelIdx = -1;
            timeoutOnce(10, () => {
                if (s.gridSelIdx === -1 && s.gridScroll.visible) {
                    this.selectGridIdx(0);
                }
            });
            this.startBackgroundPreRender();
        }
    }

    // ─── Render active category grid ─────────────────────────────────────

    renderGridOnly(): void {
        const s = this._s;
        const t0 = GLib.get_monotonic_time();
        const filteredApps = this._filterApps(s.activeCategory);

        const gridBox = s.getGridBox();
        gridBox.get_children().forEach((row: any) => {
            if (row.get_children) {
                row.get_children().forEach((child: any) => {
                    row.remove_child(child);
                });
            }
        });
        gridBox.destroy_all_children();
        s.gridSelIdx = -1;

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

        let currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
        gridBox.add_child(currentRow);

        let index = 0;

        const renderChunk = () => {
            if (s.isDestroyed()) return;
            const end = Math.min(index + CHUNK_SIZE, filteredApps.length);
            for (; index < end; index++) {
                const app = filteredApps[index];
                if (index > 0 && index % COLUMNS === 0) {
                    currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
                    gridBox.add_child(currentRow);
                }

                const item = new (GridItem as any)() as GridItem;
                item.setup(app);
                item.connect('item-activated', () => {
                    s.ext.hide();
                    app.activate();
                });
                item.connect('item-hovered', () => {
                    if (this._scrollHoverGuard) return;
                    const allItems = this.collectGridItems();
                    const idx = allItems.indexOf(item);
                    if (idx >= 0) this.selectGridIdx(idx);
                });
                currentRow.add_child(item);
            }

            if (index < filteredApps.length) {
                s.renderIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    renderChunk();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                s.renderIdleId = 0;
                const elapsed = (GLib.get_monotonic_time() - t0) / 1000;
                dbg('Performance', `renderGridOnly('${s.activeCategory}') — ${filteredApps.length} items, took ${elapsed.toFixed(1)}ms`);

                if (s.gridSelIdx === -1 && s.gridScroll.visible) {
                    this.selectGridIdx(0);
                }
                this.startBackgroundPreRender();
            }
        };

        renderChunk();
    }

    // ─── Background pre-render off-screen categories ─────────────────────

    private _renderCategoryGridBackground(categoryName: string, onComplete: () => void): void {
        const s = this._s;
        const filteredApps = this._filterApps(categoryName);

        const gridBox = s.getCategoryGridBox(categoryName);
        gridBox.get_children().forEach((row: any) => {
            if (row.get_children) {
                row.get_children().forEach((child: any) => {
                    row.remove_child(child);
                });
            }
        });
        gridBox.destroy_all_children();

        if (!filteredApps.length) {
            const emptyLabel = new St.Label({
                text: _('No applications in this group.\nClick the pencil icon to add apps!'),
                style_class: 'ormic-grid-empty',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            gridBox.add_child(emptyLabel);
            onComplete();
            return;
        }

        let currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
        gridBox.add_child(currentRow);

        let index = 0;

        const renderChunk = () => {
            if (s.isDestroyed()) return;
            const end = Math.min(index + CHUNK_SIZE, filteredApps.length);
            for (; index < end; index++) {
                const app = filteredApps[index];
                if (index > 0 && index % COLUMNS === 0) {
                    currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
                    gridBox.add_child(currentRow);
                }

                const item = new (GridItem as any)() as GridItem;
                item.setup(app);
                item.connect('item-activated', () => {
                    s.ext.hide();
                    app.activate();
                });
                item.connect('item-hovered', () => {
                    if (this._scrollHoverGuard) return;
                    if (s.activeCategory === categoryName) {
                        const allItems = this.collectGridItems();
                        const idx = allItems.indexOf(item);
                        if (idx >= 0) this.selectGridIdx(idx);
                    }
                });
                currentRow.add_child(item);
            }

            if (index < filteredApps.length) {
                s.bgRenderIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    renderChunk();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                s.bgRenderIdleId = 0;
                dbg('Performance', `Background pre-render for '${categoryName}' completed.`);
                onComplete();
            }
        };

        renderChunk();
    }

    startBackgroundPreRender(): void {
        this.cancelBgRenderJob();

        const allCats = this.getCategoriesList();
        this._s.bgRenderQueue = allCats.filter(
            cat => cat !== this._s.activeCategory && !this._s.categoryGridBoxes.has(cat),
        );

        dbg('Performance', `Starting background pre-render. Queue: ${JSON.stringify(this._s.bgRenderQueue)}`);
        this._processNextBackgroundCategory();
    }

    private _processNextBackgroundCategory(): void {
        if (this._s.bgRenderQueue.length === 0) {
            dbg('Performance', 'Background pre-rendering complete.');
            return;
        }

        const nextCat = this._s.bgRenderQueue.shift()!;
        dbg('Performance', `Background pre-rendering category: ${nextCat}`);
        this._renderCategoryGridBackground(nextCat, () => {
            this._processNextBackgroundCategory();
        });
    }

    // ─── Tabs rendering ──────────────────────────────────────────────────

    renderTabsOnly(): void {
        const s = this._s;
        dbg('Grid', `renderTabsOnly category=${s.activeCategory}`);

        s.tabsBox.destroy_all_children();

        STATIC_TABS.forEach(t => {
            const tab = new (CategoryTab as any)() as CategoryTab;
            tab.setup(t.name, t.icon);
            tab.setSelected(s.activeCategory === t.name);
            tab.connect('tab-selected', () => {
                this._cancelTabHoverTimer();
                this.selectCategory(t.name);
                s.focus();
            });
            tab.connect('tab-hovered', () => {
                this._cancelTabHoverTimer();
                this._tabHoverTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TAB_HOVER_DEBOUNCE_MS, () => {
                    this._tabHoverTimerId = null;
                    if (!s.isDestroyed()) {
                        this.selectCategory(t.name);
                        s.focus();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            });
            s.tabsBox.add_child(tab);
        });

        const customGroups = this.getCustomGroups();
        for (const gName of Object.keys(customGroups)) {
            const tab = new (CategoryTab as any)() as CategoryTab;
            tab.setup(gName, 'folder-symbolic');
            tab.setSelected(s.activeCategory === gName);
            tab.connect('tab-selected', () => {
                this._cancelTabHoverTimer();
                this.selectCategory(gName);
                s.focus();
            });
            tab.connect('tab-hovered', () => {
                this._cancelTabHoverTimer();
                this._tabHoverTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TAB_HOVER_DEBOUNCE_MS, () => {
                    this._tabHoverTimerId = null;
                    if (!s.isDestroyed()) {
                        this.selectCategory(gName);
                        s.focus();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            });
            s.tabsBox.add_child(tab);
        }

        const addTab = new (CategoryTab as any)() as CategoryTab;
        addTab.setup(_('Add group'), 'list-add-symbolic');
        addTab.connect('tab-selected', () => {
            // GroupEditorController handles this — emit on state
            s.promptEntry.text = '';
            s.promptOverlay.show();
            s.promptEntry.grab_key_focus();
        });
        s.tabsBox.add_child(addTab);

        s.headerTitleLabel.text = s.activeCategory;
        const isCustom = !STATIC_TABS.some(t => t.name === s.activeCategory);
        if (isCustom) { s.editBtn.show(); s.deleteBtn.show(); }
        else { s.editBtn.hide(); s.deleteBtn.hide(); }
    }

    renderGridAndTabs(): void {
        const s = this._s;
        dbg('Performance', `renderGridAndTabs — rebuilding tabs, invalidating grid for: ${s.activeCategory}`);

        this.cancelRenderJob();
        this.cancelBgRenderJob();

        const oldBox = s.categoryGridBoxes.get(s.activeCategory);
        if (oldBox) {
            oldBox.destroy();
            s.categoryGridBoxes.delete(s.activeCategory);
        }

        this.renderTabsOnly();

        const gridBox = s.getGridBox();
        s.gridScroll.set_child(gridBox);
        this.renderGridOnly();
    }

    // ─── Grid selection ──────────────────────────────────────────────────

    selectGridIdx(i: number): void {
        const items = this.collectGridItems();
        if (!items.length) return;
        i = Math.max(0, Math.min(items.length - 1, i));
        items.forEach((item, idx) => item.setSelected(idx === i));
        this._s.gridSelIdx = i;

        // Activate scroll-hover guard BEFORE scrolling to prevent the
        // scroll → hover → scroll feedback loop.
        this._cancelScrollGuard();
        this._scrollHoverGuard = true;
        scrollToActor(this._s.gridScroll, items[i]);
        this._scrollGuardTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_HOVER_GUARD_MS, () => {
            this._scrollHoverGuard = false;
            this._scrollGuardTimerId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    moveGridSel(d: number): void {
        const items = this.collectGridItems();
        const n = items.length;
        if (n) {
            this.selectGridIdx((this._s.gridSelIdx + d + n) % n);
        }
    }

    activateGridSel(): void {
        const s = this._s;
        dbg('Activate', 'grid sel', s.gridSelIdx);
        const items = this.collectGridItems();
        const selected = items[s.gridSelIdx];
        if (selected) {
            s.ext.hide();
            selected.result.activate();
        }
    }

    // ─── Settings helpers ────────────────────────────────────────────────

    getCategoriesList(): string[] {
        const list = ['Library Home', 'Office', 'System', 'Utilities'];
        const customGroups = this.getCustomGroups();
        for (const gName of Object.keys(customGroups)) {
            list.push(gName);
        }
        return list;
    }

    getCustomGroups(): Record<string, string[]> {
        dbg('Groups', 'getCustomGroups()');
        try {
            const str = this._s.ext._settings.get_string('custom-groups') || '{}';
            return JSON.parse(str);
        } catch (_e) {
            return {};
        }
    }

    saveCustomGroups(groups: Record<string, string[]>): void {
        dbg('Groups', 'saveCustomGroups()', Object.keys(groups));
        try {
            this._s.ext._settings.set_string('custom-groups', JSON.stringify(groups));
        } catch (e: any) {
            log(`Ormic Launcher: Error saving custom groups: ${e.message}`);
        }
    }

    // ─── Full cleanup (called on disable) ────────────────────────────────

    cleanup(): void {
        this.cancelRenderJob();
        this.cancelBgRenderJob();
        this._cancelTabHoverTimer();
        this._cancelScrollGuard();
        const s = this._s;
        if (s.tid != null) {
            GLib.source_remove(s.tid as number);
            s.tid = null;
        }
        if (s.categoryGridBoxes) {
            s.categoryGridBoxes.forEach(box => {
                try { box.destroy(); } catch (_) {}
            });
            s.categoryGridBoxes.clear();
        }
    }
}
