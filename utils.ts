// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Shared Utilities

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

// Debug helper — set to true only during active development
export const DEBUG = false;

export function dbg(scope: string, msg: string, ...args: any[]) {
  if (!DEBUG) return;
  const extra = args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
  console.log(`[Ormic:${scope}] ${msg}${extra}`);
}

export const SHELL_MAJOR = parseInt((Config as any).PACKAGE_VERSION.split('.')[0], 10);
export const IS_50_PLUS = SHELL_MAJOR >= 50;
export const IS_48_PLUS = SHELL_MAJOR >= 48;

/**
 * Cross-version helper for St.BoxLayout direction.
 *
 * GNOME 46/47 — only supports `vertical: true/false`; the `orientation`
 *               property does not exist on St.BoxLayout.
 * GNOME 48+   — `vertical` is deprecated; use `orientation: Clutter.Orientation.*`.
 *
 * Spread the result into the constructor params object:
 *   new St.BoxLayout({ ...boxLayoutParams(true), style_class: '...' })
 */
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

/**
 * Create an St.Icon from a pre-fetched GIcon — avoids get_app_info().get_icon()
 * call chain on every render when the GIcon is already cached.
 */
export function iconFromGicon(gicon: any, size: number): St.Icon {
  return new St.Icon({ gicon, icon_size: size });
}

/**
 * Create a Shell.BlurEffect compatible with ALL supported GNOME versions (45–50).
 *
 * Root cause of the GNOME 50 blur regression:
 *   On GNOME 45–49, Shell.BlurEffect.sigma is a writable GObject property that
 *   can be set after construction.  In GNOME 50 (Shell 18 / Mutter 18) the
 *   internal Cogl pipeline is compiled at construction time, so `sigma` (and
 *   `brightness`) must be provided in the constructor params object — setting
 *   them afterwards is a silent no-op that leaves a zero-sigma (invisible) blur.
 *
 * This helper always passes every parameter upfront, which is valid on every
 * version in the 45–50 matrix, eliminating the need for the `(blur as any).sigma`
 * workaround entirely.
 *
 * @param sigma      Blur radius in pixels (typ. 30–80 for glassmorphic look).
 * @param brightness Brightness multiplier, 0.0–1.0 (default 1.0 = unchanged).
 * @param mode       Shell.BlurMode — BACKGROUND (default) blurs what is behind
 *                   the actor; ACTOR blurs the actor's own content.
 */
export function createBlurEffect(
  sigma: number,
  brightness = 1.0,
  mode: Shell.BlurMode = Shell.BlurMode.BACKGROUND,
): Shell.BlurEffect {
  const effectParams: any = { brightness, mode };
  if (IS_50_PLUS) {
    // GNOME 50 removed sigma in favor of radius.
    // Extremely high radius values (e.g. sigma 36 -> radius 72) without a native
    // downscale property will completely choke the Cogl pipeline.
    // Capping the radius drastically improves performance.
    effectParams.radius = Math.min(sigma, 14.0);
  } else {
    effectParams.sigma = sigma;
  }
  return new Shell.BlurEffect(effectParams);
}

/**
 * One-shot timeout — always returns a cancellable GLib source ID.
 *
 * We intentionally avoid GLib.timeout_add_once() even on GNOME 50+ because
 * that API returns void, making the source impossible to cancel.  Every call
 * site that stores the return value (SearchController.onText, cleanup paths)
 * needs a valid ID so it can call GLib.source_remove() before creating a new
 * timer or on extension disable.
 */
export function timeoutOnce(ms: number, fn: () => void): number {
  return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    fn();
    return GLib.SOURCE_REMOVE;
  });
}

/**
 * One-shot idle callback — runs when the main loop is idle.
 *   GNOME 50+  → GLib.idle_add_once()
 *   GNOME <50  → GLib.idle_add() + SOURCE_REMOVE
 *
 * Use this for deferred / chunked work that should not block a frame.
 */
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
    }).catch(() => { });
  }
  return new Promise<void>(resolve => {
    actor.ease({ ...rest, onComplete: () => { if (onComplete) onComplete(); resolve(); } });
  });
}

/**
 * Scroll a St.ScrollView so that `actor` is visible.
 */
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

/**
 * List all normal, visible windows.
 */
export function listAllWindows(): any[] {
  const display = global.display as any;
  return (display.list_all_windows() as any[]).filter(
    (w: any) =>
      w.get_window_type() === Meta.WindowType.NORMAL &&
      !w.is_skip_taskbar(),
  );
}

/**
 * Resolve the Shell.App that owns a MetaWindow.
 */
export function appForWindow(win: any): any {
  const tracker = Shell.WindowTracker.get_default();
  const app = tracker.get_window_app(win);
  if (app) return app;
  return Shell.AppSystem.get_default().lookup_app(win.get_wm_class());
}
