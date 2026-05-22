// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — GNOME Shell Extension
// Copyright (C) 2026 oliwebd <oliwebd@gmail.com>
//
// Compatible with GNOME Shell 45 · 46 · 47 · 48 · 49 · 50

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { SearchResult } from './types.js';
import {
    dbg,
    timeoutOnce,
    easeActor,
    createBlurEffect,
} from './utils.js';

import { AppProvider } from './providers/apps.js';
import { CalcProvider } from './providers/calc.js';
import { RecentProvider } from './providers/recent.js';
import { CommandProvider } from './providers/command.js';
import { WindowProvider } from './providers/window.js';

import { CategoryTab } from './components/CategoryTab.js';

import { LauncherState } from './launcher/LauncherState.js';
import { SearchController } from './launcher/SearchController.js';
import { GridController } from './launcher/GridController.js';
import { GroupEditorController } from './launcher/GroupEditorController.js';
import { KeyboardHandler } from './launcher/KeyboardHandler.js';

// ─── Launcher Dialog ──────────────────────────────────────────────────────────

const LauncherDialog = GObject.registerClass(
    class LauncherDialog extends St.BoxLayout {
        private _state!: LauncherState;
        private _searchCtrl!: SearchController;
        private _gridCtrl!: GridController;
        private _groupCtrl!: GroupEditorController;
        private _kbdHandler!: KeyboardHandler;

        private _ext!: OrmicLauncherExtension;
        private _providers!: any[];
        private _results!: SearchResult[];
        private _selIdx!: number;
        private _tid!: number | null | undefined;
        private _gen!: number;
        _shellSettings!: Gio.Settings;

        private _categoryGridBoxes!: Map<string, St.BoxLayout>;
        private _allAppsCache!: SearchResult[];
        private _allAppsCacheDirty!: boolean;

        private _renderIdleId = 0;
        private _bgRenderIdleId = 0;
        private _bgRenderQueue: string[] = [];

        // Dynamic multi-view state
        private _activeCategory = 'Library Home';
        private _isEditing = false;
        private _gridSelIdx = -1;

        get _gridBox(): St.BoxLayout {
            return this._getCategoryGridBox(this._activeCategory);
        }

        private _getCategoryGridBox(categoryName: string): St.BoxLayout {
            let box = this._categoryGridBoxes.get(categoryName);
            if (!box) {
                box = new St.BoxLayout({
                    style_class: 'ormic-grid-box',
                    orientation: Clutter.Orientation.VERTICAL,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                });
                this._categoryGridBoxes.set(categoryName, box);
            }
            return box;
        }

        // UI Container Boxes
        _entryBox!: St.BoxLayout;
        _entry!: St.Entry;

        // Search Results List
        _scroll!: St.ScrollView;
        _rbox!: St.BoxLayout;
        _tips!: St.BoxLayout;

        // Grid Library View
        _headerBox!: St.BoxLayout;
        _headerTitleLabel!: St.Label;
        _editBtn!: St.Button;
        _deleteBtn!: St.Button;

        _gridScroll!: St.ScrollView;
        _tabsBox!: St.BoxLayout;
        _vsep!: St.Widget;

        // Page navigation bar
        _pageNavBox!: St.BoxLayout;
        _pageDotsBox!: St.BoxLayout;
        _prevPageBtn!: St.Button;
        _nextPageBtn!: St.Button;

        // Group Editor checklist view
        _editorBox!: St.BoxLayout;
        _editorNameEntry!: St.Entry;
        _editorScroll!: St.ScrollView;
        _editorAppsContainer!: St.BoxLayout;

        // New Group Modal Overlay
        _promptOverlay!: St.BoxLayout;
        _promptEntry!: St.Entry;

        _init() {
            super._init({ style_class: 'ormic-dialog', orientation: Clutter.Orientation.VERTICAL, reactive: true });
            // No Shell.BlurEffect here — background blur is handled by the
            // Clutter.Clone wallpaper actor in OrmicLauncherExtension.enable().
        }

        setup(ext: OrmicLauncherExtension) {
            this._ext = ext;
            this._providers = ext.providers;
            this._results = [];
            this._selIdx = -1;
            this._tid = null;
            this._gen = 0;
            this._shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });

            this._categoryGridBoxes = new Map();
            this._allAppsCache = [];
            this._allAppsCacheDirty = true;

            // ── Search row ────────────────────────────────────────────────
            this._entryBox = new St.BoxLayout({ style_class: 'ormic-search-row', x_expand: true });
            this._entryBox.add_child(new St.Icon({
                icon_name: 'system-search-symbolic',
                style_class: 'ormic-search-icon', icon_size: 18,
            }));
            this._entry = new St.Entry({
                style_class: 'ormic-entry',
                hint_text: _('Search apps, calculate, > command, win  windows…'),
                x_expand: true, can_focus: true,
            });
            this._entry.clutter_text.connect('text-changed', () => this._onText());
            this._entry.clutter_text.connect('key-press-event', (_, ev) => this._onKey(ev));

            // ── Click outside dialog to close ─────────────────────────────
            this.connect('button-press-event', (_, ev) => {
                this._ext._setClickGuard();

                let actor: any = ev.get_source();
                let isInteractive = false;
                while (actor && actor !== (this as any)) {
                    const cName = actor.constructor?.name || '';
                    if (actor instanceof St.Entry ||
                        actor instanceof St.ScrollBar ||
                        actor instanceof St.Button ||
                        cName.includes('Button') ||
                        cName.includes('Entry') ||
                        cName.includes('ScrollBar') ||
                        cName.includes('Tab') ||
                        cName.includes('Row') ||
                        cName.includes('Item')) {
                        isInteractive = true;
                        break;
                    }
                    actor = actor.get_parent?.();
                }
                if (!isInteractive) {
                    timeoutOnce(10, () => this.focus());
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this.connect('scroll-event', (_, ev) => {
                const dir = ev.get_scroll_direction();
                let delta = 0;
                if (dir === Clutter.ScrollDirection.UP) delta = -1;
                else if (dir === Clutter.ScrollDirection.DOWN) delta = 1;
                else if (dir === Clutter.ScrollDirection.SMOOTH) {
                    const [, dy] = ev.get_scroll_delta();
                    if (dy < 0) delta = -1;
                    else if (dy > 0) delta = 1;
                }


                // Search/editor view: scroll the list
                let sv: St.ScrollView | null = null;
                if (this._scroll.visible) sv = this._scroll;
                else if (this._editorScroll.visible) sv = this._editorScroll;
                if (sv && sv.vscrollbar_visible && sv.vadjustment) {
                    const adj = sv.vadjustment;
                    const step = adj.step_increment * 2.5;
                    if (delta === -1) { adj.set_value(adj.value - step); return Clutter.EVENT_STOP; }
                    if (delta === 1)  { adj.set_value(adj.value + step); return Clutter.EVENT_STOP; }
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._entryBox.add_child(this._entry);

            const closeBtn = new St.Button({
                child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 18 }),
                style_class: 'ormic-close-btn',
                reactive: true, track_hover: true, can_focus: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            closeBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._ext.hide();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._entryBox.add_child(closeBtn);

            // ── Search Results ────────────────────────────────────────────
            this._scroll = new St.ScrollView({
                style_class: 'ormic-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true, x_expand: true,
            });
            this._rbox = new St.BoxLayout({
                style_class: 'ormic-rbox', orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            });
            this._scroll.set_child(this._rbox);
            this._scroll.hide();

            // ── Tip bar ───────────────────────────────────────────────────
            this._tips = new St.BoxLayout({ style_class: 'ormic-tips', x_expand: true });
            for (const [k, v] of [
                ['↑↓', _('Navigate')], ['↵', _('Open')], ['Tab', _('Complete')],
                ['Esc', _('Close')], ['>', _('Command')],
                ['win ', _('Windows')],
            ]) {
                const innerT = new St.BoxLayout({ style_class: 'ormic-tip' });
                innerT.add_child(new St.Label({ text: k, style_class: 'ormic-tip-key' }));
                innerT.add_child(new St.Label({ text: ` ${v}`, style_class: 'ormic-tip-val' }));
                this._tips.add_child(innerT);
            }

            // ── Library Grid Header ────────────────────────────────────────────
            // Compact action-only header — active category shown in the tab bar
            this._headerBox = new St.BoxLayout({
                style_class: 'ormic-header',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });

            // Keep a stub title label (never shown) so state references don’t break
            this._headerTitleLabel = new St.Label({
                text: this._activeCategory,
                style_class: 'ormic-header-title',
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });

            const controlBox = new St.BoxLayout({
                style_class: 'ormic-header-control',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._editBtn = new St.Button({
                child: new St.Icon({ icon_name: 'document-edit-symbolic', icon_size: 16 }),
                style_class: 'ormic-header-btn edit-btn',
                reactive: true, track_hover: true,
            });
            this._editBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._startEditing();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            controlBox.add_child(this._editBtn);

            this._deleteBtn = new St.Button({
                child: new St.Icon({ icon_name: 'user-trash-symbolic', icon_size: 16 }),
                style_class: 'ormic-header-btn delete-btn',
                reactive: true, track_hover: true,
            });
            this._deleteBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._deleteActiveCategory();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            controlBox.add_child(this._deleteBtn);

            this._headerBox.add_child(controlBox);

            // ── Library Grid Scroll Box (no scrolling — pages used instead) ──
            this._gridScroll = new St.ScrollView({
                style_class: 'ormic-grid-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true, x_expand: true, y_expand: true,
            });

            // ── Page Navigation Bar (arrows + dots) ──────────────────────
            this._pageNavBox = new St.BoxLayout({
                style_class: 'ormic-page-nav',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._prevPageBtn = new St.Button({
                style_class: 'ormic-page-btn',
                child: new St.Icon({ icon_name: 'go-previous-symbolic', icon_size: 14 }),
                reactive: true, track_hover: true, can_focus: false,
            });
            this._prevPageBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._gridCtrl.prevPage();
                    this.focus();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._pageDotsBox = new St.BoxLayout({
                style_class: 'ormic-page-dots',
                x_align: Clutter.ActorAlign.CENTER,
            });

            this._nextPageBtn = new St.Button({
                style_class: 'ormic-page-btn',
                child: new St.Icon({ icon_name: 'go-next-symbolic', icon_size: 14 }),
                reactive: true, track_hover: true, can_focus: false,
            });
            this._nextPageBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._gridCtrl.nextPage();
                    this.focus();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._pageNavBox.add_child(this._prevPageBtn);
            this._pageNavBox.add_child(this._pageDotsBox);
            this._pageNavBox.add_child(this._nextPageBtn);
            this._pageNavBox.hide(); // hidden until multiple pages exist

            // ── Top Header Tabs Container ─────────────────────────────────
            this._tabsBox = new St.BoxLayout({
                style_class: 'ormic-tabs-box',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                reactive: true,
            });
            this._tabsBox.connect('scroll-event', (_, ev) => {
                const dir = ev.get_scroll_direction();
                let delta = 0;
                if (dir === Clutter.ScrollDirection.UP) {
                    delta = -1;
                } else if (dir === Clutter.ScrollDirection.DOWN) {
                    delta = 1;
                } else if (dir === Clutter.ScrollDirection.SMOOTH) {
                    const [, dy] = ev.get_scroll_delta();
                    if (dy < 0) delta = -1;
                    else if (dy > 0) delta = 1;
                }

                if (delta !== 0) {
                    const cats = this._getCategoriesList();
                    const idx = cats.indexOf(this._activeCategory);
                    if (idx > -1) {
                        const n = cats.length;
                        this._selectCategory(cats[(idx + delta + n) % n]);
                        this.focus();
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._vsep = new St.Widget({ style_class: 'ormic-vsep', y_expand: true });
            this._vsep.hide();

            // ── Group Editor Screen ───────────────────────────────────────
            this._editorBox = new St.BoxLayout({
                style_class: 'ormic-editor-box', orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true,
            });
            this._editorBox.hide();

            const edHeader = new St.BoxLayout({ style_class: 'ormic-editor-header', x_expand: true });
            edHeader.add_child(new St.Label({
                text: _('Group Name: '),
                style_class: 'ormic-editor-label',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._editorNameEntry = new St.Entry({
                style_class: 'ormic-editor-entry',
                x_expand: true,
            });
            edHeader.add_child(this._editorNameEntry);

            const edBtnBox = new St.BoxLayout({ style_class: 'ormic-editor-btn-box' });

            const cancelEdBtn = new St.Button({
                label: _('Cancel'), style_class: 'ormic-editor-btn cancel-btn',
                reactive: true, track_hover: true,
            });
            cancelEdBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._stopEditing(false);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            edBtnBox.add_child(cancelEdBtn);

            const saveEdBtn = new St.Button({
                label: _('Done'), style_class: 'ormic-editor-btn save-btn',
                reactive: true, track_hover: true,
            });
            saveEdBtn.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._stopEditing(true);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            edBtnBox.add_child(saveEdBtn);

            edHeader.add_child(edBtnBox);
            this._editorBox.add_child(edHeader);

            this._editorScroll = new St.ScrollView({
                style_class: 'ormic-editor-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true, x_expand: true, y_expand: true,
            });
            this._editorAppsContainer = new St.BoxLayout({
                style_class: 'ormic-editor-apps', orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            });
            this._editorScroll.set_child(this._editorAppsContainer);
            this._editorBox.add_child(this._editorScroll);

            // ── Prompt Modal Overlay ──────────────────────────────────────
            this._promptOverlay = new St.BoxLayout({
                style_class: 'ormic-prompt-overlay',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true, y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: true,
            });
            this._promptOverlay.hide();

            const promptCard = new St.BoxLayout({
                style_class: 'ormic-prompt-card',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                reactive: true,
            });
            try {
                promptCard.add_effect_with_name('blur', createBlurEffect(36, 0.88));
            } catch (e: any) {
                log(`Ormic Launcher: prompt card blur error: ${e.message}`);
            }

            this._promptOverlay.connect('button-press-event', (_, ev) => {
                const [x, y] = ev.get_coords();
                const [success, lx, ly] = promptCard.transform_stage_point(x, y);
                const insideCard = success && lx >= 0 && lx <= promptCard.width && ly >= 0 && ly <= promptCard.height;
                if (!insideCard) {
                    this._hidePromptOverlay(false);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            promptCard.add_child(new St.Label({
                text: _('Create New Group'),
                style_class: 'ormic-prompt-title',
            }));
            this._promptEntry = new St.Entry({
                style_class: 'ormic-prompt-entry',
                hint_text: _('Group name…'),
                x_expand: true,
            });
            promptCard.add_child(this._promptEntry);

            const promptBtns = new St.BoxLayout({
                style_class: 'ormic-prompt-btns',
                x_align: Clutter.ActorAlign.END,
            });
            const pCancel = new St.Button({
                label: _('Cancel'), style_class: 'ormic-prompt-btn cancel-btn',
                reactive: true, track_hover: true,
            });
            pCancel.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._hidePromptOverlay(false);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            promptBtns.add_child(pCancel);

            const pCreate = new St.Button({
                label: _('Create'), style_class: 'ormic-prompt-btn create-btn',
                reactive: true, track_hover: true,
            });
            pCreate.connect('button-release-event', (actor, ev) => {
                if (ev.get_button() === 1) {
                    this._hidePromptOverlay(true);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            promptBtns.add_child(pCreate);

            promptCard.add_child(promptBtns);
            this._promptOverlay.add_child(promptCard);

            // Assemble everything
            this.add_child(this._entryBox);
            this.add_child(new St.Widget({ style_class: 'ormic-sep', x_expand: true }));

            this._tabsBox.orientation = Clutter.Orientation.HORIZONTAL;
            this._tabsBox.x_expand = true;
            this._tabsBox.y_expand = false;
            this._tabsBox.x_align = Clutter.ActorAlign.FILL;
            this._tabsBox.y_align = Clutter.ActorAlign.START;

            const tabsScroll = new St.ScrollView({
                style_class: 'ormic-tabs-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.NEVER,
                overlay_scrollbars: true,
                x_expand: true,
            });
            tabsScroll.set_child(this._tabsBox);
            this.add_child(tabsScroll);

            const contentContainer = new St.BoxLayout({
                style_class: 'ormic-content-container',
                x_expand: true, y_expand: true,
            });

            const rightPanel = new St.BoxLayout({
                style_class: 'ormic-right-panel',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true, y_expand: true,
            });
            rightPanel.add_child(this._scroll);
            rightPanel.add_child(this._headerBox);
            rightPanel.add_child(this._gridScroll);
            rightPanel.add_child(this._pageNavBox);
            rightPanel.add_child(this._editorBox);
            rightPanel.add_child(this._promptOverlay);

            contentContainer.add_child(rightPanel);
            this.add_child(contentContainer);

            this.add_child(new St.Widget({ style_class: 'ormic-sep', x_expand: true }));
            this.add_child(this._tips);

            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const dialog = this;
            this._state = {
                ext: {
                    _settings: ext._settings,
                    hide: () => ext.hide(),
                    _setClickGuard: () => ext._setClickGuard(),
                },
                providers: ext.providers,
                shellSettings: this._shellSettings,

                get results() { return dialog._results; },
                set results(v) { dialog._results = v; },

                get selIdx() { return dialog._selIdx; },
                set selIdx(v) { dialog._selIdx = v; },

                get tid() { return dialog._tid; },
                set tid(v) { dialog._tid = v; },

                get gen() { return dialog._gen; },
                set gen(v) { dialog._gen = v; },

                get categoryGridBoxes() { return dialog._categoryGridBoxes; },
                set categoryGridBoxes(v) { dialog._categoryGridBoxes = v; },

                get allAppsCache() { return dialog._allAppsCache; },
                set allAppsCache(v) { dialog._allAppsCache = v; },

                get allAppsCacheDirty() { return dialog._allAppsCacheDirty; },
                set allAppsCacheDirty(v) { dialog._allAppsCacheDirty = v; },

                get renderIdleId() { return dialog._renderIdleId; },
                set renderIdleId(v) { dialog._renderIdleId = v; },

                get bgRenderIdleId() { return dialog._bgRenderIdleId; },
                set bgRenderIdleId(v) { dialog._bgRenderIdleId = v; },

                get bgRenderQueue() { return dialog._bgRenderQueue; },
                set bgRenderQueue(v) { dialog._bgRenderQueue = v; },

                get activeCategory() { return dialog._activeCategory; },
                set activeCategory(v) { dialog._activeCategory = v; },

                get isEditing() { return dialog._isEditing; },
                set isEditing(v) { dialog._isEditing = v; },

                get gridSelIdx() { return dialog._gridSelIdx; },
                set gridSelIdx(v) { dialog._gridSelIdx = v; },

                entryBox: this._entryBox,
                entry: this._entry,
                scroll: this._scroll,
                rbox: this._rbox,
                tips: this._tips,
                headerBox: this._headerBox,
                headerTitleLabel: this._headerTitleLabel,
                editBtn: this._editBtn,
                deleteBtn: this._deleteBtn,
                gridScroll: this._gridScroll,
                tabsBox: this._tabsBox,
                vsep: this._vsep,
                editorBox: this._editorBox,
                editorNameEntry: this._editorNameEntry,
                editorScroll: this._editorScroll,
                editorAppsContainer: this._editorAppsContainer,
                promptOverlay: this._promptOverlay,
                promptEntry: this._promptEntry,
                pageNavBox: this._pageNavBox,
                pageDotsBox: this._pageDotsBox,
                prevPageBtn: this._prevPageBtn,
                nextPageBtn: this._nextPageBtn,

                focus: () => this.focus(),
                getGridBox: () => this._gridBox,
                getCategoryGridBox: (name: string) => this._getCategoryGridBox(name),
                setTabsVisible: (v: boolean) => this._setTabsVisible(v),
                isDestroyed: () => (this as any).is_finalized?.() ?? false,
            };

            this._searchCtrl = new SearchController(this._state);
            this._gridCtrl = new GridController(this._state);
            this._groupCtrl = new GroupEditorController(this._state, this._gridCtrl);
            this._kbdHandler = new KeyboardHandler(this._state, this._searchCtrl, this._gridCtrl, this._groupCtrl);
        }

        vfunc_key_press_event(ev: Clutter.Event): boolean { return this._onKey(ev); }

        private _onKey(ev: any): boolean {
            return this._kbdHandler.onKey(ev);
        }

        private _setTabsVisible(visible: boolean) {
            const shouldShowGroups = this._ext._settings.get_boolean('show-groups-sidebar');
            if (visible && shouldShowGroups) {
                this._tabsBox.get_parent()?.show();
                this._tabsBox.show();
            } else {
                this._tabsBox.get_parent()?.hide();
                this._tabsBox.hide();
            }
        }

        private _onText() {
            this._searchCtrl.onText();
        }

        // ─── Search View ─────────────────────────────────────────────────

        private _selectIdx(i: number) { this._searchCtrl.selectIdx(i); }
        private _moveSel(d: number) { this._searchCtrl.moveSel(d); }
        private _activateSel() { this._searchCtrl.activateSel(); }
        private _activateIdx(i: number) { this._searchCtrl.activateIdx(i); }
        private _complete() { this._searchCtrl.complete(); }

        // ─── Grid View ────────────────────────────────────────────────────

        private _ensureAllAppsCache() { this._gridCtrl.ensureAllAppsCache(); }

        private _cancelRenderJob() { this._gridCtrl.cancelRenderJob(); }
        private _cancelBgRenderJob() { this._gridCtrl.cancelBgRenderJob(); }

        cleanup() {
            this._gridCtrl.cleanup();
            this._cancelRenderJob();
            this._cancelBgRenderJob();
            if (this._tid != null) {
                GLib.source_remove(this._tid as number);
                this._tid = null;
            }
            if (this._categoryGridBoxes) {
                this._categoryGridBoxes.forEach(box => {
                    try { box.destroy(); } catch (_) { }
                });
                this._categoryGridBoxes.clear();
            }
        }

        private _selectCategory(categoryName: string) {
            this._gridCtrl.selectCategory(categoryName);
        }

        // ─── Tabs & grid rendering — all delegated to GridController ─────
        // BUG FIX: the old LauncherDialog had its own _renderTabsOnly that
        // diverged from GridController.renderTabsOnly, causing tab state to be
        // inconsistent after group create/edit.  Now every render path goes
        // through a single authoritative implementation in GridController.

        private _renderTabsOnly() {
            this._gridCtrl.renderTabsOnly();
        }

        private _renderGridOnly() {
            this._gridCtrl.renderGridOnly();
        }

        private _renderGridAndTabs() {
            this._gridCtrl.renderGridAndTabs();
        }

        private _selectGridIdx(i: number) { this._gridCtrl.selectGridIdx(i); }
        private _moveGridSel(d: number) { this._gridCtrl.moveGridSel(d); }
        private _activateGridSel() { this._gridCtrl.activateGridSel(); }

        private _startEditing() { this._groupCtrl.startEditing(); }
        private _stopEditing(save: boolean) { this._groupCtrl.stopEditing(save); }
        private _deleteActiveCategory() { this._groupCtrl.deleteActiveCategory(); }
        private _showPromptOverlay() { this._groupCtrl.showPromptOverlay(); }
        private _hidePromptOverlay(create: boolean) { this._groupCtrl.hidePromptOverlay(create); }

        private _getCategoriesList(): string[] { return this._gridCtrl.getCategoriesList(); }
        private _getCustomGroups(): Record<string, string[]> { return this._gridCtrl.getCustomGroups(); }
        private _saveCustomGroups(groups: Record<string, string[]>) { this._gridCtrl.saveCustomGroups(groups); }

        // ─── External Controls ────────────────────────────────────────────────

        focus() {
            if ((this as any).is_finalized?.() || !this.get_stage?.()) return;
            dbg('Focus', 'grab_key_focus');
            if (this._promptOverlay && this._promptOverlay.visible && this._promptEntry) {
                global.stage.set_key_focus(this._promptEntry);
                this._promptEntry.grab_key_focus();
            } else if (this._editorBox && this._editorBox.visible && this._isEditing && this._editorNameEntry) {
                global.stage.set_key_focus(this._editorNameEntry);
                this._editorNameEntry.grab_key_focus();
            } else if (this._entry) {
                global.stage.set_key_focus(this._entry);
                this._entry.grab_key_focus();
            }
        }

        reset() {
            if (this._providers) {
                for (const p of this._providers) {
                    try {
                        if (typeof p.onOpen === 'function') p.onOpen();
                    } catch (e: any) {
                        log(`Ormic Launcher: Error calling onOpen on provider: ${e.message}`);
                    }
                }
            }

            this._cancelRenderJob();
            this._cancelBgRenderJob();

            this._searchCtrl.clear();
            this._entry.text = '';
            const previousCategory = this._activeCategory;
            this._activeCategory = 'Library Home';
            this._isEditing = false;
            this._gridSelIdx = -1;
            this._editorBox.hide();
            this._promptOverlay.hide();

            this._entryBox.show();
            this._scroll.hide();
            this._headerBox.show();
            this._gridScroll.show();
            // pageNavBox visibility is managed by GridController._updatePageNav()
            this._setTabsVisible(true);

            // App dirtiness is handled inside GridController.ensureAllAppsCache() now.
            // Only rebuild the grid widget tree when it has never been built or the
            // user explicitly cleared it (custom group edit, etc.).
            const needsRebuild = this._allAppsCacheDirty || this._categoryGridBoxes.size === 0;

            if (needsRebuild) {
                dbg('Performance', `SLOW PATH: cache rebuild. allAppsCacheDirty=${this._allAppsCacheDirty}, gridBoxes=${this._categoryGridBoxes.size}`);
                this._allAppsCacheDirty = true;

                if (this._categoryGridBoxes) {
                    this._categoryGridBoxes.forEach(box => box.destroy());
                    this._categoryGridBoxes.clear();
                }

                // Single authoritative render — goes through GridController
                this._renderTabsOnly();

                const gridBox = this._gridBox;
                this._gridScroll.set_child(gridBox);

                // Render grid immediately to ensure right side shows content
                this._renderGridOnly();
            } else {
                dbg('Performance', `FAST PATH: reusing ${this._categoryGridBoxes.size} cached grid boxes`);

                // Re-sync tab selection without full rebuild
                const tabs = this._tabsBox.get_children() as CategoryTab[];
                if (tabs.length === 0) {
                    this._renderTabsOnly();
                } else {
                    tabs.forEach(tab => {
                        if (typeof tab.setSelected === 'function') {
                            tab.setSelected(tab.categoryName === this._activeCategory);
                        }
                    });
                    this._headerTitleLabel.text = this._activeCategory;
                    this._editBtn.hide();
                    this._deleteBtn.hide();
                }

                const gridBox = this._gridBox;
                this._gridScroll.set_child(gridBox);

                if (previousCategory !== 'Library Home') {
                    // We switched categories during reset, so we must render the items for Library Home
                    this._renderGridOnly();
                }

                this._gridSelIdx = -1;
                timeoutOnce(10, () => {
                    if (this._gridSelIdx === -1 && this._gridScroll.visible) {
                        this._selectGridIdx(0);
                    }
                });

                this._gridCtrl.startBackgroundPreRender();
            }
        }
    },
);
type LauncherDialog = InstanceType<typeof LauncherDialog>;

// ─── Panel indicator ──────────────────────────────────────────────────────────

const OrmicIndicator = GObject.registerClass(
    class OrmicIndicator extends PanelMenu.Button {
        _ext!: OrmicLauncherExtension;
        _init() {
            super._init(0.0, 'Ormic Launcher', true);
            this.add_child(new St.Icon({ icon_name: 'view-app-grid-symbolic', style_class: 'system-status-icon' }));
            this.connect('button-press-event', (_, ev) => {
                if ((typeof ev.get_button === 'function' ? ev.get_button() : 1) === 1) {
                    this._ext.toggle(); return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
    },
);
type OrmicIndicator = InstanceType<typeof OrmicIndicator>;

// ─── Extension ────────────────────────────────────────────────────────────────

export default class OrmicLauncherExtension extends Extension {
    providers!: any[];
    _visible!: boolean;
    _grab: any = null;
    _clickGuard = false;
    _clickGuardTimer: number | null | undefined = null;
    _settings!: Gio.Settings;
    _overlay!: St.Widget | null;
    _dialog!: LauncherDialog | null;
    _indicator!: OrmicIndicator | null;
    _blurBgClone: any = null;   // Clutter.Clone of wallpaper — GNOME-50-safe blur
    _monId!: number | null;
    _keyId!: number | null;
    _cfgId!: number | null;
    _focusId!: number | null;
    _overlayCapturedId!: number | null;
    _overlayPressId!: number | null;
    _overlayKeyId!: number | null;

    enable() {
        dbg('Extension', 'enable() called');
        this._settings = this.getSettings();
        this.providers = [
            new AppProvider(), new CalcProvider(),
            new RecentProvider(this._settings), new CommandProvider(),
            new WindowProvider(this._settings),
        ];
        this._visible = false; this._indicator = null; this._cfgId = null; this._focusId = null;

        this._overlay = new St.Widget({
            style_class: 'ormic-overlay', reactive: true, visible: false,
            x: 0, y: 0, opacity: 0,
        });

        // GNOME 50-compatible background blur.
        // Shell.BlurEffect.BACKGROUND is unreliable for top-chrome actors on GNOME 50
        // because the render pipeline no longer exposes the desktop framebuffer at that
        // layer.  Instead: clone the wallpaper background group and apply ACTOR-mode
        // blur to the clone — this always works because it blurs the clone's own texture.
        try {
            const bgGroup = (Main.layoutManager as any)._backgroundGroup;
            if (bgGroup) {
                this._blurBgClone = new Clutter.Clone({ source: bgGroup });
                this._blurBgClone.add_effect(createBlurEffect(32, 0.70, Shell.BlurMode.ACTOR));
                // Insert as first child so it renders behind the dialog
                this._overlay.insert_child_at_index(this._blurBgClone, 0);
            }
        } catch (e: any) {
            log(`Ormic: bg blur clone failed: ${e.message}`);
        }

        this._overlayCapturedId = this._overlay.connect('captured-event', (_, ev: any) => {
            const t = typeof ev.type === 'function' ? ev.type() : ev.type;
            if (t === Clutter.EventType.BUTTON_PRESS) {
                this._setClickGuard();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._overlayPressId = this._overlay.connect('button-press-event', (_, ev) => {
            const d = this._dialog;
            if (!d) { this.hide(); return Clutter.EVENT_STOP; }

            const [x, y] = ev.get_coords();
            const [success, lx, ly] = d.transform_stage_point(x, y);
            const insideDialog = success && lx >= 0 && lx <= d.width && ly >= 0 && ly <= d.height;

            dbg('OverlayPress', `stage_click=(${x}, ${y}) local_click=(${lx}, ${ly}) dialog_size=(${d.width}, ${d.height}) inside=${insideDialog}`);

            if (!insideDialog) {
                dbg('OverlayPress', 'Click outside dialog, hiding launcher');
                this.hide();
            } else {
                this._setClickGuard();
            }
            return Clutter.EVENT_STOP;
        });

        this._overlayKeyId = this._overlay.connect('key-press-event', (_, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.hide();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._dialog = new (LauncherDialog as any)() as LauncherDialog;
        this._dialog.setup(this);
        this._overlay.add_child(this._dialog);
        Main.layoutManager.addTopChrome(this._overlay);

        this._monId = Main.layoutManager.connect('monitors-changed', () => this._pos());
        this._pos();

        Main.wm.addKeybinding(
            'toggle-ormic-launcher', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this.toggle(),
        );

        this._keyId = global.stage.connect('key-press-event', (_, ev) => {
            if (this._visible && ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.hide(); return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._focusId = global.stage.connect('notify::key-focus', () => {
            if (!this._visible || !this._overlay) return;
            if (this._clickGuard) return;
            const focus = global.stage.key_focus;
            if (focus && focus !== this._overlay && !this._overlay.contains(focus)) {
                dbg('Extension', 'Focus moved outside launcher overlay, hiding');
                this.hide();
            }
        });

        this._cfgId = this._settings.connect('changed::show-indicator', () => this._syncInd());
        this._syncInd();
    }

    disable() {
        dbg('Extension', 'disable() called');
        if (this._focusId) { global.stage.disconnect(this._focusId); this._focusId = null; }
        if (this._cfgId) { this._settings.disconnect(this._cfgId); this._cfgId = null; }
        if (this._keyId) { global.stage.disconnect(this._keyId); this._keyId = null; }
        if (this._monId) { Main.layoutManager.disconnect(this._monId); this._monId = null; }
        this._indicator?.destroy(); this._indicator = null;
        Main.wm.removeKeybinding('toggle-ormic-launcher');

        if (this._overlay) {
            if (this._overlayCapturedId) this._overlay.disconnect(this._overlayCapturedId);
            if (this._overlayPressId) this._overlay.disconnect(this._overlayPressId);
            if (this._overlayKeyId) this._overlay.disconnect(this._overlayKeyId);
            this._overlay.remove_all_transitions();
            this._overlay.destroy();
        }
        this._blurBgClone = null; // was a child of overlay, destroyed above
        if (this._dialog) {
            this._dialog.remove_all_transitions();
            try {
                this._dialog.cleanup();
            } catch (e: any) {
                dbg('Extension', `Error running dialog cleanup: ${e.message}`);
            }
            this._dialog.destroy();
        }

        this._overlay = null;
        this._dialog = null;

        if (this._clickGuardTimer != null) {
            GLib.source_remove(this._clickGuardTimer);
            this._clickGuardTimer = null;
        }

        for (const p of this.providers) {
            if (typeof p.destroy === 'function') {
                try { p.destroy(); } catch (_) { }
            }
        }
        this.providers = [];
        this._settings = null as any;
        this._visible = false;
    }

    _syncInd() {
        if (this._settings.get_boolean('show-indicator')) {
            if (!this._indicator) {
                const ind = new (OrmicIndicator as any)() as OrmicIndicator;
                ind._ext = this; this._indicator = ind;
                Main.panel.addToStatusArea('ormic-launcher', this._indicator, 0, 'left');
            }
        } else { this._indicator?.destroy(); this._indicator = null; }
    }

    _pos() {
        if (!this._overlay || !this._dialog) return;
        const mon = Main.layoutManager.primaryMonitor; if (!mon) return;
        const dw = Math.min(1060, mon.width * 0.66);
        const dx = mon.x + Math.floor((mon.width - dw) / 2);
        const dy = mon.y + Math.floor(mon.height * 0.14);
        this._overlay.set_position(mon.x, mon.y);
        this._overlay.set_size(mon.width, mon.height);
        // Size the blur clone to fill the monitor (it is at index 0 inside the overlay)
        if (this._blurBgClone) {
            this._blurBgClone.set_size(mon.width, mon.height);
        }
        this._dialog.set_position(dx - mon.x, dy - mon.y);
        this._dialog.set_width(dw);
        this._dialog.min_width = dw;
        (this._dialog as any).max_width = dw;
    }

    toggle() {
        if (this._visible) this.hide();
        else this.show();
    }

    show() {
        dbg('Launcher', 'show()');
        if (this._visible) return;
        if (!this._dialog || !this._overlay) return;

        this._overlay.remove_all_transitions();
        this._dialog.remove_all_transitions();

        this._visible = true;
        this._dialog.reset();
        this._overlay.show();
        this._dialog.opacity = 0;
        this._dialog.translation_y = -20;

        const grab = Main.pushModal(this._overlay, {
            actionMode: Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
        });
        if (!grab) {
            this._visible = false;
            this._grab = null;
            this._overlay.hide();
            return;
        }
        this._grab = grab;

        easeActor(this._overlay, { opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        easeActor(this._dialog, { opacity: 255, translation_y: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_EXPO });
        timeoutOnce(10, () => this._dialog?.focus());
    }

    hide() {
        dbg('Launcher', 'hide()');
        if (!this._visible) return;
        if (!this._dialog || !this._overlay) return;

        this._overlay.remove_all_transitions();
        this._dialog.remove_all_transitions();

        this._visible = false;
        this._clickGuard = false;
        if (this._clickGuardTimer != null) {
            GLib.source_remove(this._clickGuardTimer as number);
            this._clickGuardTimer = null;
        }
        if (this._grab) {
            try { Main.popModal(this._grab); }
            catch (e: any) { dbg('Launcher', `popModal failed: ${e.message}`); }
            this._grab = null;
        }
        const ov = this._overlay, dl = this._dialog;
        easeActor(dl, {
            opacity: 0, translation_y: -14, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (ov && !(ov as any).is_finalized?.() && dl && !(dl as any).is_finalized?.()) {
                    ov.hide();
                    dl.opacity = 255;
                    dl.translation_y = 0;
                }
            },
        });
        easeActor(ov, { opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD });
    }

    _setClickGuard() {
        this._clickGuard = true;
        if (this._clickGuardTimer != null) {
            GLib.source_remove(this._clickGuardTimer as number);
        }
        this._clickGuardTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._clickGuard = false;
            this._clickGuardTimer = null;
            return GLib.SOURCE_REMOVE;
        });
    }
}