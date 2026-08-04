// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — GNOME Shell Extension
// Copyright (C) 2026 oliwebd
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
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    logDebug,
    timeoutOnce,
    easeActor,
    setDebug,
} from './utils.js';

import { AppProvider } from './providers/apps.js';
import { CalcProvider } from './providers/calc.js';
import { RecentProvider } from './providers/recent.js';
import { CommandProvider } from './providers/command.js';
import { WindowProvider } from './providers/window.js';

import { ACCENT_COLORS, ACCENT_COLOR_KEYS, AccentColorKey } from './accent-colors.js';
import { LauncherDialog } from './launcher/LauncherDialog.js';


class OrmicIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass({ GTypeName: 'OrmicIndicator' }, this);
    }

    _ext!: OrmicLauncherExtension;
    _init() {
        super._init(0.0, 'Ormic Launcher', true);
        this.add_child(new St.Icon({ icon_name: 'view-app-grid-symbolic', style_class: 'system-status-icon' }));
        this.connect('button-press-event', () => {
            this._ext.toggle();
            return Clutter.EVENT_STOP;
        });
    }
}


const EDGE_TRIGGER_PRESSURE_TIMEOUT = 1000;

function buildAccentCss(colorName: string): string {
    const p = ACCENT_COLORS[colorName as AccentColorKey] ?? ACCENT_COLORS.yellow;
    const { accent, rgb, hover, active } = p;
    return `
.ormic-entry { caret-color: ${accent}; }
.ormic-result.selected { background-color: rgba(${rgb}, 0.09); }
.ormic-result.selected .ormic-accent-bar { background-color: ${accent}; }
.ormic-result.selected .ormic-name { color: ${accent}; }
.ormic-fav-btn:hover { color: ${accent}; }
.ormic-fav-btn.is-fav { color: ${accent}; }
.ormic-fav-btn.is-fav:hover { background-color: rgba(${rgb}, 0.12); }
.ormic-kbd-badge { color: rgba(${rgb}, 0.72); background-color: rgba(${rgb}, 0.07); border: 1px solid rgba(${rgb}, 0.18); }
.ormic-result.selected .ormic-kbd-badge { border-color: ${accent}; }
.ormic-editor-entry { caret-color: ${accent}; }
.ormic-editor-entry:focus { border-color: ${accent}; }
.ormic-editor-btn.save-btn { background-color: ${accent}; border: 1px solid ${accent}; }
.ormic-editor-btn.save-btn:hover { background-color: ${hover}; border-color: ${hover}; }
.ormic-edit-row.selected { background-color: rgba(${rgb}, 0.06); border-color: rgba(${rgb}, 0.14); }
.ormic-edit-row.selected .ormic-edit-checkbox { color: ${accent}; }
.ormic-prompt-entry { caret-color: ${accent}; }
.ormic-prompt-entry:focus { border-color: ${accent}; }
.ormic-prompt-btn.create-btn { background-color: ${accent}; border: 1px solid ${accent}; }
.ormic-prompt-btn.create-btn:hover { background-color: ${hover}; border-color: ${hover}; }
.ormic-prompt-btn.create-btn:active { background-color: ${active}; border-color: ${active}; }
.ormic-tip-key { color: rgba(${rgb}, 0.80); background-color: rgba(${rgb}, 0.09); }
.ormic-category-tab.active { background-color: rgba(${rgb}, 0.10); border-color: rgba(${rgb}, 0.22); }
.ormic-category-tab.active .ormic-category-tab-label { color: ${accent}; }
.ormic-category-tab.active .ormic-category-tab-icon { color: ${accent}; }
`;
}

export default class OrmicLauncherExtension extends Extension {
    providers!: any[];
    _visible!: boolean;
    _grab: any = null;
    _clickGuard = false;
    _clickGuardTimer: number | null = null;
    _settings!: Gio.Settings;
    _interfaceSettings: Gio.Settings | null = null;
    _overlay!: St.Widget | null;
    _dialog!: LauncherDialog | null;
    _indicator!: OrmicIndicator | null;
    _monId!: number | null;
    _keyId!: number | null;
    _cfgId!: number | null;
    _sysAccentId!: number | null;
    _focusId!: number | null;
    _overlayCapturedId!: number | null;
    _overlayPressId!: number | null;
    _overlayKeyId!: number | null;
    _debugSettingId!: number | null;
    _dynamicCssFile: Gio.File | null = null;
    _theme: St.Theme | null = null;
    _dialogSizeId: number | null = null;

    _edgeBarrier: Meta.Barrier | null = null;
    _edgePressureBarrier: any = null;
    _edgeTriggerId: number | null = null;
    _edgeSettingId: number | null = null;
    _edgePressureSettingId: number | null = null;

