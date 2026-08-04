// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Shared Launcher State Interface

import St from 'gi://St';
import Gio from 'gi://Gio';

import { SearchResult } from '../types.js';

export interface LauncherState {
    readonly ext: {
        _settings: Gio.Settings;
        hide(): void;
        _setClickGuard(): void;
    };
    readonly providers: any[];
    readonly shellSettings: Gio.Settings;

    results: SearchResult[];
    selIdx: number;
    tid: number | null | undefined;
    gen: number;

    categoryGridBoxes: Map<string, St.BoxLayout>;
    allAppsCache: SearchResult[];
    allAppsCacheDirty: boolean;
    renderIdleId: number;
    activeCategory: string;
    isEditing: boolean;
    gridSelIdx: number;

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
    readonly promptCard: St.BoxLayout;
    readonly promptEntry: St.Entry;
    readonly pageNavBox: St.BoxLayout;
    readonly pageDotsBox: St.BoxLayout;
    readonly prevPageBtn: St.Button;
    readonly nextPageBtn: St.Button;

    focus(): void;
    getGridBox(): St.BoxLayout;
    getCategoryGridBox(categoryName: string): St.BoxLayout;
    setTabsVisible(visible: boolean): void;
}
