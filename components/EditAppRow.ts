// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Edit App Checklist Row Component

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import { SearchResult } from '../types.js';
import { dbg } from '../utils.js';

export const EditAppRow = GObject.registerClass({
    Signals: { toggle: {} },
}, class EditAppRow extends St.Button {
    private _result!: SearchResult;
    private _selected = false;
    private _checkIcon!: St.Icon;

    _init() {
        super._init({
            style_class: 'ormic-edit-row',
            reactive: true, track_hover: true, can_focus: false,
        });
    }

    setup(result: SearchResult, selected: boolean) {
        this._result = result;
        this._selected = selected;

        const box = new St.BoxLayout({
            style_class: 'ormic-edit-row-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const iconBin = new St.Bin({ style_class: 'ormic-edit-icon-bin' });
        if (result.createIcon) {
            const texture = result.createIcon(32);
            if (texture) {
                texture.set_size(32, 32);
                iconBin.set_child(texture);
            }
        } else if (result.icon) {
            result.icon.set_size(32, 32);
            iconBin.set_child(result.icon);
        } else {
            iconBin.set_child(new St.Icon({
                icon_name: result.iconName ?? 'application-x-executable-symbolic',
                icon_size: 32,
            }));
        }
        box.add_child(iconBin);

        const nameLabel = new St.Label({
            text: result.name,
            style_class: 'ormic-edit-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(nameLabel);

        this._checkIcon = new St.Icon({
            icon_name: this._selected ? 'checkbox-checked-symbolic' : 'checkbox-symbolic',
            icon_size: 16,
            style_class: 'ormic-edit-checkbox',
        });
        box.add_child(this._checkIcon);

        this.set_child(box);

        if (this._selected) this.add_style_class_name('selected');

        this.connect('button-release-event', (actor, ev) => {
            if (ev.get_button() === 1) {
                dbg('EditAppRow', `clicked on ${result.name}`);
                this.toggle();
                this.emit('toggle');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    toggle() {
        this._selected = !this._selected;
        this._checkIcon.icon_name = this._selected ? 'checkbox-checked-symbolic' : 'checkbox-symbolic';
        if (this._selected) this.add_style_class_name('selected');
        else this.remove_style_class_name('selected');
    }

    get result() { return this._result; }
    get selected() { return this._selected; }
});
export type EditAppRow = InstanceType<typeof EditAppRow>;
