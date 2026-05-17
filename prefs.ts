/**
 * Ormic Launcher — Preferences
 * Uses libadwaita (Adw) widgets for native GNOME 45+ prefs UI.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class OrmicLauncherPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();

        window.set_default_size(620, 500);
        window.set_title(_('Ormic Launcher Settings'));

        // ── Page: General ────────────────────────────────────────────────
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        // Keybinding group
        const keybindGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcut'),
            description: _('Shortcut to open the Ormic Launcher dialog'),
        });
        generalPage.add(keybindGroup);

        const keybindRow = new Adw.ActionRow({
            title: _('Toggle launcher'),
            subtitle: _('Default: Super+Space'),
        });
        const keybindLabel = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: _('Disabled'),
        });

        // Display current shortcut
        const updateShortcutLabel = () => {
            const shortcuts = settings.get_strv('toggle-ormic-launcher');
            if (shortcuts.length > 0) {
                keybindLabel.set_accelerator(shortcuts[0]);
            } else {
                keybindLabel.set_accelerator('');
            }
        };
        updateShortcutLabel();
        settings.connect('changed::toggle-ormic-launcher', updateShortcutLabel);

        keybindRow.add_suffix(keybindLabel);
        keybindGroup.add(keybindRow);

        // System keybindings conflict detection and resolution
        const sysSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });

        let ibusSettings: Gio.Settings | null = null;
        try {
            const schemas = Gio.Settings.list_schemas() || [];
            if (schemas.includes('org.freedesktop.ibus.general.hotkey')) {
                ibusSettings = new Gio.Settings({ schema_id: 'org.freedesktop.ibus.general.hotkey' });
            }
        } catch (_e) {
            ibusSettings = null;
        }

        const conflictRow = new Adw.ActionRow({
            title: _('Shortcut Conflict Detected'),
            subtitle: _('GNOME is using Super+Space for input switching, which blocks the launcher. Click Resolve to clear the GNOME shortcut.'),
            visible: false,
        });

        const warningIcon = new Gtk.Image({
            icon_name: 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        });
        conflictRow.add_prefix(warningIcon);

        const resolveBtn = new Gtk.Button({
            label: _('Resolve Conflict'),
            valign: Gtk.Align.CENTER,
        });
        resolveBtn.add_css_class('suggested-action');

        resolveBtn.connect('clicked', () => {
            const launcherShortcuts = settings.get_strv('toggle-ormic-launcher');

            // Remove '<Super>space' from switch-input-source
            const current = sysSettings.get_strv('switch-input-source');
            const filtered = current.filter(x => !launcherShortcuts.includes(x));
            sysSettings.set_strv('switch-input-source', filtered);

            // Also check switch-input-source-backward
            const currentBack = sysSettings.get_strv('switch-input-source-backward');
            const filteredBack = currentBack.filter(x => !launcherShortcuts.includes(x) && x !== '<Shift><Super>space');
            sysSettings.set_strv('switch-input-source-backward', filteredBack);

            // Clear from IBus triggers
            if (ibusSettings) {
                const ibusTriggers = ibusSettings.get_strv('triggers');
                const filteredTriggers = ibusTriggers.filter(x => !launcherShortcuts.includes(x));
                ibusSettings.set_strv('triggers', filteredTriggers);
            }

            updateConflictVisibility();
        });

        conflictRow.add_suffix(resolveBtn);
        keybindGroup.add(conflictRow);

        const updateConflictVisibility = () => {
            const current = sysSettings.get_strv('switch-input-source');
            const currentBack = sysSettings.get_strv('switch-input-source-backward');
            const launcherShortcuts = settings.get_strv('toggle-ormic-launcher');

            const hasGnomeConflict = launcherShortcuts.some(s =>
                current.includes(s) || currentBack.includes(s)
            );

            let hasIbusConflict = false;
            if (ibusSettings) {
                const ibusTriggers = ibusSettings.get_strv('triggers');
                hasIbusConflict = launcherShortcuts.some(s => ibusTriggers.includes(s));
            }

            const hasConflict = hasGnomeConflict || hasIbusConflict;

            if (hasConflict) {
                let msg = '';
                if (hasGnomeConflict && hasIbusConflict) {
                    msg = _('GNOME and IBus are using Super+Space for input switching, which blocks the launcher. Click Resolve to clear the shortcuts.');
                } else if (hasGnomeConflict) {
                    msg = _('GNOME is using Super+Space for input switching, which blocks the launcher. Click Resolve to clear the GNOME shortcut.');
                } else {
                    msg = _('IBus is using Super+Space for input switching, which blocks the launcher. Click Resolve to clear the IBus shortcut.');
                }
                conflictRow.set_subtitle(msg);
            }

            conflictRow.set_visible(hasConflict);
        };

        updateConflictVisibility();
        sysSettings.connect('changed::switch-input-source', updateConflictVisibility);
        sysSettings.connect('changed::switch-input-source-backward', updateConflictVisibility);
        if (ibusSettings) {
            ibusSettings.connect('changed::triggers', updateConflictVisibility);
        }
        settings.connect('changed::toggle-ormic-launcher', updateConflictVisibility);

        // Show panel indicator toggle
        const indicatorRow = new Adw.SwitchRow({
            title: _('Show Top Panel Indicator'),
            subtitle: _('Show a search icon in the top panel to open the launcher'),
        });
        settings.bind('show-indicator', indicatorRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        keybindGroup.add(indicatorRow);

        // Max results
        const resultsGroup = new Adw.PreferencesGroup({
            title: _('Results'),
        });
        generalPage.add(resultsGroup);

        const maxResultsRow = new Adw.SpinRow({
            title: _('Maximum results'),
            subtitle: _('How many results to show at once'),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 24,
                step_increment: 1,
                value: settings.get_int('max-results'),
            }),
        });
        settings.bind('max-results', maxResultsRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        resultsGroup.add(maxResultsRow);

        // ── Page: Providers ──────────────────────────────────────────────
        const providersPage = new Adw.PreferencesPage({
            title: _('Providers'),
            icon_name: 'application-x-executable-symbolic',
        });
        window.add(providersPage);

        const providersGroup = new Adw.PreferencesGroup({
            title: _('Search Providers'),
            description: _('Enable or disable individual search providers'),
        });
        providersPage.add(providersGroup);

        // Web search toggle
        const webRow = new Adw.SwitchRow({
            title: _('Web Search'),
            subtitle: _('Type "g ", "d ", "y " etc. to search the web'),
        });
        settings.bind('enable-web-search', webRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        providersGroup.add(webRow);

        // Web engine chooser
        const engineGroup = new Adw.PreferencesGroup({title: _('Default Web Engine')});
        providersPage.add(engineGroup);

        const engines = ['duckduckgo', 'google', 'bing'];
        const engineLabels: Record<string, string> = {
            duckduckgo: 'DuckDuckGo (privacy-first)',
            google: 'Google',
            bing: 'Microsoft Bing',
        };
        const engineRow = new Adw.ComboRow({
            title: _('Default engine'),
            subtitle: _('Used when no prefix is specified'),
            model: new Gtk.StringList({strings: engines.map(e => engineLabels[e])}),
        });
        const currentEngine = settings.get_string('default-web-engine');
        engineRow.selected = engines.indexOf(currentEngine);
        engineRow.connect('notify::selected', () => {
            settings.set_string('default-web-engine', engines[engineRow.selected]);
        });
        engineGroup.add(engineRow);

        // Recent files toggle
        const recentGroup = new Adw.PreferencesGroup({title: _('Files')});
        providersPage.add(recentGroup);

        const recentRow = new Adw.SwitchRow({
            title: _('Recent Files'),
            subtitle: _('Search files you have recently opened'),
        });
        settings.bind('enable-recent-files', recentRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        recentGroup.add(recentRow);

        // ── Page: About ──────────────────────────────────────────────────
        const aboutPage = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });
        window.add(aboutPage);

        const aboutGroup = new Adw.PreferencesGroup();
        aboutPage.add(aboutGroup);

        const aboutRow = new Adw.ActionRow({
            title: _('Ormic Launcher'),
            subtitle: _('A modular app launcher for GNOME Shell,\ninspired by the pop-os/launcher project architecture.'),
        });
        aboutGroup.add(aboutRow);

        const versionRow = new Adw.ActionRow({
            title: _('Version'),
            subtitle: '1.0',
        });
        aboutGroup.add(versionRow);

        const tipGroup = new Adw.PreferencesGroup({title: _('Quick Reference')});
        aboutPage.add(tipGroup);

        const tips = [
            [_('Type anything'), _('Search installed applications')],
            [_('2 + 2, sqrt(16)'), _('Calculate expressions — result is copied')],
            [_('g <query>'), _('Search Google')],
            [_('d <query>'), _('Search DuckDuckGo')],
            [_('y <query>'), _('Search YouTube')],
            [_('gh <query>'), _('Search GitHub')],
            [_('w <query>'), _('Search Wikipedia')],
            [_('> <command>'), _('Run a shell command')],
        ];

        for (const [key, desc] of tips) {
            const row = new Adw.ActionRow({
                title: key,
                subtitle: desc,
            });
            tipGroup.add(row);
        }
        return Promise.resolve();
    }
}
