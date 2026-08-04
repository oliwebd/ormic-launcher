// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Group Editor Controller
//
// Manages the "Create New Group" modal prompt, and the group editor
// checklist screen where apps can be checked/unchecked to belong to a custom group.

import Clutter from 'gi://Clutter';
import { timeoutOnce, easeActor } from '../utils.js';
import { EditAppRow } from '../components/EditAppRow.js';
import type { LauncherState } from './LauncherState.js';
import type { GridController } from './GridController.js';

export class GroupEditorController {
    private _s: LauncherState;
    private _grid: GridController;

    constructor(state: LauncherState, gridController: GridController) {
        this._s = state;
        this._grid = gridController;
    }

    startEditing(): void {
        const s = this._s;
        s.isEditing = true;
        s.headerBox.hide();
        s.gridScroll.hide();
        s.pageNavBox.hide();
        s.setTabsVisible(false);

        s.editorNameEntry.set_text(s.activeCategory);
        s.editorAppsContainer.destroy_all_children();

        const apps = s.allAppsCache;
        const customGroups = this._grid.getCustomGroups();
        const groupAppIds = customGroups[s.activeCategory] || [];

        apps.forEach(app => {
            const row = new EditAppRow();
            row.setup(app, groupAppIds.includes(app.desktopId ?? ''));
            s.editorAppsContainer.add_child(row);
        });

        s.editorBox.show();
        s.editorNameEntry.grab_key_focus();
    }

    stopEditing(save: boolean): void {
        const s = this._s;
        s.isEditing = false;
        s.editorBox.hide();
        s.headerBox.show();
        s.gridScroll.show();
        s.setTabsVisible(true);

        if (save) {
            const newName = s.editorNameEntry.get_text().trim();
            const customGroups = this._grid.getCustomGroups();

            const selectedIds: string[] = [];
            s.editorAppsContainer.get_children().forEach((child: any) => {
                const row = child as EditAppRow;
                if (row.selected && row.result.desktopId) {
                    selectedIds.push(row.result.desktopId);
                }
            });

            if (newName && newName !== s.activeCategory) {
                delete customGroups[s.activeCategory];
                customGroups[newName] = selectedIds;
                s.activeCategory = newName;
            } else if (newName) {
                customGroups[s.activeCategory] = selectedIds;
            }

            this._grid.saveCustomGroups(customGroups);
        }

        this._grid.renderGridAndTabs();
        timeoutOnce(50, () => s.focus());
    }

    deleteActiveCategory(): void {
        const customGroups = this._grid.getCustomGroups();
        delete customGroups[this._s.activeCategory];
        this._grid.saveCustomGroups(customGroups);

        this._s.activeCategory = 'Library Home';
        this._grid.renderGridAndTabs();
        timeoutOnce(50, () => this._s.focus());
    }

    showPromptOverlay(): void {
        const s = this._s;
        s.headerBox.hide();
        s.gridScroll.hide();
        s.pageNavBox.hide();
        s.setTabsVisible(false);
        
        s.promptEntry.set_text('');

        s.promptOverlay.remove_all_transitions();
        s.promptCard.remove_all_transitions();

        s.promptOverlay.opacity = 0;
        s.promptCard.opacity = 0;
        s.promptCard.scale_x = 0.92;
        s.promptCard.scale_y = 0.92;
        s.promptOverlay.show();

        easeActor(s.promptOverlay, { opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        easeActor(s.promptCard, {
            opacity: 255, scale_x: 1, scale_y: 1,
            duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });

        s.promptEntry.grab_key_focus();
    }

    hidePromptOverlay(create: boolean): void {
        const s = this._s;

        s.promptOverlay.remove_all_transitions();
        s.promptCard.remove_all_transitions();
        easeActor(s.promptOverlay, { opacity: 0, duration: 100, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => s.promptOverlay.hide() });
        easeActor(s.promptCard, { opacity: 0, scale_x: 0.94, scale_y: 0.94, duration: 100, mode: Clutter.AnimationMode.EASE_IN_QUAD });

        s.headerBox.show();
        s.gridScroll.show();
        s.setTabsVisible(true);

        const gName = s.promptEntry.get_text().trim();

        if (create && gName) {
            const customGroups = this._grid.getCustomGroups();
            if (!customGroups[gName]) {
                customGroups[gName] = [];
                this._grid.saveCustomGroups(customGroups);
                s.activeCategory = gName;

                this._grid.renderGridAndTabs();
                this.startEditing();
                return;
            }
        }

        this._grid.renderGridAndTabs();
        timeoutOnce(50, () => s.focus());
    }
}
