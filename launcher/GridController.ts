// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Grid Controller
//
// Manages the library grid view: category filtering, page-based navigation
// (GNOME app-grid style dots + left/right arrows), grid selection,
// and the category tabs sidebar.

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { SearchResult } from '../types.js';
import { dbg, timeoutOnce, createAppIcon } from '../utils.js';
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
const ROWS_PER_PAGE = 4;
const ITEMS_PER_PAGE = COLUMNS * ROWS_PER_PAGE; // 28 items per page

/** Debounce interval for tab-hover category switching (ms). */
const TAB_HOVER_DEBOUNCE_MS = 150;

export class GridController {
    private _s: LauncherState;

    /** Timer id for debounced tab-hover category switching. */
    private _tabHoverTimerId: number | null = null;

    /** Current page index (0-based). */
    private _currentPage = 0;

    /** Total pages for the active category. */
    private _totalPages = 1;

    /** Filtered apps for the current category (cached between page changes). */
    private _filteredApps: SearchResult[] = [];
    private _filteredCategory = '';

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

    /** Return filtered apps for the current category, using cached result when possible. */
    private _getFilteredApps(): SearchResult[] {
        const s = this._s;
        if (this._filteredCategory !== s.activeCategory) {
            this._filteredApps = this._filterApps(s.activeCategory);
            this._filteredCategory = s.activeCategory;
        }
        return this._filteredApps;
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

    // ─── Page navigation ─────────────────────────────────────────────────

    goToPage(page: number): void {
        const clampedPage = Math.max(0, Math.min(this._totalPages - 1, page));
        if (clampedPage === this._currentPage && this._filteredCategory === this._s.activeCategory) {
            // Already on this page for this category — just update nav
            this._updatePageNav();
            return;
        }
        this._currentPage = clampedPage;
        this.renderGridOnly();
    }

    nextPage(): void {
        if (this._currentPage < this._totalPages - 1)
            this.goToPage(this._currentPage + 1);
    }

    prevPage(): void {
        if (this._currentPage > 0)
            this.goToPage(this._currentPage - 1);
    }

    resetPage(): void {
        this._currentPage = 0;
        this._filteredCategory = ''; // force re-filter
    }

    /** Rebuild page-dot indicators and update arrow button states. */
    private _updatePageNav(): void {
        const s = this._s;
        if (!s.pageDotsBox || !s.prevPageBtn || !s.nextPageBtn) return;

        // Rebuild dots
        s.pageDotsBox.destroy_all_children();
        for (let i = 0; i < this._totalPages; i++) {
            const dot = new St.Widget({
                style_class: i === this._currentPage
                    ? 'ormic-page-dot ormic-page-dot-active'
                    : 'ormic-page-dot',
                reactive: true,
                track_hover: true,
            });
            const pageIdx = i;
            dot.connect('button-press-event', () => {
                this.goToPage(pageIdx);
                s.focus();
                return Clutter.EVENT_STOP;
            });
            s.pageDotsBox.add_child(dot);
        }

        // Arrow states
        const atFirst = this._currentPage === 0;
        const atLast = this._currentPage >= this._totalPages - 1;
        s.prevPageBtn.reactive = !atFirst;
        s.prevPageBtn.opacity = atFirst ? 60 : 255;
        s.nextPageBtn.reactive = !atLast;
        s.nextPageBtn.opacity = atLast ? 60 : 255;

        // Show nav bar only when more than one page exists
        if (this._totalPages > 1) {
            s.pageNavBox.show();
        } else {
            s.pageNavBox.hide();
        }
    }

    // ─── Select category ─────────────────────────────────────────────────

    selectCategory(categoryName: string): void {
        const s = this._s;
        if (s.activeCategory === categoryName) return;
        const t0 = GLib.get_monotonic_time();
        s.activeCategory = categoryName;

        // Reset pagination for the new category
        this._currentPage = 0;
        this._filteredCategory = ''; // force re-filter

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

        const gridBox = s.getGridBox();
        s.gridScroll.set_child(gridBox);

        const elapsed = (GLib.get_monotonic_time() - t0) / 1000;
        dbg('Performance', `selectCategory('${categoryName}') — ${elapsed.toFixed(1)}ms`);

        this.renderGridOnly();
    }

    // ─── Render active category grid (current page only) ─────────────────

    renderGridOnly(): void {
        const s = this._s;
        const t0 = GLib.get_monotonic_time();

        const filteredApps = this._getFilteredApps();

        // Calculate pagination
        this._totalPages = Math.max(1, Math.ceil(filteredApps.length / ITEMS_PER_PAGE));
        this._currentPage = Math.max(0, Math.min(this._totalPages - 1, this._currentPage));

        const pageStart = this._currentPage * ITEMS_PER_PAGE;
        const pageEnd = Math.min(pageStart + ITEMS_PER_PAGE, filteredApps.length);
        const pageApps = filteredApps.slice(pageStart, pageEnd);

        // Clear current grid
        const gridBox = s.getGridBox();
        gridBox.get_children().forEach((row: any) => {
            if (row.get_children) {
                row.get_children().forEach((child: any) => row.remove_child(child));
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
            this._updatePageNav();
            return;
        }

        // Render page items synchronously (≤28 items — always fast)
        let currentRow = new St.BoxLayout({
            style_class: 'ormic-grid-row',
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
        });
        gridBox.add_child(currentRow);

        pageApps.forEach((app, localIdx) => {
            if (localIdx > 0 && localIdx % COLUMNS === 0) {
                currentRow = new St.BoxLayout({
                    style_class: 'ormic-grid-row',
                    x_expand: false,
                    x_align: Clutter.ActorAlign.START,
                });
                gridBox.add_child(currentRow);
            }

            const item = new (GridItem as any)() as GridItem;
            item.setup(app);
            item.connect('item-activated', () => {
                s.ext.hide();
                app.activate();
            });
            item.connect('item-hovered', () => {
                const globalIdx = pageStart + localIdx;
                if (s.gridSelIdx !== globalIdx) {
                    s.gridSelIdx = globalIdx;
                    const allItems = this.collectGridItems();
                    allItems.forEach((it, idx) => it.setSelected(idx === localIdx));
                }
            });
            currentRow.add_child(item);
        });

        s.renderIdleId = 0;

        // Auto-select first item
        if (s.gridSelIdx === -1 && s.gridScroll.visible) {
            s.gridSelIdx = pageStart;
            timeoutOnce(10, () => {
                if (s.gridScroll.visible) this.selectGridIdx(s.gridSelIdx);
            });
        }

        this._updatePageNav();

        const elapsed = (GLib.get_monotonic_time() - t0) / 1000;
        dbg('Performance', `renderGridOnly('${s.activeCategory}') page ${this._currentPage}/${this._totalPages - 1} — ${pageApps.length} items, ${elapsed.toFixed(1)}ms`);
    }

    // ─── Background pre-render (no-op with pagination) ───────────────────

    startBackgroundPreRender(): void {
        // No-op: page-based rendering is fast enough on demand.
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
        dbg('Performance', `renderGridAndTabs — rebuilding tabs, resetting page for: ${s.activeCategory}`);

        this.cancelRenderJob();
        this.cancelBgRenderJob();

        // Invalidate cache for active category so it re-renders
        const oldBox = s.categoryGridBoxes.get(s.activeCategory);
        if (oldBox) {
            oldBox.destroy();
            s.categoryGridBoxes.delete(s.activeCategory);
        }

        this._currentPage = 0;
        this._filteredCategory = '';

        this.renderTabsOnly();

        const gridBox = s.getGridBox();
        s.gridScroll.set_child(gridBox);
        this.renderGridOnly();
    }

    // ─── Grid selection ──────────────────────────────────────────────────

    selectGridIdx(globalIdx: number): void {
        const filteredApps = this._getFilteredApps();
        if (!filteredApps.length) return;

        const total = filteredApps.length;
        globalIdx = Math.max(0, Math.min(total - 1, globalIdx));

        const targetPage = Math.floor(globalIdx / ITEMS_PER_PAGE);

        // Switch page if needed (triggers re-render, which will select item 0)
        if (targetPage !== this._currentPage) {
            this._currentPage = targetPage;
            this._s.gridSelIdx = globalIdx;
            this.renderGridOnly();
            // After render, select the local item
            const localIdx = globalIdx - targetPage * ITEMS_PER_PAGE;
            timeoutOnce(20, () => {
                const items = this.collectGridItems();
                items.forEach((item, idx) => item.setSelected(idx === localIdx));
            });
            return;
        }

        const localIdx = globalIdx - this._currentPage * ITEMS_PER_PAGE;
        const items = this.collectGridItems();
        if (!items.length) return;

        items.forEach((item, idx) => item.setSelected(idx === localIdx));
        this._s.gridSelIdx = globalIdx;
    }

    moveGridSel(d: number): void {
        const filteredApps = this._getFilteredApps();
        const total = filteredApps.length;
        if (!total) return;

        const currentGlobal = this._s.gridSelIdx;
        const startGlobal = currentGlobal < 0 ? 0 : currentGlobal;
        const newGlobal = ((startGlobal + d) % total + total) % total;
        this.selectGridIdx(newGlobal);
    }

    activateGridSel(): void {
        const s = this._s;
        dbg('Activate', 'grid sel', s.gridSelIdx);
        const filteredApps = this._getFilteredApps();
        const selected = filteredApps[s.gridSelIdx];
        if (selected) {
            s.ext.hide();
            selected.activate();
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
