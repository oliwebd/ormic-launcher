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
import Pango from 'gi://Pango';
import PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { SearchResult } from './types.js';
import {
    dbg,
    timeoutOnce,
    easeActor,
    scrollToActor,
    createAppIcon
} from './utils.js';

import { AppProvider } from './providers/apps.js';
import { CalcProvider } from './providers/calc.js';
import { RecentProvider } from './providers/recent.js';
import { CommandProvider } from './providers/command.js';
import { WindowProvider } from './providers/window.js';

import { GridItem } from './components/GridItem.js';
import { CategoryTab } from './components/CategoryTab.js';
import { EditAppRow } from './components/EditAppRow.js';
import { ResultRow } from './components/ResultRow.js';

// ─── Launcher Dialog ──────────────────────────────────────────────────────────

const LauncherDialog = GObject.registerClass(
    class LauncherDialog extends St.BoxLayout {
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
                    style_class: 'ormic-grid-box', vertical: true, x_expand: true,
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

        // Group Editor checklist view
        _editorBox!: St.BoxLayout;
        _editorNameEntry!: St.Entry;
        _editorScroll!: St.ScrollView;
        _editorAppsContainer!: St.BoxLayout;

        // New Group Modal Overlay
        _promptOverlay!: St.BoxLayout;
        _promptEntry!: St.Entry;

        _init() {
            super._init({ style_class: 'ormic-dialog', vertical: true, reactive: true });
            try {
                const blur = new Shell.BlurEffect({
                    brightness: 0.95,
                    mode: Shell.BlurMode.BACKGROUND,
                });
                // @ts-ignore
                blur.sigma = 65;
                this.add_effect_with_name('blur', blur);
            } catch (e: any) {
                log(`Ormic Launcher: blur effect error: ${e.message}`);
            }
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
                let sv: St.ScrollView | null = null;
                if (this._scroll.visible) sv = this._scroll;
                else if (this._gridScroll.visible) sv = this._gridScroll;
                else if (this._editorScroll.visible) sv = this._editorScroll;

                if (sv && sv.vscrollbar_visible && sv.vadjustment) {
                    const adj = sv.vadjustment;
                    const dir = ev.get_scroll_direction();
                    const step = adj.step_increment * 2.5;
                    if (dir === Clutter.ScrollDirection.UP) {
                        adj.set_value(adj.value - step);
                        return Clutter.EVENT_STOP;
                    } else if (dir === Clutter.ScrollDirection.DOWN) {
                        adj.set_value(adj.value + step);
                        return Clutter.EVENT_STOP;
                    } else if (dir === Clutter.ScrollDirection.SMOOTH) {
                        const [dx, dy] = ev.get_scroll_delta();
                        adj.set_value(adj.value + dy * step);
                        return Clutter.EVENT_STOP;
                    }
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
                style_class: 'ormic-rbox', vertical: true, x_expand: true,
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

            // ── Library Grid Header ────────────────────────────────────────
            this._headerBox = new St.BoxLayout({ style_class: 'ormic-header', x_expand: true });

            const leftSpacer = new St.Widget({ x_expand: true });
            this._headerBox.add_child(leftSpacer);

            this._headerTitleLabel = new St.Label({
                text: this._activeCategory,
                style_class: 'ormic-header-title',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._headerBox.add_child(this._headerTitleLabel);

            const controlBox = new St.BoxLayout({
                style_class: 'ormic-header-control',
                x_expand: true,
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

            // ── Library Grid Scroll Box ──────────────────────────────────
            this._gridScroll = new St.ScrollView({
                style_class: 'ormic-grid-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true, x_expand: true, y_expand: true,
            });

            // ── Left Sidebar Tabs Container ───────────────────────────────
            this._tabsBox = new St.BoxLayout({
                style_class: 'ormic-tabs-box',
                vertical: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.FILL,
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
                    const [dx, dy] = ev.get_scroll_delta();
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

            // ── Group Editor Screen ───────────────────────────────────────
            this._editorBox = new St.BoxLayout({
                style_class: 'ormic-editor-box', vertical: true, x_expand: true, y_expand: true,
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
                style_class: 'ormic-editor-apps', vertical: true, x_expand: true,
            });
            this._editorScroll.set_child(this._editorAppsContainer);
            this._editorBox.add_child(this._editorScroll);

            // ── Prompt Modal Overlay ──────────────────────────────────────
            this._promptOverlay = new St.BoxLayout({
                style_class: 'ormic-prompt-overlay',
                vertical: true,
                x_expand: true, y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: true,
            });
            this._promptOverlay.hide();

            const promptCard = new St.BoxLayout({
                style_class: 'ormic-prompt-card',
                vertical: true,
                x_expand: true,
                reactive: true,
            });
            try {
                const blur = new Shell.BlurEffect({
                    brightness: 0.90,
                    mode: Shell.BlurMode.BACKGROUND,
                });
                // @ts-ignore
                blur.sigma = 40;
                promptCard.add_effect_with_name('blur', blur);
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

            const contentContainer = new St.BoxLayout({
                style_class: 'ormic-content-container',
                x_expand: true, y_expand: true,
            });

            this._tabsBox.vertical = true;
            this._tabsBox.x_expand = false;
            this._tabsBox.y_expand = true;
            this._tabsBox.x_align = Clutter.ActorAlign.START;
            this._tabsBox.y_align = Clutter.ActorAlign.FILL;
            contentContainer.add_child(this._tabsBox);

            contentContainer.add_child(this._vsep);

            const rightPanel = new St.BoxLayout({
                style_class: 'ormic-right-panel',
                vertical: true,
                x_expand: true, y_expand: true,
            });
            rightPanel.add_child(this._scroll);
            rightPanel.add_child(this._headerBox);
            rightPanel.add_child(this._gridScroll);
            rightPanel.add_child(this._editorBox);
            rightPanel.add_child(this._promptOverlay);

            contentContainer.add_child(rightPanel);
            this.add_child(contentContainer);

            this.add_child(new St.Widget({ style_class: 'ormic-sep', x_expand: true }));
            this.add_child(this._tips);
        }

        vfunc_key_press_event(ev: Clutter.Event): boolean { return this._onKey(ev); }

        private _onKey(ev: any): boolean {
            const sym = ev.get_key_symbol();
            dbg('Key', `sym=0x${sym.toString(16)} ctrl=${!!(ev.get_state() & Clutter.ModifierType.CONTROL_MASK)}`);
            const ctrl = !!(ev.get_state() & Clutter.ModifierType.CONTROL_MASK);

            if (this._promptOverlay.visible) {
                if (sym === Clutter.KEY_Escape) { this._hidePromptOverlay(false); return true; }
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._hidePromptOverlay(true); return true; }
                return false;
            }

            if (this._isEditing) {
                if (sym === Clutter.KEY_Escape) { this._stopEditing(false); return true; }
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._stopEditing(true); return true; }
                return false;
            }

            if (this._scroll.visible && ctrl && this._ext._settings.get_boolean('enable-quick-select')
                && sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
                this._activateIdx(sym - Clutter.KEY_1); return true;
            }

            if (!this._scroll.visible && this._entry.text === '' && (sym === Clutter.KEY_Shift_L || sym === Clutter.KEY_Shift_R)) {
                const cats = this._getCategoriesList();
                const idx = cats.indexOf(this._activeCategory);
                if (idx > -1) {
                    this._selectCategory(cats[(idx + 1) % cats.length]);
                    this.focus();
                    return true;
                }
            }

            if (sym === Clutter.KEY_Escape) { this._ext.hide(); return true; }

            if (this._scroll.visible) {
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._activateSel(); return true; }
                if (sym === Clutter.KEY_Up) { this._moveSel(-1); return true; }
                if (sym === Clutter.KEY_Down) { this._moveSel(1); return true; }
                if (sym === Clutter.KEY_Tab) { this._complete(); return true; }
            } else {
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._activateGridSel(); return true; }
                if (sym === Clutter.KEY_Up) { this._moveGridSel(-7); return true; }
                if (sym === Clutter.KEY_Down) { this._moveGridSel(7); return true; }
                if (sym === Clutter.KEY_Left) { this._moveGridSel(-1); return true; }
                if (sym === Clutter.KEY_Right) { this._moveGridSel(1); return true; }

                const char = Clutter.keysym_to_unicode(sym);
                if (char && char >= 32 && char <= 126 && !ctrl) {
                    this._entry.text = String.fromCharCode(char);
                    this._entry.clutter_text.set_cursor_position(-1);
                    this._entry.grab_key_focus();
                    return true;
                }
            }
            return false;
        }

        private _setTabsVisible(visible: boolean) {
            if (visible) {
                this._tabsBox.show();
                this._vsep.show();
            } else {
                this._tabsBox.hide();
                this._vsep.hide();
            }
        }

        private _onText() {
            if (this._tid != null) { GLib.source_remove(this._tid as number); this._tid = null; }
            const gen = ++this._gen;
            this._tid = timeoutOnce(80, () => {
                this._tid = null;
                if (gen !== this._gen) return;
                this._search(this._entry.text);
            });
        }

        private _search(query: string) {
            dbg('Search', 'query:', query);
            const q = query.trim();
            const max = this._ext._settings.get_int('max-results');

            if (!q) {
                this._clear();
                this._scroll.hide();
                this._headerBox.show();
                this._gridScroll.show();
                this._setTabsVisible(true);
                this._headerTitleLabel.text = this._activeCategory;
                const gridBox = this._gridBox;
                this._gridScroll.set_child(gridBox);
                if (gridBox.get_n_children() === 0) {
                    this._renderGridOnly();
                } else {
                    this._gridSelIdx = -1;
                    timeoutOnce(10, () => {
                        if (this._gridSelIdx === -1 && this._gridScroll.visible) {
                            this._selectGridIdx(0);
                        }
                    });
                }
                return;
            }

            this._headerBox.hide();
            this._gridScroll.hide();
            this._setTabsVisible(false);
            this._scroll.show();

            this._rbox.destroy_all_children();

            const combined: SearchResult[] = [];
            for (const p of this._providers) {
                try { combined.push(...p.search(q)); } catch (_e) { }
            }
            combined.sort((a, b) => b.score - a.score || b.providerPriority - a.providerPriority);
            this._results = combined.slice(0, max);
            dbg('Search', `results: ${this._results.length} (max ${max})`);
            this._renderSearchResults();
        }

        private _clear() {
            this._results = [];
            this._selIdx = -1;
            this._rbox.destroy_all_children();
        }

        // ─── Search View Rendering ───────────────────────────────────────────

        private _renderSearchResults() {
            if (!this._results.length) { this._scroll.hide(); return; }
            this._results.forEach((r, i) => {
                const row = new (ResultRow as any)() as ResultRow;
                row.setup(r, i, this._ext._settings, this._shellSettings);
                row.connect('item-activated', () => { this._ext.hide(); r.activate(); });
                row.connect('item-hovered', () => {
                    this._selectIdx(i);
                });
                this._rbox.add_child(row);
            });
            this._scroll.show();
            this._selIdx = -1;
            this._selectIdx(0);
        }

        private _selectIdx(i: number) {
            const rows = this._rbox.get_children() as ResultRow[];
            if (!rows.length) return;
            i = Math.max(0, Math.min(rows.length - 1, i));
            rows.forEach((r, j) => r.setSelected(j === i));
            this._selIdx = i;

            scrollToActor(this._scroll, rows[i]);
        }

        private _moveSel(d: number) {
            const n = this._rbox.get_children().length;
            if (n) this._selectIdx((this._selIdx + d + n) % n);
        }

        private _activateSel() {
            const r = this._results[this._selIdx];
            dbg('Activate', 'list sel', this._selIdx, r?.name ?? 'none');
            if (r) { this._ext.hide(); r.activate(); }
        }

        private _activateIdx(i: number) {
            const r = this._results[i];
            if (r) { this._ext.hide(); r.activate(); }
        }

        private _complete() {
            const r = this._results[this._selIdx];
            if (r?.name) { this._entry.text = r.name; this._entry.clutter_text.set_cursor_position(-1); }
        }

        // ─── Grid View Rendering & Management ────────────────────────────────

        private _collectGridItems(): GridItem[] {
            const items: GridItem[] = [];
            const gridBox = this._gridBox;
            gridBox.get_children().forEach((row: any) => {
                if (row.get_children) {
                    row.get_children().forEach((item: GridItem) => items.push(item));
                }
            });
            return items;
        }

        private _ensureAllAppsCache() {
            if (!this._allAppsCacheDirty && this._allAppsCache.length > 0) return;
            this._allAppsCacheDirty = false;

            const apps: SearchResult[] = [];
            const appProv = this._providers.find(p => p.id === 'apps') as AppProvider | undefined;
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
                        createIcon: (s: number) => createAppIcon(app, s),
                        categoryIcon: 'application-x-executable-symbolic',
                        category: category,
                        activate: () => {
                            dbg('LibraryGrid', `activate: ${id}`);
                            app.activate();
                        },
                    });
                }
            }
            apps.sort((a, b) => a.name.localeCompare(b.name));
            this._allAppsCache = apps;
        }

        private _cancelRenderJob() {
            if (this._renderIdleId) {
                GLib.source_remove(this._renderIdleId);
                this._renderIdleId = 0;
            }
        }

        private _cancelBgRenderJob() {
            if (this._bgRenderIdleId) {
                GLib.source_remove(this._bgRenderIdleId);
                this._bgRenderIdleId = 0;
            }
            this._bgRenderQueue = [];
        }

        private _selectCategory(categoryName: string) {
            if (this._activeCategory === categoryName) return;
            const t0 = GLib.get_monotonic_time();
            this._activeCategory = categoryName;

            this._cancelRenderJob();
            this._cancelBgRenderJob();

            const tabs = this._tabsBox.get_children() as CategoryTab[];
            tabs.forEach(tab => {
                if (typeof tab.setSelected === 'function') {
                    tab.setSelected(tab.categoryName === categoryName);
                }
            });

            this._headerTitleLabel.text = this._activeCategory;
            const staticTabs = ['Library Home', 'Office', 'System', 'Utilities'];
            const isCustom = !staticTabs.includes(this._activeCategory);
            if (isCustom) {
                this._editBtn.show();
                this._deleteBtn.show();
            } else {
                this._editBtn.hide();
                this._deleteBtn.hide();
            }

            const hasCachedGrid = this._categoryGridBoxes.has(categoryName);
            const gridBox = this._gridBox;
            this._gridScroll.set_child(gridBox);

            if (!hasCachedGrid) {
                dbg('Performance', `selectCategory('${categoryName}') — CACHE MISS, rendering grid`);
                this._renderGridOnly();
            } else {
                const elapsed = (GLib.get_monotonic_time() - t0) / 1000;
                dbg('Performance', `selectCategory('${categoryName}') — CACHE HIT, took ${elapsed.toFixed(1)}ms`);
                this._gridSelIdx = -1;
                timeoutOnce(10, () => {
                    if (this._gridSelIdx === -1 && this._gridScroll.visible) {
                        this._selectGridIdx(0);
                    }
                });
                this._startBackgroundPreRender();
            }
        }

        private _renderGridOnly() {
            const t0 = GLib.get_monotonic_time();
            this._ensureAllAppsCache();

            let filteredApps: SearchResult[] = [];
            if (this._activeCategory === 'Library Home') {
                filteredApps = this._allAppsCache;
            } else if (this._activeCategory === 'Office') {
                filteredApps = this._allAppsCache.filter(a => a.category.toLowerCase().includes('office'));
            } else if (this._activeCategory === 'System') {
                filteredApps = this._allAppsCache.filter(a =>
                    a.category.toLowerCase().includes('system') ||
                    a.category.toLowerCase().includes('setting') ||
                    a.category.toLowerCase().includes('administration') ||
                    a.category.toLowerCase().includes('preferences')
                );
            } else if (this._activeCategory === 'Utilities') {
                filteredApps = this._allAppsCache.filter(a =>
                    a.category.toLowerCase().includes('utility') ||
                    a.category.toLowerCase().includes('utilities') ||
                    a.category.toLowerCase().includes('accessories')
                );
            } else {
                const customGroups = this._getCustomGroups();
                const customAppIds = customGroups[this._activeCategory] || [];
                filteredApps = this._allAppsCache.filter(a => customAppIds.includes(a.desktopId ?? ''));
            }

            const gridBox = this._gridBox;
            gridBox.get_children().forEach((row: any) => {
                if (row.get_children) {
                    row.get_children().forEach((child: any) => {
                        row.remove_child(child);
                    });
                }
            });
            gridBox.destroy_all_children();
            this._gridSelIdx = -1;

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

            const columns = 7;
            let currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
            gridBox.add_child(currentRow);

            let index = 0;
            const CHUNK_SIZE = 8;

            const renderChunk = () => {
                const end = Math.min(index + CHUNK_SIZE, filteredApps.length);
                for (; index < end; index++) {
                    const app = filteredApps[index];
                    if (index > 0 && index % columns === 0) {
                        currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
                        gridBox.add_child(currentRow);
                    }

                    const item = new (GridItem as any)() as GridItem;
                    item.setup(app);
                    item.connect('item-activated', () => {
                        this._ext.hide();
                        app.activate();
                    });
                    item.connect('item-hovered', () => {
                        const allItems = this._collectGridItems();
                        const idx = allItems.indexOf(item);
                        if (idx >= 0) this._selectGridIdx(idx);
                    });
                    currentRow.add_child(item);
                }

                if (index < filteredApps.length) {
                    this._renderIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        renderChunk();
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    this._renderIdleId = 0;
                    const elapsed = (GLib.get_monotonic_time() - t0) / 1000;
                    dbg('Performance', `renderGridOnly('${this._activeCategory}') — ${filteredApps.length} items, took ${elapsed.toFixed(1)}ms`);
                    
                    if (this._gridSelIdx === -1 && this._gridScroll.visible) {
                        this._selectGridIdx(0);
                    }
                    this._startBackgroundPreRender();
                }
            };

            renderChunk();
        }

        private _renderCategoryGridBackground(categoryName: string, onComplete: () => void) {
            this._ensureAllAppsCache();

            let filteredApps: SearchResult[] = [];
            if (categoryName === 'Library Home') {
                filteredApps = this._allAppsCache;
            } else if (categoryName === 'Office') {
                filteredApps = this._allAppsCache.filter(a => a.category.toLowerCase().includes('office'));
            } else if (categoryName === 'System') {
                filteredApps = this._allAppsCache.filter(a =>
                    a.category.toLowerCase().includes('system') ||
                    a.category.toLowerCase().includes('setting') ||
                    a.category.toLowerCase().includes('administration') ||
                    a.category.toLowerCase().includes('preferences')
                );
            } else if (categoryName === 'Utilities') {
                filteredApps = this._allAppsCache.filter(a =>
                    a.category.toLowerCase().includes('utility') ||
                    a.category.toLowerCase().includes('utilities') ||
                    a.category.toLowerCase().includes('accessories')
                );
            } else {
                const customGroups = this._getCustomGroups();
                const customAppIds = customGroups[categoryName] || [];
                filteredApps = this._allAppsCache.filter(a => customAppIds.includes(a.desktopId ?? ''));
            }

            const gridBox = this._getCategoryGridBox(categoryName);
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

            const columns = 7;
            let currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
            gridBox.add_child(currentRow);

            let index = 0;
            const CHUNK_SIZE = 8;

            const renderChunk = () => {
                const end = Math.min(index + CHUNK_SIZE, filteredApps.length);
                for (; index < end; index++) {
                    const app = filteredApps[index];
                    if (index > 0 && index % columns === 0) {
                        currentRow = new St.BoxLayout({ style_class: 'ormic-grid-row', x_expand: true });
                        gridBox.add_child(currentRow);
                    }

                    const item = new (GridItem as any)() as GridItem;
                    item.setup(app);
                    item.connect('item-activated', () => {
                        this._ext.hide();
                        app.activate();
                    });
                    item.connect('item-hovered', () => {
                        if (this._activeCategory === categoryName) {
                            const allItems = this._collectGridItems();
                            const idx = allItems.indexOf(item);
                            if (idx >= 0) this._selectGridIdx(idx);
                        }
                    });
                    currentRow.add_child(item);
                }

                if (index < filteredApps.length) {
                    this._bgRenderIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        renderChunk();
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    this._bgRenderIdleId = 0;
                    dbg('Performance', `Background pre-render for '${categoryName}' completed.`);
                    onComplete();
                }
            };

            renderChunk();
        }

        private _startBackgroundPreRender() {
            this._cancelBgRenderJob();

            const allCats = this._getCategoriesList();
            this._bgRenderQueue = allCats.filter(cat => cat !== this._activeCategory && !this._categoryGridBoxes.has(cat));

            dbg('Performance', `Starting background pre-render. Queue: ${JSON.stringify(this._bgRenderQueue)}`);
            this._processNextBackgroundCategory();
        }

        private _processNextBackgroundCategory() {
            if (this._bgRenderQueue.length === 0) {
                dbg('Performance', 'Background pre-rendering complete.');
                return;
            }

            const nextCat = this._bgRenderQueue.shift()!;
            dbg('Performance', `Background pre-rendering category: ${nextCat}`);
            this._renderCategoryGridBackground(nextCat, () => {
                this._processNextBackgroundCategory();
            });
        }

        private _renderTabsOnly() {
            dbg('Grid', `renderTabsOnly category=${this._activeCategory}`);

            this._tabsBox.destroy_all_children();

            const staticTabs = [
                { name: 'Library Home', icon: 'go-home-symbolic' },
                { name: 'Office', icon: 'x-office-document-symbolic' },
                { name: 'System', icon: 'emblem-system-symbolic' },
                { name: 'Utilities', icon: 'accessories-calculator-symbolic' },
            ];

            staticTabs.forEach(t => {
                const tab = new (CategoryTab as any)() as CategoryTab;
                tab.setup(t.name, t.icon);
                tab.setSelected(this._activeCategory === t.name);
                tab.connect('tab-selected', () => {
                    this._selectCategory(t.name);
                    this.focus();
                });
                tab.connect('tab-hovered', () => {
                    this._selectCategory(t.name);
                    this.focus();
                });
                this._tabsBox.add_child(tab);
            });

            const customGroups = this._getCustomGroups();
            for (const gName of Object.keys(customGroups)) {
                const tab = new (CategoryTab as any)() as CategoryTab;
                tab.setup(gName, 'folder-symbolic');
                tab.setSelected(this._activeCategory === gName);
                tab.connect('tab-selected', () => {
                    this._selectCategory(gName);
                    this.focus();
                });
                tab.connect('tab-hovered', () => {
                    this._selectCategory(gName);
                    this.focus();
                });
                this._tabsBox.add_child(tab);
            }

            const addTab = new (CategoryTab as any)() as CategoryTab;
            addTab.setup(_('Add group'), 'list-add-symbolic');
            addTab.connect('tab-selected', () => {
                this._showPromptOverlay();
            });
            this._tabsBox.add_child(addTab);

            this._headerTitleLabel.text = this._activeCategory;
            const isCustom = !staticTabs.some(t => t.name === this._activeCategory);
            if (isCustom) {
                this._editBtn.show();
                this._deleteBtn.show();
            } else {
                this._editBtn.hide();
                this._deleteBtn.hide();
            }
        }

        private _renderGridAndTabs() {
            dbg('Performance', `renderGridAndTabs — rebuilding tabs, invalidating grid for: ${this._activeCategory}`);

            this._cancelRenderJob();
            this._cancelBgRenderJob();

            const oldBox = this._categoryGridBoxes.get(this._activeCategory);
            if (oldBox) {
                oldBox.destroy();
                this._categoryGridBoxes.delete(this._activeCategory);
            }

            this._renderTabsOnly();

            const gridBox = this._gridBox;
            this._gridScroll.set_child(gridBox);
            this._renderGridOnly();
        }

        private _selectGridIdx(i: number) {
            const items = this._collectGridItems();
            if (!items.length) return;
            i = Math.max(0, Math.min(items.length - 1, i));
            items.forEach((item, idx) => item.setSelected(idx === i));
            this._gridSelIdx = i;

            scrollToActor(this._gridScroll, items[i]);
        }

        private _moveGridSel(d: number) {
            const items = this._collectGridItems();
            const n = items.length;
            if (n) {
                this._selectGridIdx((this._gridSelIdx + d + n) % n);
            }
        }

        private _activateGridSel() {
            dbg('Activate', 'grid sel', this._gridSelIdx);
            const items = this._collectGridItems();
            const selected = items[this._gridSelIdx];
            if (selected) {
                this._ext.hide();
                selected.result.activate();
            }
        }

        // ─── Custom Group Editing checklist Mode ──────────────────────────────

        private _startEditing() {
            this._isEditing = true;
            this._headerBox.hide();
            this._gridScroll.hide();
            this._setTabsVisible(false);

            this._editorNameEntry.text = this._activeCategory;
            this._editorAppsContainer.destroy_all_children();

            const apps: SearchResult[] = [];
            const appProv = this._providers.find(p => p.id === 'apps') as AppProvider | undefined;
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
                        createIcon: (s: number) => createAppIcon(app, s),
                        categoryIcon: 'application-x-executable-symbolic',
                        category: category,
                        activate: () => app.activate(),
                    });
                }
            }
            apps.sort((a, b) => a.name.localeCompare(b.name));

            const customGroups = this._getCustomGroups();
            const groupAppIds = customGroups[this._activeCategory] || [];

            apps.forEach(app => {
                const row = new (EditAppRow as any)() as EditAppRow;
                row.setup(app, groupAppIds.includes(app.desktopId ?? ''));
                this._editorAppsContainer.add_child(row);
            });

            this._editorBox.show();
            this._editorNameEntry.grab_key_focus();
        }

        private _stopEditing(save: boolean) {
            this._isEditing = false;
            this._editorBox.hide();
            this._headerBox.show();
            this._gridScroll.show();
            this._setTabsVisible(true);

            if (save) {
                const newName = this._editorNameEntry.text.trim();
                const customGroups = this._getCustomGroups();

                const selectedIds: string[] = [];
                this._editorAppsContainer.get_children().forEach((child: any) => {
                    const row = child as EditAppRow;
                    if (row.selected && row.result.desktopId) {
                        selectedIds.push(row.result.desktopId);
                    }
                });

                if (newName && newName !== this._activeCategory) {
                    delete customGroups[this._activeCategory];
                    customGroups[newName] = selectedIds;
                    this._activeCategory = newName;
                } else if (newName) {
                    customGroups[this._activeCategory] = selectedIds;
                }

                this._saveCustomGroups(customGroups);
            }

            this._renderGridAndTabs();
            timeoutOnce(50, () => this.focus());
        }

        private _deleteActiveCategory() {
            const customGroups = this._getCustomGroups();
            delete customGroups[this._activeCategory];
            this._saveCustomGroups(customGroups);

            this._activeCategory = 'Library Home';
            this._renderGridAndTabs();
            timeoutOnce(50, () => this.focus());
        }

        // ─── Prompt Modal Overlay for Group Creation ────────────────────────

        private _showPromptOverlay() {
            this._promptEntry.text = '';
            this._promptOverlay.show();
            this._promptEntry.grab_key_focus();
        }

        private _hidePromptOverlay(create: boolean) {
            this._promptOverlay.hide();
            const gName = this._promptEntry.text.trim();

            if (create && gName) {
                const customGroups = this._getCustomGroups();
                if (!customGroups[gName]) {
                    customGroups[gName] = [];
                    this._saveCustomGroups(customGroups);
                    this._activeCategory = gName;

                    this._renderGridAndTabs();
                    this._startEditing();
                    return;
                }
            }

            this._renderGridAndTabs();
            timeoutOnce(50, () => this.focus());
        }

        // ─── Settings Helper Methods ──────────────────────────────────────────

        private _getCategoriesList(): string[] {
            const list = ['Library Home', 'Office', 'System', 'Utilities'];
            const customGroups = this._getCustomGroups();
            for (const gName of Object.keys(customGroups)) {
                list.push(gName);
            }
            return list;
        }

        private _getCustomGroups(): Record<string, string[]> {
            dbg('Groups', 'getCustomGroups()');
            try {
                const str = this._ext._settings.get_string('custom-groups') || '{}';
                return JSON.parse(str);
            } catch (_e) {
                return {};
            }
        }

        private _saveCustomGroups(groups: Record<string, string[]>) {
            dbg('Groups', 'saveCustomGroups()', Object.keys(groups));
            try {
                this._ext._settings.set_string('custom-groups', JSON.stringify(groups));
            } catch (e: any) {
                log(`Ormic Launcher: Error saving custom groups: ${e.message}`);
            }
        }

        // ─── External Controls ────────────────────────────────────────────────

        focus() {
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
            const appProv = this._providers?.find(p => p.id === 'apps') as AppProvider | undefined;
            const isAppsDirty = appProv ? appProv.dirty : false;

            if (this._providers) {
                for (const p of this._providers) {
                    try {
                        if (typeof p.onOpen === 'function') {
                            p.onOpen();
                        }
                    } catch (e: any) {
                        log(`Ormic Launcher: Error calling onOpen on provider: ${e.message}`);
                    }
                }
            }

            this._cancelRenderJob();
            this._cancelBgRenderJob();

            this._clear();
            this._entry.text = '';
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

            const needsRebuild = isAppsDirty || this._allAppsCacheDirty || this._categoryGridBoxes.size === 0;

            if (needsRebuild) {
                dbg('Performance', `SLOW PATH: cache rebuild needed. isAppsDirty=${isAppsDirty}, allAppsCacheDirty=${this._allAppsCacheDirty}, gridBoxes=${this._categoryGridBoxes.size}`);
                this._allAppsCacheDirty = true;
                
                if (this._categoryGridBoxes) {
                    this._categoryGridBoxes.forEach(box => box.destroy());
                    this._categoryGridBoxes.clear();
                }

                this._renderTabsOnly();

                const gridBox = this._gridBox;
                this._gridScroll.set_child(gridBox);

                timeoutOnce(20, () => {
                    this._renderGridOnly();
                });
            } else {
                dbg('Performance', `FAST PATH: reusing ${this._categoryGridBoxes.size} cached grid boxes`);

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

                this._gridSelIdx = -1;
                timeoutOnce(10, () => {
                    if (this._gridSelIdx === -1 && this._gridScroll.visible) {
                        this._selectGridIdx(0);
                    }
                });

                this._startBackgroundPreRender();
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
    _monId!: number | null;
    _keyId!: number | null;
    _cfgId!: number | null;
    _focusId!: number | null;

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

        this._overlay.connect('captured-event', (_, ev: any) => {
            const t = typeof ev.type === 'function' ? ev.type() : ev.type;
            if (t === Clutter.EventType.BUTTON_PRESS) {
                this._setClickGuard();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._overlay.connect('button-press-event', (_, ev) => {
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

        this._overlay.connect('key-press-event', (_, ev) => {
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
        this._overlay?.destroy();
        this._overlay = null;
        this._dialog = null;
        for (const p of this.providers) {
            if (typeof p.destroy === 'function') {
                try { p.destroy(); } catch (_) { }
            }
        }
        this.providers = [];
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
        const dw = Math.min(1020, mon.width * 0.65);
        const dx = mon.x + Math.floor((mon.width - dw) / 2);
        const dy = mon.y + Math.floor(mon.height * 0.14);
        this._overlay.set_position(mon.x, mon.y);
        this._overlay.set_size(mon.width, mon.height);
        this._dialog.set_position(dx - mon.x, dy - mon.y);
        this._dialog.set_width(dw);
        this._dialog.min_width = dw;
        // @ts-ignore
        this._dialog.max_width = dw;
    }

    toggle() { this._visible ? this.hide() : this.show(); }

    show() {
        dbg('Launcher', 'show()');
        if (this._visible) return;
        if (!this._dialog || !this._overlay) return;
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
        this._visible = false;
        this._clickGuard = false;
        if (this._clickGuardTimer != null) {
            GLib.source_remove(this._clickGuardTimer as number);
            this._clickGuardTimer = null;
        }
        if (this._grab) {
            try {
                Main.popModal(this._grab);
            } catch (e: any) {
                dbg('Launcher', `popModal failed: ${e.message}`);
            }
            this._grab = null;
        }
        const ov = this._overlay, dl = this._dialog;
        easeActor(dl, {
            opacity: 0, translation_y: -14, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => { ov.hide(); dl.reset(); dl.opacity = 255; dl.translation_y = 0; },
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