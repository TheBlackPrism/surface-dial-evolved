// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// Preferences of Surface Dial Evolved. Runs in a separate GTK 4 /
// libadwaita process, not inside GNOME Shell.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GUdev from 'gi://GUdev';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'surface-dial-evolved']);
const USER_PROFILES = GLib.build_filenamev([CONFIG_DIR, 'profiles.json']);
const INTELLIJ_TOKEN = GLib.build_filenamev([CONFIG_DIR, 'intellij-token']);

// Written when the user first opens their profiles file.
const PROFILES_TEMPLATE = `{
  "profiles": [
    {
      "id": "example",
      "name": "Calculator",
      "disabled": true,
      "match": {"appIds": ["org.gnome.Calculator"]},
      "ring": [
        {"label": "Clear", "icon": "edit-clear-all-symbolic", "action": {"type": "keys", "keys": "Escape"}}
      ]
    }
  ]
}
`;

/**
 * @returns {string} human readable state of the dial and its permissions
 */
function dialStatus() {
    const client = new GUdev.Client({subsystems: ['input']});
    const node = client.query_by_subsystem('input').find(d =>
        d.get_name()?.startsWith('event') &&
        d.get_parent()?.get_sysfs_attr('name') === 'Surface Dial System Multi Axis');
    if (!node)
        return 'Not connected. Turn the dial to wake it up.';
    const path = node.get_device_file();
    const readable = GLib.access(path, 4 /* R_OK */) === 0;
    return readable
        ? `Connected (${path})`
        : `Connected, but ${path} is not readable: run “make install-udev”`;
}

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = Adw.SpinRow.new_with_range(lower, upper, step);
    row.set_title(title);
    row.set_subtitle(subtitle);
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/**
 * A drop-down bound to a string setting with choices.
 *
 * @param {Gio.Settings} settings settings
 * @param {string} key key of the setting
 * @param {string} title title of the row
 * @param {string} subtitle subtitle of the row
 * @param {[string, string][]} choices pairs of setting value and label
 * @returns {Adw.ComboRow} the row
 */
function comboRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(choices.map(([, label]) => label))});
    const sync = () => {
        row.selected = Math.max(0, choices.findIndex(([value]) => value === settings.get_string(key)));
    };
    sync();
    const changedId = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(changedId));
    row.connect('notify::selected', () => {
        const [value] = choices[row.selected] ?? [];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class SurfaceDialPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({icon_name: 'input-dialpad-symbolic'});
        window.add(page);

        const device = new Adw.PreferencesGroup({title: 'Device'});
        const status = new Adw.ActionRow({title: 'Surface Dial', subtitle: dialStatus()});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Check again'});
        refresh.add_css_class('flat');
        refresh.connect('clicked', () => status.set_subtitle(dialStatus()));
        status.add_suffix(refresh);
        device.add(status);
        device.add(switchRow(settings, 'haptics', 'Haptic Feedback', 'Feel every step of the dial'));
        const strength = comboRow(settings, 'haptic-strength', 'Strength',
            'Normal clicks on every step, Strong buzzes',
            [['normal', 'Normal'], ['strong', 'Strong']]);
        settings.bind('haptics', strength, 'sensitive', Gio.SettingsBindFlags.GET);
        device.add(strength);
        device.add(spinRow(settings, 'steps-per-turn', 'Steps per Turn',
            'How many steps one full turn of the dial has', 12, 120, 1));
        page.add(device);

        const ring = new Adw.PreferencesGroup({title: 'Ring'});
        ring.add(comboRow(settings, 'rotate-action', 'Turning the Dial',
            'What turning does while the ring is closed',
            [['mode', 'Scroll, Zoom, Volume …'], ['ring', 'Opens the Ring']]));
        ring.add(spinRow(settings, 'hold-time', 'Hold Time',
            'Milliseconds to hold the dial down to open the ring', 150, 2000, 50));
        ring.add(spinRow(settings, 'ring-size', 'Size', 'Diameter of the ring in pixels', 200, 600, 10));
        ring.add(spinRow(settings, 'ring-timeout', 'Timeout',
            'Milliseconds without input before the ring closes', 1000, 30000, 500));
        page.add(ring);

        const profiles = new Adw.PreferencesGroup({
            title: 'Profiles',
            description: 'Per-application rings and rotate modes. Your own profiles override the built-in ones with the same id; changes apply as soon as the file is saved.',
        });
        const open = new Adw.ActionRow({title: 'Edit Profiles', subtitle: USER_PROFILES, activatable: true});
        open.add_suffix(new Gtk.Image({icon_name: 'document-edit-symbolic'}));
        open.connect('activated', () => {
            const file = Gio.File.new_for_path(USER_PROFILES);
            if (!file.query_exists(null)) {
                GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
                file.replace_contents(new TextEncoder().encode(PROFILES_TEMPLATE), null, false,
                    Gio.FileCreateFlags.NONE, null);
            }
            Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
        });
        profiles.add(open);
        const builtin = new Adw.ActionRow({title: 'Built-in Profiles', activatable: true,
            subtitle: this.dir.get_child('profiles').get_child('default.json').get_path()});
        builtin.add_suffix(new Gtk.Image({icon_name: 'document-open-symbolic'}));
        builtin.connect('activated', () => Gio.AppInfo.launch_default_for_uri(
            this.dir.get_child('profiles').get_child('default.json').get_uri(), null));
        profiles.add(builtin);
        page.add(profiles);

        const intellij = new Adw.PreferencesGroup({title: 'IntelliJ IDEA'});
        intellij.add(new Adw.ActionRow({
            title: 'Surface Dial Bridge Plugin',
            subtitle: GLib.file_test(INTELLIJ_TOKEN, GLib.FileTest.EXISTS)
                ? 'Paired: the plugin has created its access token'
                : 'Not paired yet: install intellij-plugin/build/distributions/*.zip in IntelliJ (Settings → Plugins → Install Plugin from Disk)',
        }));
        page.add(intellij);

        const debug = new Adw.PreferencesGroup({title: 'Troubleshooting'});
        debug.add(switchRow(settings, 'debug', 'Debug Logging',
            'Log dial input and actions to the journal (journalctl --user -f -o cat /usr/bin/gnome-shell)'));
        page.add(debug);
    }
}
