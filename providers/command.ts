// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Command Search Provider

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SearchResult } from '../types.js';
import { dbg } from '../utils.js';

export class CommandProvider {
    id = 'command'; priority = 8;
    search(query: string): SearchResult[] {
        const q = query.trim();
        if (!q.startsWith('>')) return [];
        const cmd = q.slice(1).trim(); if (!cmd) return [];
        return [{
            id: 'cmd:run', name: `Run: ${cmd}`, description: _('Execute shell command'),
            score: 90, providerPriority: this.priority,
            iconName: 'utilities-terminal-symbolic',
            categoryIcon: 'utilities-terminal-symbolic', category: _('Command'),
            activate: () => {
                dbg('Command', 'spawn:', cmd);
                try { GLib.spawn_command_line_async(cmd); }
                catch (e: any) { Main.notifyError(_('Command Error'), e.message); }
            },
        }];
    }
}
