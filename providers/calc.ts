// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Calculator Search Provider

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SearchResult } from '../types.js';

export class CalcProvider {
    id = 'calc'; priority = 5;
    private _start = /^[\d.(]|^(sin|cos|tan|sqrt|log|ln|exp|pi)\b/i;

    private valid(q: string): boolean {
        return this._start.test(q);
    }

    search(q: string): SearchResult[] {
        q = q.trim().replace(/,/g, '.').replace(/\^/g, '**');
        if (!q || !this.valid(q)) return [];
        try {
            const v = this._eval(q);
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

    private _eval(src: string): number {
        let i = 0;
        const skip = () => { while (i < src.length && src[i] === ' ') i++; };

        const FUNS: Record<string, (x: number) => number> = {
            sin: Math.sin, cos: Math.cos, tan: Math.tan,
            sqrt: Math.sqrt, log: Math.log10, ln: Math.log, exp: Math.exp,
        };
        const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

        const expr = (): number => {
            let v = term();
            for (;;) {
                skip();
                if (src[i] === '+') { i++; v += term(); }
                else if (src[i] === '-') { i++; v -= term(); }
                else break;
            }
            return v;
        };

        const term = (): number => {
            let v = power();
            for (;;) {
                skip();
                if (src.slice(i, i + 2) === '**') break;
                if (src[i] === '*') { i++; v *= power(); }
                else if (src[i] === '/') { i++; v /= power(); }
                else if (src[i] === '%') { i++; v %= power(); }
                else break;
            }
            return v;
        };

        const power = (): number => {
            const base = unary();
            skip();
            if (src.slice(i, i + 2) === '**') { i += 2; return base ** unary(); }
            return base;
        };

        const unary = (): number => {
            skip();
            if (src[i] === '-') { i++; return -primary(); }
            if (src[i] === '+') { i++; return +primary(); }
            return primary();
        };

        const primary = (): number => {
            skip();
            if (src[i] === '(') {
                i++;
                const v = expr();
                skip();
                if (src[i] === ')') i++;
                return v;
            }
            if ((src[i] >= '0' && src[i] <= '9') || src[i] === '.') {
                const s = i;
                while (i < src.length && /[\d.]/.test(src[i])) i++;
                if (i < src.length && (src[i] === 'e' || src[i] === 'E') &&
                    i + 1 < src.length && /[\d+\-]/.test(src[i + 1])) {
                    i++;
                    if (src[i] === '+' || src[i] === '-') i++;
                    while (i < src.length && /\d/.test(src[i])) i++;
                }
                return parseFloat(src.slice(s, i));
            }
            if (/[a-zA-Z]/.test(src[i])) {
                const s = i;
                while (i < src.length && /[a-zA-Z]/.test(src[i])) i++;
                const name = src.slice(s, i).toLowerCase();
                skip();
                if (name in FUNS) {
                    if (src[i] !== '(') throw new Error(`expected ( after ${name}`);
                    i++;
                    const arg = expr();
                    skip();
                    if (src[i] === ')') i++;
                    return FUNS[name](arg);
                }
                if (name in CONSTS) return CONSTS[name];
                throw new Error(`unknown identifier: ${name}`);
            }
            throw new Error(`unexpected character: ${src[i]}`);
        };

        const result = expr();
        skip();
        if (i !== src.length) throw new Error('trailing input');
        return result;
    }
}
