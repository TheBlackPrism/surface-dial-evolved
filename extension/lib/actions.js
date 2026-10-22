// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// Executes the actions of profiles. Every action is a plain object with a
// `type`; see profiles/default.json for examples. An action may carry a
// `fallback` action that runs when it fails (e.g. a player without MPRIS).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {parseKeyCombo} from './profiles.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const INTELLIJ_PORTS = Array.from({length: 20}, (_, i) => 63342 + i);
const INTELLIJ_TOKEN = GLib.build_filenamev(
    [GLib.get_user_config_dir(), 'surface-dial-evolved', 'intellij-token']);

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';

// Fraction of the normal maximum volume per dial step.
const VOLUME_STEP = 0.02;

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

/**
 * @param {string} name keysym name such as `Down` or a single character
 * @returns {number} keyval
 */
function keyval(name) {
    const value = Clutter[`KEY_${name}`];
    if (value !== undefined)
        return value;
    if ([...name].length === 1)
        return Clutter.unicode_to_keysym(name.codePointAt(0));
    throw new Error(`Unknown key "${name}"`);
}

/** Talks to the companion plugin in IntelliJ IDEA (see intellij-plugin/). */
class IntelliJClient {
    constructor() {
        this._session = new Soup.Session({timeout: 15});
        this._port = null;
    }

    async runAction(id) {
        if (this._port !== null) {
            const status = await this._get(this._port, `action?id=${encodeURIComponent(id)}`);
            if (status !== null)
                return this._check(status, id);
            this._port = null;
        }
        this._port = await this._discover();
        if (this._port === null)
            throw new Error('IntelliJ with the Surface Dial Bridge plugin is not running');
        return this._check(await this._get(this._port, `action?id=${encodeURIComponent(id)}`), id);
    }

    destroy() {
        this._session.abort();
    }

    _check(status, id) {
        if (status === 200)
            return true;
        throw new Error(`IntelliJ action ${id} failed with HTTP ${status}`);
    }

    async _discover() {
        for (const port of INTELLIJ_PORTS) {
            const status = await this._get(port, 'ping');
            if (status === 200)
                return port;
            // The plugin creates the token on the first request it sees.
            if (status === 401 && await this._get(port, 'ping') === 200)
                return port;
        }
        return null;
    }

    /**
     * @returns {Promise<number|null>} HTTP status, null if nothing answered
     */
    async _get(port, path) {
        const message = Soup.Message.new('GET', `http://127.0.0.1:${port}/api/dial/${path}`);
        const token = this._token();
        if (token)
            message.get_request_headers().append('X-Dial-Token', token);
        try {
            await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
            return message.get_status();
        } catch {
            return null;
        }
    }

    _token() {
        try {
            const [, contents] = GLib.file_get_contents(INTELLIJ_TOKEN);
            return new TextDecoder().decode(contents).trim();
        } catch {
            return null;
        }
    }
}

/** MPRIS media players on the session bus. */
class Mpris {
    async _call(name, iface, method, params = null, replyType = null) {
        return Gio.DBus.session.call(name, MPRIS_PATH, iface, method, params, replyType,
            Gio.DBusCallFlags.NONE, 2000, null);
    }