    enable() {
        logDebug('Extension', 'enable() called');
        this._settings = this.getSettings();
        this.providers = [
            new AppProvider(), new CalcProvider(),
            new RecentProvider(this._settings), new CommandProvider(),
            new WindowProvider(this._settings),
        ];
        this._visible = false; this._indicator = null; this._cfgId = null; this._focusId = null; this._debugSettingId = null;

        this._debugSettingId = this._settings.connect('changed::debug', () => setDebug(this._settings.get_boolean('debug')));
        setDebug(this._settings.get_boolean('debug'));

        this._overlay = new St.Widget({
            name: 'ormic-overlay',
            style_class: 'ormic-overlay', reactive: true, visible: false,
            x: 0, y: 0, opacity: 0,
        });

        try {
            this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            if (this._interfaceSettings.settings_schema.has_key('accent-color')) {
                this._sysAccentId = this._interfaceSettings.connect('changed::accent-color', () => this._updateAccentColor());
            }
        } catch (_) {
            this._interfaceSettings = null;
        }
        this._updateAccentColor();

        this._overlayCapturedId = this._overlay.connect('captured-event', (_, ev: any) => {
            const t = ev.type();
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

            logDebug('OverlayPress', `stage_click=(${x}, ${y}) local_click=(${lx}, ${ly}) dialog_size=(${d.width}, ${d.height}) inside=${insideDialog}`);

            if (!insideDialog) {
                logDebug('OverlayPress', 'Click outside dialog, hiding launcher');
                this.hide();
                return Clutter.EVENT_STOP;
            }
            this._setClickGuard();
            return Clutter.EVENT_PROPAGATE;
        });

        this._overlayKeyId = this._overlay.connect('key-press-event', (_, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.hide();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._dialog = new LauncherDialog();
        this._dialog.setup(this);
        this._dialog.set_pivot_point(0.5, 0.5);
        this._overlay.add_child(this._dialog);

        Main.layoutManager.addTopChrome(this._overlay);

        this._monId = Main.layoutManager.connect('monitors-changed', () => {
            this._pos();
            this._setupEdgeTrigger();
        });
        this._pos();
        this._setupEdgeTrigger();

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
                logDebug('Extension', 'Focus moved outside launcher overlay, hiding');
                this.hide();
            }
        });

        this._cfgId = this._settings.connect('changed::show-indicator', () => this._syncInd());
        this._syncInd();

        this._settings.connect('changed::launcher-width', () => this._pos());
        this._settings.connect('changed::launcher-height', () => this._pos());

