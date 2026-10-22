// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// Finds the Surface Dial, follows it across Bluetooth reconnects and reads
// its evdev node. libinput (and with it GNOME) ignores the dial's rotation
// node, so nothing else consumes these events and no grab is needed.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GUdev from 'gi://GUdev';

import {EVENT_SIZE, decodeEvents, dialInput} from './evdev.js';

const INPUT_NAME = 'Surface Dial System Multi Axis';

// The uaccess ACL can land a moment after the uevent; retry opening briefly.
const OPEN_RETRIES = 5;
const OPEN_RETRY_MS = 200;

/**
 * Finds the dial's evdev node and the hidraw node of the same HID device.
 *
 * @param {GUdev.Client} client udev client
 * @returns {{eventPath: string, hidrawPath: string|null}|null} device files, or null if not connected
 */
function findDial(client) {
    for (const device of client.query_by_subsystem('input')) {
        if (!device.get_name()?.startsWith('event'))
            continue;
        const input = device.get_parent();
        if (input?.get_sysfs_attr('name') !== INPUT_NAME)
            continue;

        const hid = input.get_parent()?.get_sysfs_path();
        const hidraw = client.query_by_subsystem('hidraw')
            .find(d => d.get_parent()?.get_sysfs_path() === hid);
        return {
            eventPath: device.get_device_file(),
            hidrawPath: hidraw?.get_device_file() ?? null,
        };
    }
    return null;
}

/**
 * The Surface Dial as a stream of rotate and button inputs.
 *
 * Rotation deltas are REL_DIAL values: positive is clockwise.
 */
export class DialDevice {
    /**
     * @param {object} handlers callbacks
     * @param {function({eventPath: string, hidrawPath: string|null}): void} handlers.connected dial appeared
     * @param {function(): void} handlers.disconnected dial went away
     * @param {function(object): void} handlers.input `{kind: 'rotate', delta}` or `{kind: 'button', pressed}`
     * @param {function(string): void} [handlers.log] debug logging
     */
    constructor(handlers) {
        this._handlers = handlers;
        this._client = null;
        this._current = null;
        this._file = null;
        this._stream = null;
        this._cancellable = null;
        this._rest = new Uint8Array(0);
        this._retryId = 0;
    }

    get connected() {
        return this._current !== null;
    }

    get info() {
        return this._current;
    }

    start() {
        this._client = new GUdev.Client({subsystems: ['input', 'hidraw']});
        this._client.connect('uevent', (_client, action) => {
            if (action === 'add' || action === 'remove' || action === 'change')
                this._rescan();
        });
        this._rescan();
    }

    stop() {
        this._client = null;
        this._close();
    }

    _rescan() {
        const found = findDial(this._client);
        if (found?.eventPath === this._current?.eventPath &&
            found?.hidrawPath === this._current?.hidrawPath)
            return;

        this._close();
        if (found)
            this._open(found, OPEN_RETRIES);
    }

    _open(found, retries) {
        try {
            this._file = Gio.File.new_for_path(found.eventPath).read(null);
        } catch (e) {
            if (retries > 0 && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED)) {
                this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OPEN_RETRY_MS, () => {
                    this._retryId = 0;
                    this._open(found, retries - 1);
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._handlers.log?.(`Cannot open ${found.eventPath}: ${e.message}. ` +
                    'Is the udev rule installed (make install-udev)?');
            }
            return;
        }

        // A GUnixInputStream on the same fd is pollable, so reads wait in the
        // main loop instead of blocking a worker thread that a cancel cannot
        // interrupt.
        this._stream = new GioUnix.InputStream({fd: this._file.get_fd(), close_fd: false});
        this._cancellable = new Gio.Cancellable();
        this._rest = new Uint8Array(0);
        this._current = found;
        this._handlers.log?.(`Dial connected: ${found.eventPath}, ${found.hidrawPath}`);
        this._handlers.connected(found);
        this._read();
    }

    _read() {
        const cancellable = this._cancellable;
        this._stream.read_bytes_async(EVENT_SIZE * 32, GLib.PRIORITY_DEFAULT, cancellable,
            (stream, result) => {
                let bytes;
                try {
                    bytes = stream.read_bytes_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        // ENODEV once the dial disconnects; udev reports the removal.
                        this._handlers.log?.(`Reading the dial failed: ${e.message}`);
                    }
                    return;
                }
                if (cancellable.is_cancelled())
                    return;
                if (bytes.get_size() === 0) {
                    this._close();
                    return;
                }
                this._dispatch(bytes.toArray());
                this._read();
            });
    }

    _dispatch(chunk) {
        const data = new Uint8Array(this._rest.length + chunk.length);
        data.set(this._rest);
        data.set(chunk, this._rest.length);
        const {events, rest} = decodeEvents(data);
        this._rest = rest;

        for (const event of events) {
            const input = dialInput(event);
            if (input)
                this._handlers.input(input);
        }
    }

    _close() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._stream = null;
        try {
            this._file?.close(null);
        } catch {
            // Already gone with the device.
        }
        this._file = null;

        if (this._current) {
            this._current = null;
            this._handlers.disconnected();
        }
    }
}
