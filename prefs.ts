// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Preferences

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ }
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class OrmicLauncherPrefs extends ExtensionPreferences {
    fillPreferencesWindow(win: Adw.PreferencesWindow): Promise<void> {
        const s = this.getSettings();
        win.set_default_size(640, 580);
        win.set_title(_('Ormic Launcher Settings'));

        const genPage = new Adw.PreferencesPage({
            title: _('General'), icon_name: 'preferences-system-symbolic',
        });
        win.add(genPage);

        const kbGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcut'),
            description: _('Shortcut to open the Ormic Launcher dialog'),
        });
        genPage.add(kbGroup);

        const kbRow = new Adw.ActionRow({
            title: _('Toggle launcher'), subtitle: _('Default: Super+Space'),
        });
        const kbLabel = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER, disabled_text: _('Disabled'),
        });
        const refreshKb = () => {
            const shortcuts = s.get_strv('toggle-ormic-launcher');
            kbLabel.set_accelerator(shortcuts[0] ?? '');
        };
        refreshKb();
        s.connect('changed::toggle-ormic-launcher', refreshKb);
        kbRow.add_suffix(kbLabel);
        kbGroup.add(kbRow);

        const sysSets = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        let ibusSets: Gio.Settings | null = null;
        if (Gio.Settings.list_schemas().includes('org.freedesktop.ibus.general.hotkey')) {
            ibusSets = new Gio.Settings({ schema_id: 'org.freedesktop.ibus.general.hotkey' });
        }

        const conflictRow = new Adw.ActionRow({ title: _('Shortcut Conflict Detected'), subtitle: '', visible: false });
        conflictRow.add_prefix(new Gtk.Image({ icon_name: 'dialog-warning-symbolic', valign: Gtk.Align.CENTER }));

        const resolveBtn = new Gtk.Button({ label: _('Resolve Conflict'), valign: Gtk.Align.CENTER });
        resolveBtn.add_css_class('suggested-action');
        resolveBtn.connect('clicked', () => {
            const shorts = s.get_strv('toggle-ormic-launcher');
            const strip = (key: string) => {
                sysSets.set_strv(key, sysSets.get_strv(key).filter((x: string) => !shorts.includes(x)));
            };
            strip('switch-input-source');
            strip('switch-input-source-backward');
            if (ibusSets) {
                ibusSets.set_strv('triggers',
                    ibusSets.get_strv('triggers').filter((x: string) => !shorts.includes(x)));
            }
            refreshConflict();
        });
        conflictRow.add_suffix(resolveBtn);
        kbGroup.add(conflictRow);

        const refreshConflict = () => {
            const shorts = s.get_strv('toggle-ormic-launcher');
            const src = sysSets.get_strv('switch-input-source');
            const srcBack = sysSets.get_strv('switch-input-source-backward');
            const gnome = shorts.some((x: string) => src.includes(x) || srcBack.includes(x));
            const ibus = ibusSets
                ? shorts.some((x: string) => (ibusSets!.get_strv('triggers') as string[]).includes(x))
                : false;
            conflictRow.set_visible(gnome || ibus);
            if (gnome || ibus) {
                conflictRow.set_subtitle(
                    gnome && ibus ? _('GNOME and IBus are using Super+Space — blocks the launcher. Click Resolve.') :
                        gnome ? _('GNOME is using Super+Space — blocks the launcher. Click Resolve.') :
                            _('IBus is using Super+Space — blocks the launcher. Click Resolve.'),
                );
            }
        };
        refreshConflict();
        sysSets.connect('changed::switch-input-source', refreshConflict);
        sysSets.connect('changed::switch-input-source-backward', refreshConflict);
        if (ibusSets) ibusSets.connect('changed::triggers', refreshConflict);
        s.connect('changed::toggle-ormic-launcher', refreshConflict);

        const appearGroup = new Adw.PreferencesGroup({ title: _('Appearance') });
        genPage.add(appearGroup);

        const indRow = new Adw.SwitchRow({
            title: _('Show Top Panel Indicator'),
            subtitle: _('Search icon in the top bar to open the launcher'),
        });
        s.bind('show-indicator', indRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearGroup.add(indRow);

        const sbRow = new Adw.SwitchRow({
            title: _('Show Search Bar by Default'),
            subtitle: _('Show a search entry at the top of the library view'),
        });
        s.bind('show-search-bar', sbRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearGroup.add(sbRow);

        const gsRow = new Adw.SwitchRow({
            title: _('Show Groups Sidebar'),
            subtitle: _('Show the category/groups sidebar on the left'),
        });
        s.bind('show-groups-sidebar', gsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearGroup.add(gsRow);

        const bgRow = new Adw.ComboRow({
            title: _('Background Style'),
            subtitle: _('Choose the visual style of the launcher background'),
            model: new Gtk.StringList({
                strings: [
                    _('Blur (Glassmorphic)'),
                    _('Transparent'),
                    _('Solid / GNOME Default'),
                ],
            }),
        });
        const bgStyles = ['blur', 'transparent', 'solid'];
        const refreshBg = () => {
            let val = s.get_string('background-style') || 'blur';
            if (val.startsWith('transparent')) {
                val = 'transparent';
            }
            const idx = bgStyles.indexOf(val);
            if (idx !== -1) bgRow.set_selected(idx);
        };
        refreshBg();
        bgRow.connect('notify::selected', () => {
            const idx = bgRow.get_selected();
            if (idx >= 0 && idx < bgStyles.length)
                s.set_string('background-style', bgStyles[idx]);
        });
        s.connect('changed::background-style', refreshBg);
        appearGroup.add(bgRow);

        const accentRow = new Adw.ComboRow({
            title: _('Accent Color'),
            subtitle: _('Highlight and selection color for the launcher'),
            model: new Gtk.StringList({
                strings: [
                    _('System Default (GNOME)'),
                    _('Yellow (Pop!_OS Orange)'),
                    _('Blue (Sleek Blue)'),
                    _('Purple (Vibrant Purple)'),
                    _('Red (Coral Red)'),
                    _('Green (Emerald Green)'),
                    _('Pink (Hot Pink)'),
                    _('Teal (Modern Teal)'),
                    _('Orange (Vibrant Orange)'),
                    _('Slate (Slate Grey)'),
                ],
            }),
        });
        const colors = ['gnome', 'yellow', 'blue', 'purple', 'red', 'green', 'pink', 'teal', 'orange', 'slate'];
        const refreshAccent = () => {
            const val = s.get_string('accent-color') || 'gnome';
            const idx = colors.indexOf(val);
            if (idx !== -1)
                accentRow.set_selected(idx);
        };
        refreshAccent();
        accentRow.connect('notify::selected', () => {
            const idx = accentRow.get_selected();
            if (idx >= 0 && idx < colors.length)
                s.set_string('accent-color', colors[idx]);
        });
        s.connect('changed::accent-color', refreshAccent);
        appearGroup.add(accentRow);

        const resGroup = new Adw.PreferencesGroup({ title: _('Results') });
        genPage.add(resGroup);

        const maxRow = new Adw.SpinRow({
            title: _('Maximum results'),
            subtitle: _('How many results to show at once (5 – 24)'),
            adjustment: new Gtk.Adjustment({ lower: 5, upper: 24, step_increment: 1, value: s.get_int('max-results') }),
        });
        s.bind('max-results', maxRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        resGroup.add(maxRow);

        // Quick-select was in schema but had no UI row (bug fix)
        const qsRow = new Adw.SwitchRow({
            title: _('Quick-select shortcuts'),
            subtitle: _('Show Ctrl+1…9 badges and activate results instantly with those keys'),
        });
        s.bind('enable-quick-select', qsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        resGroup.add(qsRow);



        const iconSizeRow = new Adw.SpinRow({
            title: _('Grid icon size (px)'),
            subtitle: _('Width/height of icons in the library grid — 32 (tiny) → 80 (large). Default: 52'),
            adjustment: new Gtk.Adjustment({
                lower: 32, upper: 80, step_increment: 4,
                value: s.get_int('grid-icon-size'),
            }),
        });
        s.bind('grid-icon-size', iconSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearGroup.add(iconSizeRow);

        const launcherWRow = new Adw.SpinRow({
            title: _('Launcher width (px)'),
            subtitle: _('Width of the floating launcher dialog — 600 → 1600. Default: 960'),
            adjustment: new Gtk.Adjustment({
                lower: 600, upper: 1600, step_increment: 20,
                value: s.get_int('launcher-width'),
            }),
        });
        s.bind('launcher-width', launcherWRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearGroup.add(launcherWRow);

        const launcherHRow = new Adw.SpinRow({
            title: _('Launcher height (px)'),
            subtitle: _('Height of the floating launcher dialog — 400 → 1200. Default: 640'),
            adjustment: new Gtk.Adjustment({
                lower: 400, upper: 1200, step_increment: 20,
                value: s.get_int('launcher-height'),
            }),
        });
        s.bind('launcher-height', launcherHRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearGroup.add(launcherHRow);

        const provPage = new Adw.PreferencesPage({
            title: _('Providers'), icon_name: 'application-x-executable-symbolic',
        });
        win.add(provPage);

        const provGroup = new Adw.PreferencesGroup({
            title: _('Search Providers'),
            description: _('Enable or disable individual search providers'),
        });
        provPage.add(provGroup);

        const rows: Record<string, Adw.SwitchRow> = {};
        for (const [key, title, sub] of [
            ['enable-recent-files', _('Recent Files'), _('Search files you have recently opened')],
            // Both missing from prefs before (bug fix):
            ['enable-window-search', _('Open Windows'), _('Search open windows — type "win " to list all')],
        ] as [string, string, string][]) {
            const row = new Adw.SwitchRow({ title, subtitle: sub });
            s.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            provGroup.add(row);
            rows[key] = row;
        }

        const aboutPage = new Adw.PreferencesPage({
            title: _('About'), icon_name: 'help-about-symbolic',
        });
        win.add(aboutPage);

        const aboutGroup = new Adw.PreferencesGroup();
        aboutPage.add(aboutGroup);
        aboutGroup.add(new Adw.ActionRow({
            title: _('Ormic Launcher'),
            subtitle: _('A modular floating app launcher for GNOME Shell,\ninspired by the pop-os/launcher project architecture.'),
        }));
        aboutGroup.add(new Adw.ActionRow({ title: _('Version'), subtitle: '1.0' }));
        aboutGroup.add(new Adw.ActionRow({ title: _('License'), subtitle: 'GPL-2.0-or-later' }));
        aboutGroup.add(new Adw.ActionRow({ title: _('GNOME'), subtitle: '45 · 46 · 47 · 48 · 49 · 50' }));

        const refGroup = new Adw.PreferencesGroup({ title: _('Quick Reference') });
        aboutPage.add(refGroup);
        for (const [k, d] of [
            [_('Type anything'), _('Search installed applications')],
            [_('2 + 2, sqrt(16)'), _('Calculate — result copied to clipboard')],
            [_('win '), _('List / search open windows')],
            [_('> <command>'), _('Run a shell command')],
        ] as [string, string][]) {
            refGroup.add(new Adw.ActionRow({ title: k, subtitle: d }));
        }

        return Promise.resolve();
    }
}