// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// What the dial applies to: the focused window and its application.

import Shell from 'gi://Shell';

/**
 * @returns {{appId: string|null, wmClass: string|null, title: string|null, app: Shell.App|null}|null}
 *   the focused window, or null if no window has focus
 */
export function focusedWindow() {
    const window = global.display.focus_window;
    if (!window)
        return null;
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return {
        appId: app?.get_id() ?? window.get_sandboxed_app_id() ?? window.get_gtk_application_id(),
        wmClass: window.get_wm_class(),
        title: window.get_title(),
        app,
    };
}
