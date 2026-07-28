// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Category Tab Component

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import { logDebug } from '../utils.js';

export class CategoryTab extends St.Button {
    static {
        GObject.registerClass({
            GTypeName: 'OrmicCategoryTab',
            Signals: { 'tab-selected': {}, 'tab-hovered': {} },
        }, this);
    }

    declare private _categoryName: string;
    declare private _iconName: string;

    _init() {
        super._init({
            style_class: 'ormic-category-tab',
            reactive: true, track_hover: true, can_focus: false,
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
        });

        this.connect('notify::hover', () => {
            if (this.hover) this.emit('tab-hovered');
        });
    }

    setup(categoryName: string, iconName: string) {
        this._categoryName = categoryName;
        this._iconName = iconName;

        const box = new St.BoxLayout({
            style_class: 'ormic-category-tab-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        (box.layout_manager as Clutter.BoxLayout).spacing = 6;

        box.add_child(new St.Icon({
            icon_name: iconName,
            icon_size: 16,
            style_class: 'ormic-category-tab-icon',
        }));

        box.add_child(new St.Label({
            text: categoryName,
            style_class: 'ormic-category-tab-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this.set_child(box);

        this.connect('clicked', () => {
            logDebug('CategoryTab', `clicked on ${categoryName}`);
            this.emit('tab-selected');
        });
    }

    get categoryName() { return this._categoryName; }

    setSelected(on: boolean) {
        if (on) this.add_style_class_name('active');
        else this.remove_style_class_name('active');
    }
}