    async _get(name, property) {
        const reply = await this._call(name, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER, property]), new GLib.VariantType('(v)'));
        return reply.recursiveUnpack()[0];
    }

    _set(name, property, value) {
        return this._call(name, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [MPRIS_PLAYER, property, value]));
    }

    /**
     * @param {string|undefined} hint part of the bus name, e.g. `spotify`
     * @returns {Promise<string>} bus name of the player to control
     */
    async player(hint) {
        const reply = await Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, 2000, null);
        const players = reply.deepUnpack()[0].filter(n => n.startsWith(MPRIS_PREFIX));
        if (hint) {
            const match = players.find(n => n.toLowerCase().includes(hint.toLowerCase()));
            if (!match)
                throw new Error(`No MPRIS player "${hint}"`);
            return match;
        }
        for (const name of players) {
            // eslint-disable-next-line no-await-in-loop
            if (await this._get(name, 'PlaybackStatus').catch(() => null) === 'Playing')
                return name;
        }
        if (!players.length)
            throw new Error('No MPRIS player');
        return players[0];
    }

    async run(action) {
        const name = await this.player(action.player);
        switch (action.method) {
        case 'Seek':
            return this._call(name, MPRIS_PLAYER, 'Seek',
                new GLib.Variant('(x)', [Math.round(action.seconds * 1e6)]));
        case 'ToggleShuffle':
            return this._set(name, 'Shuffle',
                GLib.Variant.new_boolean(!await this._get(name, 'Shuffle')));
        default:
            return this._call(name, MPRIS_PLAYER, action.method);
        }
    }

    async changeVolume(hint, steps) {
        const name = await this.player(hint);
        const volume = Math.clamp(await this._get(name, 'Volume') + steps * VOLUME_STEP, 0, 1);
        await this._set(name, 'Volume', GLib.Variant.new_double(volume));
        Main.osdWindowManager.showAll(
            new Gio.ThemedIcon({name: 'multimedia-volume-control-symbolic'}), null, volume, 1);
    }

    async seek(hint, steps, seconds) {
        const name = await this.player(hint);
        await this._call(name, MPRIS_PLAYER, 'Seek',
            new GLib.Variant('(x)', [Math.round(steps * seconds * 1e6)]));
    }
}

/** Runs actions; one instance lives as long as the extension is enabled. */
export class ActionRunner {
    /**
     * @param {object} params parameters
     * @param {function(string): void} params.log debug logging
     * @param {function(string): void} params.setMode switches the rotate mode of the current profile
     * @param {function(): void} params.openPreferences opens the preferences of this extension
     */
    constructor({log, setMode, openPreferences}) {
        this._log = log;
        this._setMode = setMode;
        this._openPreferences = openPreferences;

        const seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._intellij = new IntelliJClient();
        this._mpris = new Mpris();
    }

    destroy() {
        this._intellij.destroy();
        this._keyboard = null;
        this._pointer = null;
    }

    /**
     * Runs an action, and its fallback if it fails.
     *
     * @param {object} action action
     * @returns {Promise<boolean>} whether the action (or its fallback) succeeded
     */
    async run(action) {
        try {
            await this._run(action);
            this._log(`Ran ${JSON.stringify(action)}`);
            return true;
        } catch (e) {
            this._log(`Action ${JSON.stringify(action)} failed: ${e.message}`);
            if (action.fallback)
                return this.run(action.fallback);
            return false;
        }
    }

    /**
     * Applies rotation in a rotate mode.
     *
     * @param {object} mode mode with either `rotate` or `cw` and `ccw`
     * @param {number} steps steps, positive is clockwise
     */
    async rotate(mode, steps) {
        if (mode.rotate) {
            try {
                await this._rotate(mode.rotate, steps);
            } catch (e) {
                this._log(`Rotate ${JSON.stringify(mode.rotate)} failed: ${e.message}`);
            }
            return;
        }
        const action = steps > 0 ? mode.cw : mode.ccw;
        for (let i = 0; i < Math.abs(steps); i++) {
            // eslint-disable-next-line no-await-in-loop
            await this.run(action);
        }
    }

    async _run(action) {
        switch (action.type) {
        case 'keys':
            this._keys(action.keys);
            break;
        case 'text':
            this._text(action.text);
            break;
        case 'delay':
            await sleep(action.ms);
            break;
        case 'sequence':
            for (const step of action.actions) {
                // eslint-disable-next-line no-await-in-loop
                if (!await this.run(step))
                    throw new Error('Sequence step failed');
            }
            break;
        case 'intellij':
            await this._intellij.runAction(action.id);
            break;
        case 'mpris':
            await this._mpris.run(action);
            break;
        case 'mute':
            this._mute();
            break;
        case 'shell':
            await this._shell(action.call);
            break;
        case 'command':
            Gio.Subprocess.new(action.argv, Gio.SubprocessFlags.NONE);
            break;
        case 'mode':
            this._setMode(action.mode);
            break;
        default:
            throw new Error(`Unknown action type "${action.type}"`);
        }
    }

