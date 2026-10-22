// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// Development hooks, only loaded when GNOME Shell runs with
// SURFACE_DIAL_DEV=1 (see tools/nested.sh). They simulate the dial and take
// screenshots over D-Bus, e.g.:
//   gdbus call --session --dest org.gnome.Shell \
//     --object-path /ch/theblackprism/SurfaceDial/Dev \
//     --method ch.theblackprism.SurfaceDial.Dev.Hold intellij

import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

const INTERFACE = `
<node>
  <interface name="ch.theblackprism.SurfaceDial.Dev">
    <method name="Hold"><arg type="s" direction="in" name="profileId"/></method>
    <method name="Rotate">
      <arg type="i" direction="in" name="steps"/>
      <arg type="b" direction="in" name="pressed"/>
    </method>
    <method name="Click"/>
    <method name="Screenshot"><arg type="s" direction="in" name="path"/></method>
  </interface>
</node>`;

/**
 * Exports the development interface for a running extension.
 *
 * @param {object} extension the enabled SurfaceDialExtension
 * @returns {Gio.DBusExportedObject} the exported object; call `unexport()` on disable
 */
export function exportDevTools(extension) {
    const impl = {
        Hold: profileId => extension._onHold(profileId || null),
        Rotate: (steps, pressed) => extension._onRotate(steps, pressed),
        Click: () => extension._onClick(),
        ScreenshotAsync([path], invocation) {
            const stream = Gio.File.new_for_path(path)
                .replace(null, false, Gio.FileCreateFlags.NONE, null);
            new Shell.Screenshot().screenshot(false, stream, (shooter, result) => {
                try {
                    shooter.screenshot_finish(result);
                    stream.close(null);
                    invocation.return_value(null);
                } catch (e) {
                    invocation.return_error_literal(Gio.DBusError, Gio.DBusError.FAILED, e.message);
                }
            });
        },
    };
    const exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE, impl);
    exported.export(Gio.DBus.session, '/ch/theblackprism/SurfaceDial/Dev');
    return exported;
}
