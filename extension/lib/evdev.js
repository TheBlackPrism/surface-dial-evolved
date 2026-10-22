// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// Decoding of the Linux evdev wire format. Pure JavaScript without GI
// imports, so the unit tests can run it outside of GNOME Shell.

// struct input_event on 64-bit Linux: struct timeval (2 × 8 bytes),
// __u16 type, __u16 code, __s32 value.
export const EVENT_SIZE = 24;

export const EV_SYN = 0x00;
export const EV_KEY = 0x01;
export const EV_REL = 0x02;

export const SYN_REPORT = 0x00;
export const SYN_DROPPED = 0x03;
export const REL_DIAL = 0x07;
export const BTN_0 = 0x100;

/**
 * Splits a chunk read from an evdev node into events.
 *
 * Reads from an evdev node always return whole events, but the reader may
 * hand over any byte array, so a trailing partial event is returned as
 * `rest` for the caller to prepend to the next chunk.
 *
 * @param {Uint8Array} bytes raw bytes
 * @returns {{events: {type: number, code: number, value: number}[], rest: Uint8Array}}
 *   the decoded events and the unconsumed tail
 */
export function decodeEvents(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = Math.floor(bytes.byteLength / EVENT_SIZE);
    const events = [];
    for (let i = 0; i < count; i++) {
        const offset = i * EVENT_SIZE;
        events.push({
            type: view.getUint16(offset + 16, true),
            code: view.getUint16(offset + 18, true),
            value: view.getInt32(offset + 20, true),
        });
    }
    return {events, rest: bytes.slice(count * EVENT_SIZE)};
}

/**
 * Turns evdev events of the dial into the two things the dial can do.
 *
 * @param {{type: number, code: number, value: number}} event an evdev event
 * @returns {{kind: 'rotate', delta: number}|{kind: 'button', pressed: boolean}|null}
 *   the dial input, or null for events that carry none (SYN, ABS_MISC, …)
 */
export function dialInput(event) {
    if (event.type === EV_REL && event.code === REL_DIAL)
        return {kind: 'rotate', delta: event.value};
    if (event.type === EV_KEY && event.code === BTN_0 && event.value !== 2)
        return {kind: 'button', pressed: event.value === 1};
    return null;
}
