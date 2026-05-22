// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Grid Item Component

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';

import { SearchResult } from '../types.js';
import { dbg } from '../utils.js';

export const GridItem = GObject.registerClass({
    Signals: { 'item-activated': {}, 'item-hovered': {} },
}, class GridItem extends St.Button {
    private _result!: SearchResult;
    private _box!: St.BoxLayout;

    _init() {
        super._init({
            style_class: 'ormic-grid-item',
            reactive: true, track_hover: true, can_focus: false,
        });
    }

    setup(result: SearchResult) {
        this._result = result;

        this._box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'ormic-grid-item-box',
            x_expand: true, y_expand: true,
        });

        const iconBin = new St.Bin({ style_class: 'ormic-grid-icon-bin' });
        if (result.createIcon) {
            const texture = result.createIcon(44);
            if (texture) {
                texture.set_size(44, 44);
                iconBin.set_child(texture);
            }
        } else if (result.icon) {
            result.icon.set_size(44, 44);
            iconBin.set_child(result.icon);
        } else {
            iconBin.set_child(new St.Icon({
                icon_name: result.iconName ?? 'application-x-executable-symbolic',
                icon_size: 44,
                style_class: 'ormic-grid-icon-sym',
            }));
        }
        this._box.add_child(iconBin);

        const nameLabel = new St.Label({
            text: result.name,
            style_class: 'ormic-grid-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        nameLabel.clutter_text.line_wrap = false;
        this._box.add_child(nameLabel);

        this.set_child(this._box);

        this.connect('button-release-event', (actor, ev) => {
            if (ev.get_button() === 1) {
                dbg('GridItem', `clicked on ${result.name}`);
                this.emit('item-activated');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('notify::hover', () => {
            if (this.hover) this.emit('item-hovered');
        });
    }

    get result() { return this._result; }

    setSelected(on: boolean) {
        if (on) {
            this.add_style_class_name('selected');
        } else {
            this.remove_style_class_name('selected');
        }
    }
});
export type GridItem = InstanceType<typeof GridItem>;
