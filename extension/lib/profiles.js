// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// Profiles describe what the dial does in an application: the items of the
// ring, the rotate modes used while the ring is closed, and the click
// action. Pure JavaScript, shared with the unit tests.
//
// A profile:
//   {
//     "id": "intellij", "name": "IntelliJ IDEA",
//     "match": {"appIds": ["intellij-idea_intellij-idea"], "wmClass": "^jetbrains-idea"},
//     "ring":  [{"label": "Stop", "icon": "media-playback-stop-symbolic", "action": {...}}],
//     "modes": [{"id": "scroll", "label": "Scroll", "icon": "...", "rotate": {...}},
//               {"id": "methods", "label": "Methods", "icon": "...", "cw": {...}, "ccw": {...}}],
//     "click": {...}
//   }
// The profile with id "default" applies to every window no other profile
// matches, and lends its ring, modes or click to profiles that lack them.

export const DEFAULT_PROFILE_ID = 'default';

/**
 * Merges user profiles over the built-in ones. A user profile with the id
 * of a built-in profile overrides the fields it sets; other user profiles
 * are added in front, so that they win when matching. A profile with
 * `"disabled": true` is dropped.
 *
 * @param {object[]} builtin built-in profiles
 * @param {object[]} user user profiles
 * @returns {object[]} profiles in matching order
 */
export function mergeProfiles(builtin, user) {
    const byId = new Map(user.filter(p => p?.id).map(p => [p.id, p]));
    const merged = builtin.map(p => byId.has(p.id) ? {...p, ...byId.get(p.id)} : p);
    const added = user.filter(p => p?.id && !builtin.some(b => b.id === p.id));
    return [...added, ...merged].filter(p => !p.disabled);
}

/**
 * Strips the `.desktop` suffix of a desktop file id.
 *
 * @param {string|null} appId desktop file id
 * @returns {string|null} the bare id
 */
export function bareAppId(appId) {
    return appId?.replace(/\.desktop$/, '') ?? null;
}

/**
 * Whether a profile applies to a window.
 *
 * @param {object} profile profile
 * @param {{appId: string|null, wmClass: string|null, title: string|null}} window the focused window
 * @returns {boolean} whether it matches
 */
export function profileMatches(profile, window) {
    const match = profile.match;
    if (!match)
        return false;

    const appId = bareAppId(window.appId);
    if (appId && match.appIds?.some(id => bareAppId(id) === appId))
        return true;

    const test = (pattern, value) => {
        if (!pattern || !value)
            return false;
        try {
            return new RegExp(pattern, 'i').test(value);
        } catch {
            return false;
        }
    };
    return test(match.wmClass, window.wmClass) || test(match.appId, appId) ||
        test(match.title, window.title);
}

/**
 * Picks the profile for a window.
 *
 * @param {object[]} profiles profiles in matching order
 * @param {{appId: string|null, wmClass: string|null, title: string|null}|null} window
 *   the focused window, null if none
 * @returns {object} the resolved profile (see completeProfile)
 */
export function resolveProfile(profiles, window) {
    const profile = window && profiles.find(p => p.id !== DEFAULT_PROFILE_ID &&
        profileMatches(p, window));
    return completeProfile(profile ?? null, profiles);
}

/**
 * Fills in what a profile leaves out from the default profile.
 *
 * @param {object|null} profile profile, null for the default profile
 * @param {object[]} profiles all profiles
 * @returns {object} the profile with `ring`, `modes` and `click` always set
 */
export function completeProfile(profile, profiles) {
    const fallback = profiles.find(p => p.id === DEFAULT_PROFILE_ID) ??
        {id: DEFAULT_PROFILE_ID, name: 'Desktop'};
    profile ??= fallback;
    return {
        ...profile,
        ring: profile.ring?.length ? profile.ring : fallback.ring ?? [],
        modes: profile.modes?.length ? profile.modes : fallback.modes ?? [],
        click: profile.click ?? fallback.click ?? null,
    };
}

/**
 * Parses a key combination such as `ctrl+shift+Down`.
 *
 * The key is a keysym name (`Down`, `F5`, `t`, `plus`, `bracketleft`, …);
 * modifiers are `ctrl`, `shift`, `alt` and `super`.
 *
 * @param {string} combo key combination
 * @returns {{modifiers: string[], key: string}} modifier keysym names and key
 */
export function parseKeyCombo(combo) {
    const MODIFIERS = {
        ctrl: 'Control_L', control: 'Control_L', shift: 'Shift_L',
        alt: 'Alt_L', super: 'Super_L', meta: 'Super_L',
    };
    const parts = combo.split('+').map(p => p.trim());
    const key = parts.pop();
    if (!key)
        throw new Error(`No key in "${combo}"`);
    const modifiers = parts.map(p => {
        const name = MODIFIERS[p.toLowerCase()];
        if (!name)
            throw new Error(`Unknown modifier "${p}" in "${combo}"`);
        return name;
    });
    return {modifiers, key};
}
