// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// Turns raw button and rotation input of the dial into gestures. Pure
// JavaScript: time is injected through a timer object, so the unit tests
// can drive it without a main loop.

/**
 * @typedef {object} Timer
 * @property {function(number, function(): void): any} start calls back after the given milliseconds
 * @property {function(any): void} cancel cancels a pending callback
 */

/**
 * Gesture recognizer of the dial.
 *
 * - press and release before the hold time: `click`
 * - press and keep pressed for the hold time: `hold` (the release is swallowed)
 * - rotation: `rotate(steps, pressed)` once enough raw units add up to a
 *   step; rotating while pressed cancels a pending hold so that
 *   "press + rotate" can be bound separately
 */
export class GestureRecognizer {
    /**
     * @param {object} params parameters
     * @param {Timer} params.timer timer implementation
     * @param {number} params.holdTime milliseconds until a press becomes a hold
     * @param {number} params.unitsPerStep raw rotation units per step
     * @param {object} params.handlers callbacks `click()`, `hold()`, `rotate(steps, pressed)`
     */
    constructor({timer, holdTime, unitsPerStep, handlers}) {
        this._timer = timer;
        this.holdTime = holdTime;
        this.unitsPerStep = unitsPerStep;
        this._handlers = handlers;

        this._pressed = false;
        this._consumed = false;
        this._holdTimer = null;
        this._accumulated = 0;
    }

    get pressed() {
        return this._pressed;
    }

    /**
     * @param {boolean} pressed new button state
     */
    button(pressed) {
        if (pressed === this._pressed)
            return;
        this._pressed = pressed;

        if (pressed) {
            this._consumed = false;
            this._holdTimer = this._timer.start(this.holdTime, () => {
                this._holdTimer = null;
                this._consumed = true;
                this._handlers.hold?.();
            });
            return;
        }

        this._cancelHold();
        if (!this._consumed)
            this._handlers.click?.();
    }

    /**
     * @param {number} delta raw rotation units, positive is clockwise
     */
    rotate(delta) {
        if (delta === 0)
            return;
        // Turning back must not first eat up what was left over from the
        // other direction.
        if (Math.sign(delta) !== Math.sign(this._accumulated))
            this._accumulated = 0;
        this._accumulated += delta;

        const steps = Math.trunc(this._accumulated / this.unitsPerStep);
        if (steps === 0)
            return;
        this._accumulated -= steps * this.unitsPerStep;

        if (this._pressed) {
            this._cancelHold();
            this._consumed = true;
        }
        this._handlers.rotate?.(steps, this._pressed);
    }

    /** Forgets the current state, e.g. when the device disappears. */
    reset() {
        this._cancelHold();
        this._pressed = false;
        this._consumed = false;
        this._accumulated = 0;
    }

    _cancelHold() {
        if (this._holdTimer === null)
            return;
        this._timer.cancel(this._holdTimer);
        this._holdTimer = null;
    }
}
