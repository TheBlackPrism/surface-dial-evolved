// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// Surface Dial Evolved: the Microsoft Surface Dial on GNOME Shell.
//
// Press and hold the dial to open a ring of actions for the focused
// application, turn to choose and click to run. With the ring closed,
// turning applies the application's current rotate mode (scroll, zoom,
// volume, …), pressing while turning switches between its modes, and a
// click runs its click action. Profiles live in profiles/default.json and
// can be overridden in ~/.config/surface-dial-evolved/profiles.json.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ActionRunner} from './lib/actions.js';
import {focusedWindow} from './lib/context.js';
import {DialDevice} from './lib/device.js';
import {GestureRecognizer} from './lib/gestures.js';
import {Haptics, stepWaveform} from './lib/haptics.js';
import {completeProfile, mergeProfiles, resolveProfile} from './lib/profiles.js';
import {ModeToast, Ring} from './lib/ring.js';

// Raw REL_DIAL units in a full turn when the dial's resolution is untouched.
const NATIVE_UNITS_PER_TURN = 3600;

const USER_PROFILES = GLib.build_filenamev(
    [GLib.get_user_config_dir(), 'surface-dial-evolved', 'profiles.json']);

/**
 * @param {Gio.File} file JSON file with a `profiles` array
 * @returns {object[]} the profiles
 */
function loadProfiles(file) {
    const [, contents] = file.load_contents(null);
    const profiles = JSON.parse(new TextDecoder().decode(contents)).profiles;
    if (!Array.isArray(profiles))
        throw new Error('"profiles" must be an array');
    return profiles;
}

const mainLoopTimer = {
    start: (ms, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    }),
    cancel: id => GLib.source_remove(id),
};