    async _rotate(rotary, steps) {
        switch (rotary.type) {
        case 'scroll':
            this._scroll(steps, rotary.modifiers);
            break;
        case 'volume':
            this._changeVolume(steps);
            break;
        case 'mpris-volume':
            await this._mpris.changeVolume(rotary.player, steps);
            break;
        case 'mpris-seek':
            await this._mpris.seek(rotary.player, steps, rotary.seconds ?? 5);
            break;
        default:
            throw new Error(`Unknown rotate type "${rotary.type}"`);
        }
    }

    _key(value, pressed) {
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), value,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
    }

    _keys(combo) {
        const {modifiers, key} = parseKeyCombo(combo);
        const mods = modifiers.map(keyval);
        const value = keyval(key);
        mods.forEach(m => this._key(m, true));
        this._key(value, true);
        this._key(value, false);
        mods.reverse().forEach(m => this._key(m, false));
    }

    _text(text) {
        for (const char of text) {
            const value = Clutter.unicode_to_keysym(char.codePointAt(0));
            this._key(value, true);
            this._key(value, false);
        }
    }

    _scroll(steps, modifiers) {
        const mods = modifiers ? parseKeyCombo(`${modifiers}+x`).modifiers.map(keyval) : [];
        mods.forEach(m => this._key(m, true));
        const direction = steps > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP;
        for (let i = 0; i < Math.abs(steps); i++) {
            this._pointer.notify_discrete_scroll(GLib.get_monotonic_time(), direction,
                Clutter.ScrollSource.WHEEL);
        }
        mods.reverse().forEach(m => this._key(m, false));
    }

    _sink() {
        const sink = getMixerControl().get_default_sink();
        if (!sink)
            throw new Error('No audio output');
        return sink;
    }

    _showVolume(sink) {
        const control = getMixerControl();
        const level = sink.is_muted ? 0 : sink.volume / control.get_vol_max_norm();
        const icon = sink.is_muted || level <= 0 ? 'audio-volume-muted-symbolic'
            : level < 1 / 3 ? 'audio-volume-low-symbolic'
                : level < 2 / 3 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
        Main.osdWindowManager.showAll(new Gio.ThemedIcon({name: icon}), null, level, 1);
    }

    _changeVolume(steps) {
        const sink = this._sink();
        const max = getMixerControl().get_vol_max_norm();
        sink.volume = Math.clamp(sink.volume + steps * VOLUME_STEP * max, 0, max);
        if (sink.is_muted && steps > 0)
            sink.change_is_muted(false);
        sink.push_volume();
        this._showVolume(sink);
    }

    _mute() {
        const sink = this._sink();
        sink.change_is_muted(!sink.is_muted);
        this._showVolume(sink);
    }

    async _shell(call) {
        switch (call) {
        case 'screenshot':
            await Main.screenshotUI.open();
            break;
        case 'overview':
            Main.overview.toggle();
            break;
        case 'preferences':
            this._openPreferences();
            break;
        case 'night-light': {
            const settings = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
            settings.set_boolean('night-light-enabled', !settings.get_boolean('night-light-enabled'));
            break;
        }
        case 'dark-style': {
            const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const dark = settings.get_string('color-scheme') === 'prefer-dark';
            settings.set_string('color-scheme', dark ? 'default' : 'prefer-dark');
            break;
        }
        default:
            throw new Error(`Unknown shell call "${call}"`);
        }
    }
}
