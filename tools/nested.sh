#!/usr/bin/env bash
# Runs a nested GNOME Shell (in a window) with only this extension enabled and
# the development D-Bus hooks on (extension/lib/devtools.js). Settings live in
# a throwaway config dir, so the real session's settings stay untouched.
#
# Usage: tools/nested.sh [light|dark]
set -euo pipefail

UUID=surface-dial-evolved@theblackprism.ch
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCHEME=${1:-dark}
NESTED_CONFIG=${NESTED_CONFIG:-${XDG_RUNTIME_DIR:-/tmp}/surface-dial-nested}

mkdir -p "$NESTED_CONFIG/surface-dial-evolved"
# Let the nested extension reach IntelliJ with the real token.
TOKEN=${XDG_CONFIG_HOME:-$HOME/.config}/surface-dial-evolved/intellij-token
[ -f "$TOKEN" ] && cp "$TOKEN" "$NESTED_CONFIG/surface-dial-evolved/"

[ "$SCHEME" = dark ] && COLOR_SCHEME=prefer-dark || COLOR_SCHEME=default

export XDG_CONFIG_HOME=$NESTED_CONFIG SURFACE_DIAL_DEV=1
exec dbus-run-session -- bash -c "
    dconf write /org/gnome/shell/enabled-extensions \"['$UUID']\"
    dconf write /org/gnome/shell/disable-user-extensions false
    dconf write /org/gnome/shell/welcome-dialog-last-shown-version \"'999'\"
    dconf write /org/gnome/desktop/interface/color-scheme \"'$COLOR_SCHEME'\"
    dconf write /org/gnome/shell/extensions/surface-dial-evolved/debug true
    echo \"\$DBUS_SESSION_BUS_ADDRESS\" > \"$NESTED_CONFIG/bus\"
    exec gnome-shell --devkit --wayland
"
