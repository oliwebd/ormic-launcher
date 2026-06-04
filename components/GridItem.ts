// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Grid Item Component

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';

import { SearchResult } from '../types.js';
import { dbg, boxLayoutParams } from '../utils.js';

/**
 * Pooled, reusable grid item widget.
 * Widget tree and signal connections are built once in _init(); setup() just
 * swaps the bound data and callbacks — no allocation or signal churn on reuse.
 */
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
            dbg('GridItem', `clicked on ${this._result?.name}`);
            this._activateCb?.();
        });

        this.connect('notify::hover', () => {
            if (this.hover) this._hoverCb?.();
        });
    }

    setup(result: SearchResult, onActivate: () => void, onHover: () => void) {
        this._result = result;
        this._activateCb = onActivate;
        this._hoverCb = onHover;

        this.setSelected(false);

        let iconWidget: any = null;
        if (result.createIcon) {
            iconWidget = result.createIcon(44);
        } else if (result.icon) {
            iconWidget = result.icon;
        }

        if (iconWidget) {
            iconWidget.set_size(44, 44);
            this._iconBin.set_child(iconWidget);
        } else {
            this._iconBin.set_child(new St.Icon({
                icon_name: result.iconName ?? 'application-x-executable-symbolic',
                icon_size: 44,
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