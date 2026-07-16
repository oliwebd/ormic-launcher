// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Grid Item Component

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';

import { SearchResult } from '../types.js';
import { dbg, boxLayoutParams } from '../utils.js';

export class GridItem extends St.Button {
    static {
        GObject.registerClass({ GTypeName: 'OrmicGridItem' }, this);
    }

    declare private _result: SearchResult;
    declare private _iconBin: St.Bin;
    declare private _nameLabel: St.Label;
    declare private _activateCb: (() => void) | null;
    declare private _hoverCb: (() => void) | null;

    _init() {
        super._init({
            style_class: 'ormic-grid-item',
            reactive: true, track_hover: true, can_focus: false,
        });

        const box = new St.BoxLayout({
            ...boxLayoutParams(true),
            style_class: 'ormic-grid-item-box',
            x_expand: true, y_expand: true,
        });
        (box.layout_manager as Clutter.BoxLayout).spacing = 4;

        this._iconBin = new St.Bin({ style_class: 'ormic-grid-icon-bin' });
        box.add_child(this._iconBin);

        this._nameLabel = new St.Label({
            style_class: 'ormic-grid-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._nameLabel.clutter_text.line_wrap = false;
        box.add_child(this._nameLabel);

        this.set_child(box);

        this.connect('clicked', () => {
            dbg('GridItem', `clicked on ${this._result.name}`);
            if (this._activateCb) this._activateCb();
        });

        this.connect('notify::hover', () => {
            if (this.hover && this._hoverCb) this._hoverCb();
        });
    }

    setup(result: SearchResult, onActivate: () => void, onHover: () => void, iconSize = 52) {
        this._result = result;
        this._activateCb = onActivate;
        this._hoverCb = onHover;

        this.setSelected(false);

        const cardW = iconSize + 20;
        const cardH = iconSize + 34;
        const binRadius = Math.round(iconSize * 0.22);
        this.set_style(`width: ${cardW}px; height: ${cardH}px;`);
        this._iconBin.set_style(`width: ${iconSize}px; border-radius: ${binRadius}px;`);

        let iconWidget: any = null;
        if (result.createIcon) {
            iconWidget = result.createIcon(iconSize - 8);
        } else if (result.icon) {
            iconWidget = result.icon;
        }

        if (iconWidget) {
            iconWidget.set_size(iconSize - 8, iconSize - 8);
            this._iconBin.set_child(iconWidget);
        } else {
            this._iconBin.set_child(new St.Icon({
                icon_name: result.iconName ?? 'application-x-executable-symbolic',
                icon_size: iconSize - 8,
                style_class: 'ormic-grid-icon-sym',
            }));
        }

        this._nameLabel.text = result.name;
    }

    get result() { return this._result; }

    setSelected(on: boolean) {
        if (on) this.add_style_class_name('selected');
        else this.remove_style_class_name('selected');
    }
}