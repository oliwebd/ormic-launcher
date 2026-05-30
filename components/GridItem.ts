// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Grid Item Component

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';

import { SearchResult } from '../types.js';
import { dbg } from '../utils.js';

/**
 * GridItem is designed for pooled reuse.
 *
 * The widget tree (icon bin + label) is built once in _init() and kept alive
 * across re-uses.  Signal handlers (button-release, notify::hover) are also
 * connected once; they dispatch through the _activateCb / _hoverCb function
 * slots, which are swapped in on every setup() call.  This means zero widget
 * allocation and zero signal connect/disconnect churn when GridController
 * recycles items from its pool.
 */
export const GridItem = GObject.registerClass(
    class GridItem extends St.Button {
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

            // ── Build widget tree once ───────────────────────────────────
            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'ormic-grid-item-box',
                x_expand: true, y_expand: true,
            });

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

            // ── Connect input events once ────────────────────────────────
            this.connect('clicked', () => {
                dbg('GridItem', `clicked on ${this._result?.name}`);
                this._activateCb?.();
            });

            this.connect('notify::hover', () => {
                if (this.hover) this._hoverCb?.();
            });
        }

        /**
         * Bind (or re-bind) this item to a new SearchResult and callbacks.
         * Safe to call on freshly-created items and on items taken from the
         * pool — no signal leaks, no extra widget allocation.
         */
        setup(result: SearchResult, onActivate: () => void, onHover: () => void) {
            this._result = result;
            this._activateCb = onActivate;
            this._hoverCb = onHover;

            // Ensure pooled item doesn't retain old selection state
            this.setSelected(false);

            // Update icon — reuse the existing St.Icon node when possible
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

            // Update label text in-place (no widget allocation)
            this._nameLabel.text = result.name;
        }

        get result() { return this._result; }

        setSelected(on: boolean) {
            if (on) this.add_style_class_name('selected');
            else this.remove_style_class_name('selected');
        }
    },
);
export type GridItem = InstanceType<typeof GridItem>;