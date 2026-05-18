/**
 * Ormic Launcher — Preferences
 * Libadwaita UI for GNOME 45+.
 */

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

        // ══ Page: General ════════════════════════════════════════════════
        const genPage = new Adw.PreferencesPage({
            title: _('General'), icon_name: 'preferences-system-symbolic',
        });
        win.add(genPage);

        // ── Keybinding ────────────────────────────────────────────────────
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

        // Conflict detection
        const sysSets = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        let ibusSets: Gio.Settings | null = null;
        try {
            if ((Gio.Settings.list_schemas() ?? []).includes('org.freedesktop.ibus.general.hotkey'))
                ibusSets = new Gio.Settings({ schema_id: 'org.freedesktop.ibus.general.hotkey' });
        } catch (_e) { }

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
        ibusSets?.connect('changed::triggers', refreshConflict);
        s.connect('changed::toggle-ormic-launcher', refreshConflict);

        // Show indicator
        const indRow = new Adw.SwitchRow({
            title: _('Show Top Panel Indicator'),
            subtitle: _('Search icon in the top bar to open the launcher'),
        });
        s.bind('show-indicator', indRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        kbGroup.add(indRow);

        // Show search bar
        const sbRow = new Adw.SwitchRow({
            title: _('Show Search Bar by Default'),
            subtitle: _('Show a search entry at the top of the library view'),
        });
        s.bind('show-search-bar', sbRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        kbGroup.add(sbRow);

        // ── Results ───────────────────────────────────────────────────────
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

        // ══ Page: Providers ═══════════════════════════════════════════════
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

        // ══ Page: About ═══════════════════════════════════════════════════
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