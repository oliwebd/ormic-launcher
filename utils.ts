// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Shared Utilities

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

// Debug helper — set to true only during active development
export let DEBUG = false;

export function setDebug(val: boolean) {
  DEBUG = val;
}

export function dbg(scope: string, msg: string, ...args: any[]) {
  if (!DEBUG) return;
  const extra = args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
  console.log(`[Ormic:${scope}] ${msg}${extra}`);
}

export const SHELL_MAJOR = parseInt((Config as any).PACKAGE_VERSION.split('.')[0], 10);
export const IS_50_PLUS = SHELL_MAJOR >= 50;
export const IS_48_PLUS = SHELL_MAJOR >= 48;

// GNOME 46/47 uses `vertical`; GNOME 48+ uses `orientation`. Always pass the right one.
export function boxLayoutParams(vertical: boolean): object {
  if (IS_48_PLUS) {
    return { orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL };
  }
  return { vertical };
}

export function createAppIcon(app: any, size: number): any {
  const info = app.get_app_info();
  const gicon = info.get_icon();
  if (gicon) return new St.Icon({ gicon, icon_size: size });
  return app.create_icon_texture(size);
}

export function iconFromGicon(gicon: any, size: number): St.Icon {
  return new St.Icon({ gicon, icon_size: size });
}



// GLib.timeout_add_once() returns void (no cancel ID), so we always use
// timeout_add() to keep sources cancellable.
export function timeoutOnce(ms: number, fn: () => void): number {
  return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    fn();
    return GLib.SOURCE_REMOVE;
  });
}

// GNOME 50+ has idle_add_once(); fall back to idle_add() + SOURCE_REMOVE on older shells.
export function idleOnce(fn: () => void): void {
  if (IS_50_PLUS && (GLib as any).idle_add_once) {
    (GLib as any).idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, fn);
    return;
  }
  GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    fn();
    return GLib.SOURCE_REMOVE;
  });
}

// GNOME 50+ has easeAsync(); wrap ease() in a Promise on older shells.
export function easeActor(actor: Clutter.Actor, params: any): Promise<void> {
  const { onComplete, ...rest } = params;
  if (IS_50_PLUS && typeof (actor as any).easeAsync === 'function') {
    return (actor as any).easeAsync(rest).then(() => {
      if (onComplete) onComplete();
    }).catch(() => { });
  }
  return new Promise<void>(resolve => {
    actor.ease({ ...rest, onComplete: () => { if (onComplete) onComplete(); resolve(); } });
  });
}

export function scrollToActor(scrollView: St.ScrollView, actor: Clutter.Actor) {
  if (typeof (scrollView as any).ensure_actor_visible === 'function') {
    (scrollView as any).ensure_actor_visible(actor);
    return;
  }

  const adj = scrollView.vadjustment;
  if (!adj) return;
  const [, ay] = actor.get_transformed_position();
  const [, svy] = scrollView.get_transformed_position();
  const relY = ay - svy + adj.value;
  const viewHeight = scrollView.height;
  const actorHeight = actor.height;
  if (relY < adj.value)
    adj.set_value(relY - 8);
  else if (relY + actorHeight > adj.value + viewHeight)
    adj.set_value(relY + actorHeight - viewHeight + 8);
}

export function listAllWindows(): any[] {
  const display = global.display as any;
  return (display.list_all_windows() as any[]).filter(
    (w: any) =>
      w.get_window_type() === Meta.WindowType.NORMAL &&
      !w.is_skip_taskbar(),
  );
}

export function appForWindow(win: any): any {
  const tracker = Shell.WindowTracker.get_default();
  const app = tracker.get_window_app(win);
  if (app) return app;
  return Shell.AppSystem.get_default().lookup_app(win.get_wm_class());
}
