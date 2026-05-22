// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Shared Launcher State Interface

import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import { SearchResult } from '../types.js';

/**
 * Shared state interface exposed by LauncherDialog to all controllers.
 * Controllers read/write through this interface instead of holding
 * a direct reference to the GObject widget tree.
 */
export interface LauncherState {
    // ─── Extension back-reference ────────────────────────────────────────
    readonly ext: {
        _settings: Gio.Settings;
        hide(): void;
        _setClickGuard(): void;
    };
    readonly providers: any[];
    readonly shellSettings: Gio.Settings;

    // ─── Search view state ───────────────────────────────────────────────
    results: SearchResult[];
    selIdx: number;
    tid: number | null | undefined;
    gen: number;

    // ─── Grid / Library view state ───────────────────────────────────────
    categoryGridBoxes: Map<string, St.BoxLayout>;
    allAppsCache: SearchResult[];
    allAppsCacheDirty: boolean;
    renderIdleId: number;
    bgRenderIdleId: number;
    bgRenderQueue: string[];
    activeCategory: string;
    isEditing: boolean;
    gridSelIdx: number;

    // ─── UI widget references ────────────────────────────────────────────
    readonly entryBox: St.BoxLayout;
    readonly entry: St.Entry;
    readonly scroll: St.ScrollView;
    readonly rbox: St.BoxLayout;
    readonly tips: St.BoxLayout;
    readonly headerBox: St.BoxLayout;
    readonly headerTitleLabel: St.Label;
    readonly editBtn: St.Button;
    readonly deleteBtn: St.Button;
    readonly gridScroll: St.ScrollView;
    readonly tabsBox: St.BoxLayout;
    readonly vsep: St.Widget;
    readonly editorBox: St.BoxLayout;
    readonly editorNameEntry: St.Entry;
    readonly editorScroll: St.ScrollView;
    readonly editorAppsContainer: St.BoxLayout;
    readonly promptOverlay: St.BoxLayout;
    readonly promptEntry: St.Entry;

    // ─── Methods the controllers may call back into ──────────────────────
    focus(): void;
    getGridBox(): St.BoxLayout;
    getCategoryGridBox(categoryName: string): St.BoxLayout;
    setTabsVisible(visible: boolean): void;
    /** Runtime check — true if the underlying actor is destroyed */
    isDestroyed(): boolean;
}