        this._edgeSettingId = this._settings.connect('changed::enable-edge-trigger', () => this._setupEdgeTrigger());
        this._edgePressureSettingId = this._settings.connect('changed::edge-trigger-pressure', () => this._setupEdgeTrigger());
    }

    disable() {
        logDebug('Extension', 'disable() called');
        this._destroyEdgeTrigger();
        if (this._edgeSettingId) { this._settings.disconnect(this._edgeSettingId); this._edgeSettingId = null; }
        if (this._edgePressureSettingId) { this._settings.disconnect(this._edgePressureSettingId); this._edgePressureSettingId = null; }
        if (this._focusId) { global.stage.disconnect(this._focusId); this._focusId = null; }
        if (this._cfgId) { this._settings.disconnect(this._cfgId); this._cfgId = null; }
        if (this._interfaceSettings && this._sysAccentId) {
            this._interfaceSettings.disconnect(this._sysAccentId);
            this._sysAccentId = null;
        }
        if (this._debugSettingId) { this._settings.disconnect(this._debugSettingId); this._debugSettingId = null; }
        this._interfaceSettings = null;
        if (this._theme && this._dynamicCssFile) {
            this._theme.unload_stylesheet(this._dynamicCssFile);
        }
        this._theme = null;
        this._dynamicCssFile = null;
        if (this._keyId) { global.stage.disconnect(this._keyId); this._keyId = null; }
        if (this._monId) { Main.layoutManager.disconnect(this._monId); this._monId = null; }
        if (this._indicator) this._indicator.destroy(); this._indicator = null;
        Main.wm.removeKeybinding('toggle-ormic-launcher');

        if (this._dialog) {
            if (this._dialogSizeId) { this._dialog.disconnect(this._dialogSizeId); this._dialogSizeId = null; }
            this._dialog.remove_all_transitions();
            this._dialog.cleanup();
            this._dialog.destroy();
        }

        if (this._overlay) {
            if (this._overlayCapturedId) this._overlay.disconnect(this._overlayCapturedId);
            if (this._overlayPressId) this._overlay.disconnect(this._overlayPressId);
            if (this._overlayKeyId) this._overlay.disconnect(this._overlayKeyId);
            this._overlay.remove_all_transitions();
            Main.layoutManager.removeChrome(this._overlay);
            this._overlay.destroy();
        }

        this._overlay = null;
        this._dialog = null;

        if (this._clickGuardTimer != null) {
            GLib.source_remove(this._clickGuardTimer);
            this._clickGuardTimer = null;
        }

        for (const p of this.providers) {
            if (p.destroy) p.destroy();
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
        } else { if (this._indicator) this._indicator.destroy(); this._indicator = null; }
    }

    _pos() {
        if (!this._overlay || !this._dialog) return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon) return;

        const dw = this._settings.get_int('launcher-width');
        const dh = this._settings.get_int('launcher-height');
        const dx = mon.x + Math.floor((mon.width - dw) / 2);
        const dy = mon.y + Math.floor(mon.height * 0.14);

        this._overlay.set_position(mon.x, mon.y);
        this._overlay.set_size(mon.width, mon.height);

        this._dialog.set_position(dx - mon.x, dy - mon.y);
        this._dialog.set_size(dw, dh);
        this._dialog.style = '';
        this._dialog.min_width = dw;
        (this._dialog as any).max_width = dw;
        this._dialog.min_height = dh;
        (this._dialog as any).max_height = dh;
        this._dialog.set_clip_to_allocation(true);
    }

    _setupEdgeTrigger() {
        this._destroyEdgeTrigger();

        if (!this._settings || !this._settings.get_boolean('enable-edge-trigger')) return;

        const mon = Main.layoutManager.primaryMonitor;
        if (!mon) return;

        const rightEdge = mon.x + mon.width;

        this._edgeBarrier = new Meta.Barrier({
            backend: (global as any).backend,
            x1: rightEdge, x2: rightEdge,
            y1: mon.y, y2: mon.y + mon.height,
            directions: Meta.BarrierDirection.NEGATIVE_X,
        });

        const threshold = this._settings.get_int('edge-trigger-pressure');
        this._edgePressureBarrier = new (Layout as any).PressureBarrier(
            threshold,
            EDGE_TRIGGER_PRESSURE_TIMEOUT,
            Shell.ActionMode.NORMAL,
        );
        this._edgePressureBarrier.addBarrier(this._edgeBarrier);
        this._edgeTriggerId = this._edgePressureBarrier.connect('trigger', () => {
            logDebug('EdgeTrigger', 'Right-edge pressure trigger fired');
            if (!this._visible) this.show();
        });
    }

    _destroyEdgeTrigger() {
        if (this._edgePressureBarrier) {
            if (this._edgeTriggerId) {
                this._edgePressureBarrier.disconnect(this._edgeTriggerId);
                this._edgeTriggerId = null;
            }
            if (this._edgeBarrier) this._edgePressureBarrier.removeBarrier(this._edgeBarrier);
            this._edgePressureBarrier.destroy();
            this._edgePressureBarrier = null;
        }
        if (this._edgeBarrier) {
            this._edgeBarrier.destroy();
            this._edgeBarrier = null;
        }
    }

    toggle() {
        if (this._visible) this.hide();
        else this.show();
    }

    show() {
        logDebug('Launcher', 'show()');
        if (this._visible) return;
        if (!this._dialog || !this._overlay) return;

        this._overlay.remove_all_transitions();
        this._dialog.remove_all_transitions();

        this._visible = true;
        this._dialog.reset();

        this._overlay.show();
        this._dialog.opacity = 0;
        this._dialog.translation_y = -14;
        this._dialog.scale_x = 0.94;
        this._dialog.scale_y = 0.94;

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

        // Scrim fades in a touch faster than the dialog so the dialog reads
        // as arriving "on top of" an already-dimmed backdrop, rather than
        // both elements popping in at once.
        easeActor(this._overlay, { opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        easeActor(this._dialog, {
            opacity: 255, translation_y: 0, scale_x: 1, scale_y: 1,
            duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });

        const d = this._dialog;
        timeoutOnce(10, () => d.focus());
    }

    hide() {
        logDebug('Launcher', 'hide()');
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
            Main.popModal(this._grab);
            this._grab = null;
        }

        easeActor(this._dialog, {
            opacity: 0, translation_y: -10, scale_x: 0.96, scale_y: 0.96,
            duration: 140, mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                this._dialog!.opacity = 255;
                this._dialog!.translation_y = 0;
                this._dialog!.scale_x = 1;
                this._dialog!.scale_y = 1;
            },
        });

        easeActor(this._overlay, {
            opacity: 0, duration: 160, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => { this._overlay!.hide(); },
        });
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

    _getResolvedAccentColor(): string {
        const iface = this._interfaceSettings;
        if (iface && iface.settings_schema.has_key('accent-color')) {
            const sysColor = iface.get_string('accent-color');
            if (sysColor && ACCENT_COLOR_KEYS.has(sysColor)) return sysColor;
        }
        return 'yellow';
    }

    _updateAccentColor() {
        const colorName = this._getResolvedAccentColor();

        try {
            if (!this._theme) {
                this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            }

            const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ormic-launcher']);
            GLib.mkdir_with_parents(cacheDir, 0o700);
            const path = GLib.build_filenamev([cacheDir, 'accent.css']);
            GLib.file_set_contents(path, buildAccentCss(colorName));

            if (this._dynamicCssFile) {
                this._theme.unload_stylesheet(this._dynamicCssFile);
            }
            this._dynamicCssFile = Gio.File.new_for_path(path);
            this._theme.load_stylesheet(this._dynamicCssFile);
        } catch (e) {
            logDebug('Extension', `Failed to apply accent color: ${e}`);
        }
    }

}
