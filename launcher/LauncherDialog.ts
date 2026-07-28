// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Launcher Dialog Component
// Copyright (C) 2026 oliwebd

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { SearchResult } from '../types.js';
import {
    logDebug,
    timeoutOnce,
    boxLayoutParams,
} from '../utils.js';

import { SearchController } from './SearchController.js';
import { GridController } from './GridController.js';
import { GroupEditorController } from './GroupEditorController.js';
import { KeyboardHandler } from './KeyboardHandler.js';
import { LauncherState } from './LauncherState.js';
import { CategoryTab } from '../components/CategoryTab.js';

import type OrmicLauncherExtension from '../extension.js';

export class LauncherDialog extends St.BoxLayout {
    static {
        GObject.registerClass({ GTypeName: 'OrmicLauncherDialog' }, this);
    }

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
                ...boxLayoutParams(true),
                style_class: 'ormic-grid-box',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._categoryGridBoxes.set(categoryName, box);
        }
        return box;
    }

    _entryBox!: St.BoxLayout;
    _entry!: St.Entry;

    _scroll!: St.ScrollView;
    _rbox!: St.BoxLayout;
    _tips!: St.BoxLayout;

    _headerBox!: St.BoxLayout;
    _headerTitleLabel!: St.Label;
    _editBtn!: St.Button;
    _deleteBtn!: St.Button;

    _gridScroll!: St.ScrollView;
    _tabsBox!: St.BoxLayout;
    _vsep!: St.Widget;

    _pageNavBox!: St.BoxLayout;
    _pageDotsBox!: St.BoxLayout;
    _prevPageBtn!: St.Button;
    _nextPageBtn!: St.Button;

    _editorBox!: St.BoxLayout;
    _editorNameEntry!: St.Entry;
    _editorScroll!: St.ScrollView;
    _editorAppsContainer!: St.BoxLayout;

    _promptOverlay!: St.BoxLayout;
    _promptEntry!: St.Entry;

    _init() {
        super._init({ style_class: 'ormic-dialog', ...boxLayoutParams(true), reactive: true });
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

        this.connect('button-press-event', (_, ev) => {
            this._ext._setClickGuard();

            let actor: any = ev.get_source();
            let isInteractive = false;
            while (actor && actor !== (this as any)) {
                const cName = actor.constructor.name || '';
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
                actor = actor.get_parent();
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

            let sv: St.ScrollView | null = null;
            if (this._scroll.visible) sv = this._scroll;
            else if (this._editorScroll.visible) sv = this._editorScroll;
            if (sv && sv.vscrollbar_visible && sv.vadjustment) {
                const adj = sv.vadjustment;
                const step = adj.step_increment * 2.5;
                if (delta === -1) { adj.set_value(adj.value - step); return Clutter.EVENT_STOP; }
                if (delta === 1) { adj.set_value(adj.value + step); return Clutter.EVENT_STOP; }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._entryBox.add_child(this._entry);

        const settingsBtn = new St.Button({
            child: new St.Icon({ icon_name: 'preferences-system-symbolic', icon_size: 16 }),
            style_class: 'ormic-settings-btn',
            reactive: true, track_hover: true, can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        settingsBtn.connect('clicked', () => {
            this._ext.hide();
            this._ext.openPreferences();
        });
        this._entryBox.add_child(settingsBtn);

        const closeBtn = new St.Button({
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 18 }),
            style_class: 'ormic-close-btn',
            reactive: true, track_hover: true, can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        closeBtn.connect('clicked', () => {
            this._ext.hide();
        });
        this._entryBox.add_child(closeBtn);

        this._scroll = new St.ScrollView({
            style_class: 'ormic-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, x_expand: true, y_expand: true,
        });
        this._rbox = new St.BoxLayout({
            style_class: 'ormic-rbox', ...boxLayoutParams(true), x_expand: true,
        });
        this._scroll.set_child(this._rbox);
        this._scroll.hide();

        this._tips = new St.BoxLayout({ style_class: 'ormic-tips', x_expand: true });
        (this._tips.layout_manager as Clutter.BoxLayout).spacing = 12;
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

        this._headerBox = new St.BoxLayout({
            style_class: 'ormic-header',
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

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
        this._editBtn.connect('clicked', () => {
            this._startEditing();
        });
        controlBox.add_child(this._editBtn);

        this._deleteBtn = new St.Button({
            child: new St.Icon({ icon_name: 'user-trash-symbolic', icon_size: 16 }),
            style_class: 'ormic-header-btn delete-btn',
            reactive: true, track_hover: true,
        });
        this._deleteBtn.connect('clicked', () => {
            this._deleteActiveCategory();
        });
        controlBox.add_child(this._deleteBtn);

        this._headerBox.add_child(controlBox);

        this._gridScroll = new St.ScrollView({
            style_class: 'ormic-grid-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, x_expand: true, y_expand: true,
        });

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
        this._prevPageBtn.connect('clicked', () => {
            this._gridCtrl.prevPage();
            this.focus();
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
        this._nextPageBtn.connect('clicked', () => {
            this._gridCtrl.nextPage();
            this.focus();
        });

        this._pageNavBox.add_child(this._prevPageBtn);
        this._pageNavBox.add_child(this._pageDotsBox);
        this._pageNavBox.add_child(this._nextPageBtn);
        this._pageNavBox.hide();

        this._tabsBox = new St.BoxLayout({
            style_class: 'ormic-tabs-box',
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
        this._vsep = new St.Widget({ name: 'ormic-vsep', style_class: 'ormic-vsep', y_expand: true });
        this._vsep.hide();

        this._editorBox = new St.BoxLayout({
            style_class: 'ormic-editor-box', ...boxLayoutParams(true), x_expand: true, y_expand: true,
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
        cancelEdBtn.connect('clicked', () => {
            this._stopEditing(false);
        });
        edBtnBox.add_child(cancelEdBtn);

        const saveEdBtn = new St.Button({
            label: _('Done'), style_class: 'ormic-editor-btn save-btn',
            reactive: true, track_hover: true,
        });
        saveEdBtn.connect('clicked', () => {
            this._stopEditing(true);
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
            style_class: 'ormic-editor-apps', ...boxLayoutParams(true), x_expand: true,
        });
        this._editorScroll.set_child(this._editorAppsContainer);
        this._editorBox.add_child(this._editorScroll);

        this._promptOverlay = new St.BoxLayout({
            style_class: 'ormic-prompt-overlay',
            ...boxLayoutParams(true),
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        this._promptOverlay.hide();

        const promptCard = new St.BoxLayout({
            style_class: 'ormic-prompt-card',
            ...boxLayoutParams(true),
            x_expand: true,
            reactive: true,
        });

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
        (promptBtns.layout_manager as Clutter.BoxLayout).spacing = 8;
        const pCancel = new St.Button({
            label: _('Cancel'), style_class: 'ormic-prompt-btn cancel-btn',
            reactive: true, track_hover: true,
        });
        pCancel.connect('clicked', () => {
            this._hidePromptOverlay(false);
        });
        promptBtns.add_child(pCancel);

        const pCreate = new St.Button({
            label: _('Create'), style_class: 'ormic-prompt-btn create-btn',
            reactive: true, track_hover: true,
        });
        pCreate.connect('clicked', () => {
            this._hidePromptOverlay(true);
        });
        promptBtns.add_child(pCreate);

        promptCard.add_child(promptBtns);
        this._promptOverlay.add_child(promptCard);

        this.add_child(this._entryBox);
        this.add_child(new St.Widget({ name: 'ormic-sep-tabs', style_class: 'ormic-sep', x_expand: true }));

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
            ...boxLayoutParams(true),
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

        this.add_child(new St.Widget({ name: 'ormic-sep-bottom', style_class: 'ormic-sep', x_expand: true }));
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
            this._tabsBox.get_parent()!.show();
            this._tabsBox.show();
        } else {
            this._tabsBox.get_parent()!.hide();
            this._tabsBox.hide();
        }
    }

    private _onText() {
        this._searchCtrl.onText();
    }

    private _selectIdx(i: number) { this._searchCtrl.selectIdx(i); }
    private _moveSel(d: number) { this._searchCtrl.moveSel(d); }
    private _activateSel() { this._searchCtrl.activateSel(); }
    private _activateIdx(i: number) { this._searchCtrl.activateIdx(i); }
    private _complete() { this._searchCtrl.complete(); }

    private _ensureAllAppsCache() { this._gridCtrl.ensureAllAppsCache(); }

    private _cancelRenderJob() { this._gridCtrl.cancelRenderJob(); }

    cleanup() {
        this._gridCtrl.cleanup();
        this._cancelRenderJob();
        if (this._tid != null) {
            GLib.source_remove(this._tid as number);
            this._tid = null;
        }
        if (this._categoryGridBoxes) {
            this._categoryGridBoxes.forEach(box => box.destroy());
            this._categoryGridBoxes.clear();
        }
    }

    private _selectCategory(categoryName: string) {
        this._gridCtrl.selectCategory(categoryName);
    }

    private _renderTabsOnly() { this._gridCtrl.renderTabsOnly(); }
    private _renderGridOnly() { this._gridCtrl.renderGridOnly(); }
    private _renderGridAndTabs() { this._gridCtrl.renderGridAndTabs(); }

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

    focus() {
        if (!this.get_stage()) return;
        logDebug('Focus', 'grab_key_focus');
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
        for (const p of this._providers) {
            if (p.onOpen) p.onOpen();
        }

        this._cancelRenderJob();

        this._searchCtrl.clear();
        this._entry.set_text('');
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
        this._setTabsVisible(true);

        const needsRebuild = this._allAppsCacheDirty || this._categoryGridBoxes.size === 0;

        if (needsRebuild) {
            logDebug('Performance', `SLOW PATH: cache rebuild. allAppsCacheDirty=${this._allAppsCacheDirty}, gridBoxes=${this._categoryGridBoxes.size}`);
            this._allAppsCacheDirty = true;

            this._gridCtrl.harvestItems();

            if (this._categoryGridBoxes) {
                this._categoryGridBoxes.forEach(box => box.destroy());
                this._categoryGridBoxes.clear();
            }

            this._renderTabsOnly();

            const gridBox = this._gridBox;
            this._gridScroll.set_child(gridBox);
            this._renderGridOnly();
        } else {
            logDebug('Performance', `FAST PATH: reusing ${this._categoryGridBoxes.size} cached grid boxes`);

            const tabs = this._tabsBox.get_children() as CategoryTab[];
            if (tabs.length === 0) {
                this._renderTabsOnly();
            } else {
                tabs.forEach(tab => {
                    tab.setSelected(tab.categoryName === this._activeCategory);
                });
                this._headerTitleLabel.text = this._activeCategory;
                this._editBtn.hide();
                this._deleteBtn.hide();
            }

            const gridBox = this._gridBox;
            this._gridScroll.set_child(gridBox);

            if (previousCategory !== 'Library Home') {
                this._renderGridOnly();
            }

            this._gridSelIdx = -1;
            timeoutOnce(10, () => {
                if (this._gridSelIdx === -1 && this._gridScroll.visible) {
                    this._selectGridIdx(0);
                }
            });
        }
    }
}
