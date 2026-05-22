// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Keyboard Handler

import Clutter from 'gi://Clutter';
import type { LauncherState } from './LauncherState.js';
import type { SearchController } from './SearchController.js';
import type { GridController } from './GridController.js';
import type { GroupEditorController } from './GroupEditorController.js';

export class KeyboardHandler {
    private _s: LauncherState;
    private _search: SearchController;
    private _grid: GridController;
    private _editor: GroupEditorController;

    constructor(
        state: LauncherState,
        search: SearchController,
        grid: GridController,
        editor: GroupEditorController
    ) {
        this._s = state;
        this._search = search;
        this._grid = grid;
        this._editor = editor;
    }

    onKey(ev: any): boolean {
        const s = this._s;
        const sym = ev.get_key_symbol();
        const ctrl = !!(ev.get_state() & Clutter.ModifierType.CONTROL_MASK);

        if (s.promptOverlay.visible) {
            if (sym === Clutter.KEY_Escape) { this._editor.hidePromptOverlay(false); return true; }
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._editor.hidePromptOverlay(true); return true; }
            return false;
        }

        if (s.isEditing) {
            if (sym === Clutter.KEY_Escape) { this._editor.stopEditing(false); return true; }
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._editor.stopEditing(true); return true; }
            return false;
        }

        if (s.scroll.visible && ctrl && s.ext._settings.get_boolean('enable-quick-select')
            && sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
            this._search.activateIdx(sym - Clutter.KEY_1); return true;
        }

        if (!s.scroll.visible && s.entry.text === '' && (sym === Clutter.KEY_Shift_L || sym === Clutter.KEY_Shift_R)) {
            const cats = this._grid.getCategoriesList();
            const idx = cats.indexOf(s.activeCategory);
            if (idx > -1) {
                this._grid.selectCategory(cats[(idx + 1) % cats.length]);
                s.focus();
                return true;
            }
        }

        if (sym === Clutter.KEY_Escape) { s.ext.hide(); return true; }

        if (s.scroll.visible) {
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._search.activateSel(); return true; }
            if (sym === Clutter.KEY_Up) { this._search.moveSel(-1); return true; }
            if (sym === Clutter.KEY_Down) { this._search.moveSel(1); return true; }
            if (sym === Clutter.KEY_Tab) { this._search.complete(); return true; }
        } else {
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._grid.activateGridSel(); return true; }
            if (sym === Clutter.KEY_Up) { this._grid.moveGridSel(-7); return true; }
            if (sym === Clutter.KEY_Down) { this._grid.moveGridSel(7); return true; }
            if (sym === Clutter.KEY_Left) { this._grid.moveGridSel(-1); return true; }
            if (sym === Clutter.KEY_Right) { this._grid.moveGridSel(1); return true; }

            const char = Clutter.keysym_to_unicode(sym);
            if (char && char >= 32 && char <= 126 && !ctrl) {
                s.entry.text = String.fromCharCode(char);
                s.entry.clutter_text.set_cursor_position(-1);
                s.entry.grab_key_focus();
                return true;
            }
        }
        return false;
    }
}
