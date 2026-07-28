// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Result Row Component (Search list view)

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SearchResult } from '../types.js';
import { logDebug, boxLayoutParams } from '../utils.js';

export class ResultRow extends St.Button {
    static {
        GObject.registerClass({
            GTypeName: 'OrmicResultRow',
            Signals: { 'item-activated': {}, 'item-hovered': {} },
        }, this);
    }

    declare private _result: SearchResult;
    declare private _accentBar: St.Widget;
    declare _favButton?: St.Button;

    _init() {
        super._init({
            style_class: 'ormic-result',
            reactive: true, track_hover: true, can_focus: false,
        });
    }

    setup(
        result: SearchResult,
        index: number,
        settings: Gio.Settings,
        shellSettings: Gio.Settings,
    ) {
        this._result = result;

        const mainBox = new St.BoxLayout({
            style_class: 'ormic-result-box',
            x_expand: true,
        });

        this._accentBar = new St.Widget({ name: 'ormic-accent-bar', style_class: 'ormic-accent-bar' });
        mainBox.add_child(this._accentBar);

        const iconBin = new St.Bin({ style_class: 'ormic-icon-bin' });
        if (result.createIcon) {
            const texture = result.createIcon(48);
            if (texture) {
                texture.set_size(48, 48);
                iconBin.set_child(texture);
            }
        } else if (result.icon) {
            result.icon.set_size(48, 48);
            iconBin.set_child(result.icon);
        } else {
            iconBin.set_child(new St.Icon({
                icon_name: result.iconName ?? 'application-x-executable-symbolic',
                icon_size: 48,
                style_class: 'ormic-icon-sym',
            }));
        }
        mainBox.add_child(iconBin);

        const textCol = new St.BoxLayout({
            style_class: 'ormic-text-col',
            ...boxLayoutParams(true), x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        (textCol.layout_manager as Clutter.BoxLayout).spacing = 2;

        const nameLabel = new St.Label({
            text: result.name, style_class: 'ormic-name',
            x_align: Clutter.ActorAlign.START,
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textCol.add_child(nameLabel);
        if (result.description) {
            const dl = new St.Label({
                text: result.description, style_class: 'ormic-desc',
                x_align: Clutter.ActorAlign.START,
            });
            dl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textCol.add_child(dl);
        }
        mainBox.add_child(textCol);

        if (result.desktopId) {
            const id = result.desktopId;
            const isFav = () =>
                (shellSettings.get_strv('favorite-apps') as string[]).includes(id);
            const favIco = new St.Icon({
                icon_name: isFav() ? 'emblem-favorite-symbolic' : 'bookmark-new-symbolic',
                icon_size: 14,
            });
            const favBtn = new St.Button({
                child: favIco, style_class: 'ormic-fav-btn',
                reactive: true, can_focus: false, track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._favButton = favBtn;
            if (isFav()) favBtn.add_style_class_name('is-fav');
            favBtn.connect('clicked', () => {
                const favs = shellSettings.get_strv('favorite-apps') as string[];
                const idx = favs.indexOf(id);
                if (idx > -1) {
                    favs.splice(idx, 1);
                    favIco.icon_name = 'bookmark-new-symbolic';
                    favBtn.remove_style_class_name('is-fav');
                } else {
                    favs.push(id);
                    favIco.icon_name = 'emblem-favorite-symbolic';
                    favBtn.add_style_class_name('is-fav');
                }
                shellSettings.set_strv('favorite-apps', favs);
            });
            mainBox.add_child(favBtn);
        }

        if (settings.get_boolean('enable-quick-select') && index >= 0 && index < 9) {
            mainBox.add_child(new St.Label({
                text: `Ctrl+${index + 1}`, style_class: 'ormic-kbd-badge',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const pill = new St.BoxLayout({
            style_class: 'ormic-cat-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        (pill.layout_manager as Clutter.BoxLayout).spacing = 5;

        pill.add_child(new St.Icon({
            icon_name: result.categoryIcon, icon_size: 11,
            style_class: 'ormic-cat-icon',
        }));
        pill.add_child(new St.Label({
            text: result.category, style_class: 'ormic-cat-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        mainBox.add_child(pill);

        this.set_child(mainBox);

        this.connect('clicked', () => {
            logDebug('ResultRow', `clicked on ${result.name}`);
            this.emit('item-activated');
        });

        this.connect('notify::hover', () => {
            if (this.hover) this.emit('item-hovered');
        });
    }

    get result() { return this._result; }

    setSelected(on: boolean) {
        if (on) this.add_style_class_name('selected');
        else this.remove_style_class_name('selected');
    }
}