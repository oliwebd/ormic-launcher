// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Shared Utilities

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

// Debug helper configuration — set to true only during development
export const DEBUG = true;

export function dbg(scope: string, msg: string, ...args: any[]) {
    if (!DEBUG) return;
    const extra = args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
    log(`[Ormic:${scope}] ${msg}${extra}`);
}

export function createAppIcon(app: any, size: number): any {
    if (app && typeof app.get_app_info === 'function') {
        const info = app.get_app_info();
        if (info && typeof info.get_icon === 'function') {
            const gicon = info.get_icon();
            if (gicon) {
                return new St.Icon({
                    gicon: gicon,
                    icon_size: size,
                });
            }
        }
    }
    if (app && typeof app.create_icon_texture === 'function') {
        return app.create_icon_texture(size);
    }
    return null;
}

export const SHELL_MAJOR = parseInt((Config as any).PACKAGE_VERSION.split('.')[0], 10);
export const IS_50_PLUS = SHELL_MAJOR >= 50;

/**
 * One-shot timeout.
 *   GNOME 50+  → GLib.timeout_add_once()  (returns void; not cancellable)
 *   GNOME <50  → GLib.timeout_add()  + SOURCE_REMOVE
 */
export function timeoutOnce(ms: number, fn: () => void): number | undefined {
    if (IS_50_PLUS && (GLib as any).timeout_add_once) {
        (GLib as any).timeout_add_once(GLib.PRIORITY_DEFAULT, ms, fn);
        return undefined;
    }
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Await-able ease animation.
 *   GNOME 50+  → actor.easeAsync()
 *   GNOME <50  → actor.ease() wrapped in a Promise
 */
export function easeActor(actor: Clutter.Actor, params: any): Promise<void> {
    const { onComplete, ...rest } = params;
    if (IS_50_PLUS && typeof (actor as any).easeAsync === 'function') {
        return (actor as any).easeAsync(rest).then(() => {
            if (onComplete) onComplete();
        }).catch(() => { /* ignore animation cancellation */ });
    }
    return new Promise<void>(resolve => {
        actor.ease({ ...rest, onComplete: () => { onComplete?.(); resolve(); } });
    });
}

/**
 * Scroll a St.ScrollView so that `actor` is visible.
 */
export function scrollToActor(scrollView: St.ScrollView, actor: Clutter.Actor) {
    try {
        if (typeof (scrollView as any).ensure_actor_visible === 'function') {
            (scrollView as any).ensure_actor_visible(actor);
            return;
        }
    } catch (_e) { /* fall through */ }

    try {
        const adj = scrollView.vadjustment;
        if (!adj) return;

        const [, ay] = actor.get_transformed_position();
        const [, svy] = scrollView.get_transformed_position();

        const relY = ay - svy + adj.value;
        const viewHeight = scrollView.height;
        const actorHeight = actor.height;

        if (relY < adj.value) {
            adj.set_value(relY - 8);
        } else if (relY + actorHeight > adj.value + viewHeight) {
            adj.set_value(relY + actorHeight - viewHeight + 8);
        }
    } catch (_e) { /* nothing to do */ }
}

/**
 * List all normal, visible windows.
 */
export function listAllWindows(): any[] {
    try {
        const display = global.display as any;
        if (typeof display.list_all_windows === 'function') {
            return (display.list_all_windows() as any[]).filter(
                (w: any) =>
                    w.get_window_type?.() === Meta.WindowType.NORMAL &&
                    !w.is_skip_taskbar?.(),
            );
        }
    } catch (_e) { }
    return (global.get_window_actors() as any[])
        .map((a: any) => a.meta_window)
        .filter((w: any) => w && !w.is_skip_taskbar?.());
}

/**
 * Resolve the Shell.App that owns a MetaWindow.
 */
export function appForWindow(win: any): any {
    try {
        const tracker = Shell.WindowTracker.get_default();
        if (typeof tracker?.get_window_app === 'function')
            return tracker.get_window_app(win);
    } catch (_e) { }
    return Shell.AppSystem.get_default().lookup_app(win.get_wm_class?.() ?? '');
}