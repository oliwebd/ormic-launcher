// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Calculator Search Provider

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SearchResult } from '../types.js';

export class CalcProvider {
    id = 'calc'; priority = 5;
    private _start = /^[\d.(]/;
    private _kw = /\b(sin|cos|tan|sqrt|log|ln|exp|pi)\b/gi;
    private _safe = /^[0-9\s+\-*/.,%^()e]+$/i;

    private valid(q: string) {
        return this._start.test(q) && this._safe.test(q.replace(this._kw, '0'));
    }

    search(q: string): SearchResult[] {
        q = q.trim();
        if (!q || !this.valid(q)) return [];
        try {
            const s = q
                .replace(/\^/g, '**').replace(/,/g, '.')
                .replace(/\bsin\b/g, 'Math.sin').replace(/\bcos\b/g, 'Math.cos')
                .replace(/\btan\b/g, 'Math.tan').replace(/\bsqrt\b/g, 'Math.sqrt')
                .replace(/\blog\b/g, 'Math.log10').replace(/\bln\b/g, 'Math.log')
                .replace(/\bexp\b/g, 'Math.exp').replace(/\bpi\b/gi, 'Math.PI')
                .replace(/(?<![A-Za-z])e(?![A-Za-z])/g, 'Math.E');
             
            const v = new Function(`"use strict"; return (${s})`)();
            if (typeof v !== 'number' || !isFinite(v)) return [];
            const display = Number.isInteger(v) ? String(v) : parseFloat(v.toPrecision(10)).toString();
            return [{
                id: 'calc:result', name: display, description: `= ${q}`,
                score: 95, providerPriority: this.priority,
                iconName: 'accessories-calculator-symbolic',
                categoryIcon: 'accessories-calculator-symbolic', category: _('Calc'),
                activate: () => {
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, display);
                    Main.notify(_('Copied to clipboard'), display);
                },
            }];
        } catch (_e) { return []; }
    }
}
