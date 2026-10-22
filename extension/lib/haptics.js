// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// Drives the dial's resolution and haptics through helpers/dial-haptics.py
// (setting a HID feature report needs an ioctl, which GJS cannot do).

import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

/** Runs the haptics helper; calls are queued so they never overlap. */
export class Haptics {
    /**
     * @param {string} helperPath absolute path of dial-haptics.py
     * @param {function(string): void} log debug logging
     */
    constructor(helperPath, log) {
        this._helperPath = helperPath;
        this._log = log;
        this._hidraw = null;
        this._queue = Promise.resolve(true);
    }

    /**
     * @param {string|null} hidrawPath hidraw node of the dial, null when disconnected
     */
    setDevice(hidrawPath) {
        this._hidraw = hidrawPath;
    }

    /**
     * Sets steps per turn and whether each step clicks.
     *
     * @param {number} steps steps per full turn
     * @param {boolean} clicks whether each step produces a haptic click
     * @returns {Promise<boolean>} whether the dial accepted it
     */
    configure(steps, clicks) {
        return this._run(['mode', `${steps}`, clicks ? 'on' : 'off']);
    }

    /**
     * Plays a waveform once.
     *
     * @param {'click'|'buzz'|'rumble'} waveform waveform
     * @returns {Promise<boolean>} whether the dial accepted it
     */
    buzz(waveform = 'click') {
        return this._run(['buzz', waveform]);
    }

    _run(args) {
        const hidraw = this._hidraw;
        this._queue = this._queue.then(async () => {
            if (!hidraw)
                return false;
            try {
                const proc = Gio.Subprocess.new(
                    ['python3', '-I', this._helperPath, hidraw, ...args],
                    Gio.SubprocessFlags.STDERR_PIPE);
                const [, stderr] = await proc.communicate_utf8_async(null, null);
                if (proc.get_successful())
                    return true;
                this._log(`Haptics helper ${args.join(' ')} failed: ${stderr.trim()}`);
            } catch (e) {
                this._log(`Haptics helper ${args.join(' ')} failed: ${e.message}`);
            }
            return false;
        });
        return this._queue;
    }
}
