// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// Unit tests of the GI-free extension modules. Run with `make test`.

import Gio from 'gi://Gio';
import System from 'system';

import {EVENT_SIZE, decodeEvents, dialInput, EV_KEY, EV_REL, EV_SYN, BTN_0, REL_DIAL} from '../extension/lib/evdev.js';
import {GestureRecognizer} from '../extension/lib/gestures.js';
import {mergeProfiles, parseKeyCombo, profileMatches, resolveProfile} from '../extension/lib/profiles.js';

const tests = [];
const test = (name, fn) => tests.push({name, fn});

function assertEqual(actual, expected, what = '') {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${what} expected ${e}, got ${a}`);
}

function encode(events) {
    const bytes = new Uint8Array(events.length * EVENT_SIZE);
    const view = new DataView(bytes.buffer);
    events.forEach(([type, code, value], i) => {
        view.setUint16(i * EVENT_SIZE + 16, type, true);
        view.setUint16(i * EVENT_SIZE + 18, code, true);
        view.setInt32(i * EVENT_SIZE + 20, value, true);
    });
    return bytes;
}

// A timer whose time only moves when the test says so.
class FakeTimer {
    constructor() {
        this.now = 0;
        this._pending = new Map();
        this._next = 1;
    }

    start(ms, callback) {
        const id = this._next++;
        this._pending.set(id, {at: this.now + ms, callback});
        return id;
    }

    cancel(id) {
        this._pending.delete(id);
    }

    advance(ms) {
        this.now += ms;
        for (const [id, {at, callback}] of [...this._pending]) {
            if (at <= this.now) {
                this._pending.delete(id);
                callback();
            }
        }
    }
}

function recognizer(unitsPerStep = 1) {
    const timer = new FakeTimer();
    const log = [];
    const g = new GestureRecognizer({
        timer, holdTime: 500, unitsPerStep,
        handlers: {
            click: () => log.push('click'),
            hold: () => log.push('hold'),
            rotate: (steps, pressed) => log.push(`rotate ${steps}${pressed ? ' pressed' : ''}`),
        },
    });
    return {g, timer, log};
}

test('decodes events and keeps a partial tail', () => {
    const bytes = encode([[EV_REL, REL_DIAL, -3], [EV_KEY, BTN_0, 1], [EV_SYN, 0, 0]]);
    const {events, rest} = decodeEvents(bytes.slice(0, EVENT_SIZE * 2 + 5));
    assertEqual(events.map(e => [e.type, e.code, e.value]), [[EV_REL, REL_DIAL, -3], [EV_KEY, BTN_0, 1]]);
    assertEqual(rest.length, 5);
});

test('maps dial events to inputs', () => {
    assertEqual(dialInput({type: EV_REL, code: REL_DIAL, value: -1}), {kind: 'rotate', delta: -1});
    assertEqual(dialInput({type: EV_KEY, code: BTN_0, value: 1}), {kind: 'button', pressed: true});
    assertEqual(dialInput({type: EV_KEY, code: BTN_0, value: 2}), null, 'autorepeat');
    assertEqual(dialInput({type: EV_SYN, code: 0, value: 0}), null);
});

test('short press is a click', () => {
    const {g, timer, log} = recognizer();
    g.button(true);
    timer.advance(300);
    g.button(false);
    timer.advance(1000);
    assertEqual(log, ['click']);
});

test('long press is a hold without click on release', () => {
    const {g, timer, log} = recognizer();
    g.button(true);
    timer.advance(500);
    g.button(false);
    assertEqual(log, ['hold']);
});

test('rotating while pressed cancels the hold', () => {
    const {g, timer, log} = recognizer();
    g.button(true);
    timer.advance(100);
    g.rotate(1);
    timer.advance(1000);
    g.button(false);
    assertEqual(log, ['rotate 1 pressed']);
});

test('rotation accumulates units into steps and resets on direction change', () => {
    const {g, log} = recognizer(100);
    g.rotate(60);
    g.rotate(60);
    g.rotate(90);
    g.rotate(-50);
    g.rotate(-60);
    assertEqual(log, ['rotate 1', 'rotate 1', 'rotate -1']);
});

const builtin = JSON.parse(new TextDecoder().decode(
    Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path('../extension/profiles/default.json')
        .load_contents(null)[1])).profiles;

test('built-in profiles are well-formed', () => {
    const ids = new Set();
    for (const p of builtin) {
        if (ids.has(p.id))
            throw new Error(`duplicate profile ${p.id}`);
        ids.add(p.id);
        for (const item of p.ring ?? []) {
            if (!item.label || !item.icon || !item.action?.type)
                throw new Error(`bad ring item in ${p.id}: ${JSON.stringify(item)}`);
        }
        for (const mode of p.modes ?? []) {
            if (!mode.id || !(mode.rotate || (mode.cw && mode.ccw)))
                throw new Error(`bad mode in ${p.id}: ${JSON.stringify(mode)}`);
        }
        const walk = a => a && (a.type === 'keys' ? parseKeyCombo(a.keys)
            : a.type === 'sequence' ? a.actions.forEach(walk) : walk(a.fallback));
        p.ring?.forEach(i => walk(i.action));
        p.modes?.forEach(m => [m.rotate, m.cw, m.ccw].forEach(walk));
        walk(p.click);
    }
});

test('matches profiles by desktop id and wm class', () => {
    const win = (appId, wmClass) => ({appId, wmClass, title: ''});
    assertEqual(resolveProfile(builtin, win('intellij-idea_intellij-idea.desktop', null)).id, 'intellij');
    assertEqual(resolveProfile(builtin, win(null, 'jetbrains-idea')).id, 'intellij');
    assertEqual(resolveProfile(builtin, win('sourcegit.desktop', 'SourceGit')).id, 'sourcegit');
    assertEqual(resolveProfile(builtin, win('libreoffice-calc.desktop', null)).id, 'libreoffice');
    assertEqual(resolveProfile(builtin, win('org.gnome.Calculator.desktop', 'gnome-calculator')).id, 'default');
    assertEqual(resolveProfile(builtin, null).id, 'default');
    assertEqual(profileMatches({match: {wmClass: '('}}, win(null, 'x')), false, 'invalid regex');
});

test('user profiles override and extend built-in ones', () => {
    const merged = mergeProfiles(builtin, [
        {id: 'firefox', click: {type: 'keys', keys: 'F5'}},
        {id: 'calc', name: 'Calculator', match: {appIds: ['org.gnome.Calculator']}},
        {id: 'gimp', disabled: true},
    ]);
    assertEqual(merged[0].id, 'calc');
    assertEqual(merged.find(p => p.id === 'firefox').click.keys, 'F5');
    assertEqual(merged.find(p => p.id === 'firefox').ring.length > 0, true, 'kept ring');
    assertEqual(merged.some(p => p.id === 'gimp'), false, 'disabled');
    const calc = resolveProfile(merged, {appId: 'org.gnome.Calculator', wmClass: null, title: null});
    assertEqual(calc.ring, builtin.find(p => p.id === 'default').ring, 'ring from default');
});

test('parses key combinations', () => {
    assertEqual(parseKeyCombo('ctrl+shift+Down'), {modifiers: ['Control_L', 'Shift_L'], key: 'Down'});
    assertEqual(parseKeyCombo('F5'), {modifiers: [], key: 'F5'});
    let threw = false;
    try {
        parseKeyCombo('hyper+x');
    } catch {
        threw = true;
    }
    assertEqual(threw, true, 'unknown modifier');
});

let failed = 0;
for (const {name, fn} of tests) {
    try {
        fn();
        print(`ok   ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
print(`${tests.length - failed}/${tests.length} passed`);
System.exit(failed ? 1 : 0);