export default class SurfaceDialExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._iconDir = this.dir.get_child('icons').get_path();
        this._ring = null;
        this._ringTimeoutId = 0;
        this._toast = null;
        this._modeIndex = new Map();
        this._queue = Promise.resolve();

        this._loadProfiles();
        this._profilesMonitor = Gio.File.new_for_path(USER_PROFILES)
            .monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._profilesMonitor.connect('changed', (_monitor, _file, _other, event) => {
            if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                event === Gio.FileMonitorEvent.CREATED || event === Gio.FileMonitorEvent.DELETED)
                this._loadProfiles();
        });

        this._runner = new ActionRunner({
            log: msg => this._debug(msg),
            setMode: id => this._switchModeTo(id),
        });
        this._haptics = new Haptics(
            this.dir.get_child('helpers').get_child('dial-haptics.py').get_path(),
            msg => console.warn(`[surface-dial] ${msg}`));

        this._gestures = new GestureRecognizer({
            timer: mainLoopTimer,
            holdTime: this._settings.get_uint('hold-time'),
            unitsPerStep: NATIVE_UNITS_PER_TURN / this._settings.get_uint('steps-per-turn'),
            handlers: {
                click: () => this._onClick(),
                hold: () => this._onHold(),
                rotate: (steps, pressed) => this._onRotate(steps, pressed),
            },
        });

        this._device = new DialDevice({
            connected: info => {
                this._haptics.setDevice(info.hidrawPath);
                this._configureDial();
            },
            disconnected: () => {
                this._haptics.setDevice(null);
                this._gestures.reset();
                this._closeRing();
            },
            input: input => {
                this._debug(`input ${JSON.stringify(input)}`);
                if (input.kind === 'rotate')
                    this._gestures.rotate(input.delta);
                else
                    this._gestures.button(input.pressed);
            },
            log: msg => console.log(`[surface-dial] ${msg}`),
        });

        this._settings.connectObject(
            'changed::hold-time', () => {
                this._gestures.holdTime = this._settings.get_uint('hold-time');
            },
            'changed::steps-per-turn', () => this._configureDial(),
            'changed::haptics', () => this._configureDial(),
            'changed::haptic-strength', () => this._configureDial(),
            this);
        global.display.connectObject('notify::focus-window', () => this._closeRing(), this);

        this._device.start();

        this._devTools = null;
        if (GLib.getenv('SURFACE_DIAL_DEV')) {
            import('./lib/devtools.js').then(({exportDevTools}) => {
                if (this._device)
                    this._devTools = exportDevTools(this);
            });
        }
    }

    disable() {
        this._devTools?.unexport();
        this._devTools = null;
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._device.stop();
        this._device = null;
        this._gestures.reset();
        this._gestures = null;
        this._profilesMonitor.cancel();
        this._profilesMonitor = null;
        this._closeRing();
        this._toast?.destroy();
        this._toast = null;
        this._runner.destroy();
        this._runner = null;
        this._haptics = null;
        this._settings = null;
    }

    _debug(msg) {
        if (this._settings?.get_boolean('debug'))
            console.log(`[surface-dial] ${msg}`);
    }

    _loadProfiles() {
        const builtin = loadProfiles(this.dir.get_child('profiles').get_child('default.json'));
        let user = [];
        try {
            user = loadProfiles(Gio.File.new_for_path(USER_PROFILES));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`[surface-dial] Ignoring ${USER_PROFILES}: ${e.message}`);
        }
        this._profiles = mergeProfiles(builtin, user);
    }

    _stepWaveform() {
        return stepWaveform(this._settings.get_boolean('haptics'),
            this._settings.get_string('haptic-strength'));
    }

    // Sets the dial's resolution to the configured steps per turn, so that
    // every REL_DIAL unit is one step and the haptic feedback lines up with
    // steps. Without haptics access the native resolution is divided instead.
    async _configureDial() {
        const steps = this._settings.get_uint('steps-per-turn');
        const configured = await this._haptics.configure(steps, this._stepWaveform());
        if (this._gestures)
            this._gestures.unitsPerStep = configured ? 1 : NATIVE_UNITS_PER_TURN / steps;
    }

    _currentProfile() {
        return resolveProfile(this._profiles, focusedWindow());
    }

    _currentMode(profile) {
        const index = this._modeIndex.get(profile.id) ?? 0;
        return profile.modes[index % Math.max(profile.modes.length, 1)] ?? null;
    }

    // Actions run one after the other, in the order the dial produced them.
    _enqueue(job) {
        this._queue = this._queue.then(job).catch(e => console.warn(`[surface-dial] ${e.message}`));
    }

    /**
     * @param {string|null} profileId profile to show instead of the focused window's (development only)
     */
    _onHold(profileId = null) {
        if (this._ring) {
            this._closeRing();
            return;
        }
        const window = focusedWindow();
        const forced = profileId && this._profiles.find(p => p.id === profileId);
        const profile = forced
            ? completeProfile(forced, this._profiles)
            : resolveProfile(this._profiles, window);
        this._ring = new Ring({
            profile,
            appIcon: window?.app?.get_icon() ?? null,
            modeLabel: this._currentMode(profile)?.label ?? '',
            size: this._settings.get_uint('ring-size'),
            iconDir: this._iconDir,
        });
        this._ring.connect('destroy', ring => {
            if (this._ring === ring)
                this._ring = null;
        });
        this._ring.open();
        const waveform = this._stepWaveform();
        if (waveform)
            this._haptics.buzz(waveform);
        this._restartRingTimeout();
    }

    _onClick() {
        if (this._ring) {
            const item = this._ring.selectedItem;
            this._closeRing(true);
            if (item)
                this._enqueue(() => this._runner.run(item.action));
            return;
        }
        const profile = this._currentProfile();
        if (profile.click)
            this._enqueue(() => this._runner.run(profile.click));
    }

    _onRotate(steps, pressed) {
        if (this._ring) {
            this._ring.move(steps);
            this._restartRingTimeout();
            return;
        }
        const profile = this._currentProfile();
        if (pressed) {
            this._switchMode(profile, steps);
            return;
        }
        const mode = this._currentMode(profile);
        if (mode)
            this._enqueue(() => this._runner.rotate(mode, steps));
    }

    _switchMode(profile, steps) {
        const count = profile.modes.length;
        if (count < 2)
            return;
        const index = ((this._modeIndex.get(profile.id) ?? 0) + Math.sign(steps)) % count;
        this._modeIndex.set(profile.id, (index + count) % count);
        this._showToast(profile);
    }

    _switchModeTo(id) {
        const profile = this._currentProfile();
        const index = profile.modes.findIndex(m => m.id === id);
        if (index < 0)
            throw new Error(`Profile ${profile.id} has no mode "${id}"`);
        this._modeIndex.set(profile.id, index);
        this._showToast(profile);
    }

    _showToast(profile) {
        this._toast?.destroy();
        this._toast = new ModeToast({
            modes: profile.modes,
            index: this._modeIndex.get(profile.id) ?? 0,
            iconDir: this._iconDir,
        });
        this._toast.connect('destroy', toast => {
            if (this._toast === toast)
                this._toast = null;
        });
        this._toast.show();
    }

    _restartRingTimeout() {
        if (this._ringTimeoutId)
            GLib.source_remove(this._ringTimeoutId);
        this._ringTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._settings.get_uint('ring-timeout'), () => {
                this._ringTimeoutId = 0;
                this._closeRing();
                return GLib.SOURCE_REMOVE;
            });
    }

    _closeRing(executed = false) {
        if (this._ringTimeoutId) {
            GLib.source_remove(this._ringTimeoutId);
            this._ringTimeoutId = 0;
        }
        const ring = this._ring;
        this._ring = null;
        ring?.close(executed);
    }
}
