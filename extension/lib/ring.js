// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Yves Lütjens

// The radial ring shown while choosing an action, and the small toast that
// announces a rotate mode change. Both are drawn above all windows and never
// take keyboard focus, so key actions still reach the focused application.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const OPEN_TIME = 260;
const CLOSE_TIME = 160;
const SELECT_TIME = 120;
const TOAST_TIME = 1200;

// Proportions of the ring, relative to its outer radius.
const INNER_RADIUS = 0.56;
const ICON_RADIUS = 0.78;
const SHADOW = 0.08;

const PALETTES = {
    dark: {
        bandTop: [0.19, 0.19, 0.21, 0.93], bandBottom: [0.1, 0.1, 0.12, 0.93], bandEdge: [1, 1, 1, 0.1],
        hub: [0.09, 0.09, 0.11, 0.96], separator: [1, 1, 1, 0.07], shadow: [0, 0, 0, 0.35],
    },
    light: {
        bandTop: [1, 1, 1, 0.96], bandBottom: [0.92, 0.92, 0.94, 0.96], bandEdge: [0, 0, 0, 0.1],
        hub: [1, 1, 1, 0.98], separator: [0, 0, 0, 0.07], shadow: [0, 0, 0, 0.2],
    },
};

/**
 * Creates the icon of a ring item: `dial-…` names are bundled with the
 * extension, everything else comes from the icon theme.
 *
 * @param {string} name icon name
 * @param {string} iconDir directory of the bundled icons
 * @returns {Gio.Icon} the icon
 */
export function lookupIcon(name, iconDir) {
    if (name.startsWith('dial-'))
        return Gio.FileIcon.new(Gio.File.new_for_path(GLib.build_filenamev([iconDir, `${name}.svg`])));
    return new Gio.ThemedIcon({name});
}

function isDark() {
    return St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK;
}

function easeOutCubic(t) {
    return 1 - (1 - t) ** 3;
}

function setSource(cr, [r, g, b, a]) {
    cr.setSourceRGBA(r, g, b, a);
}

/** @returns {Mtk.Rectangle} work area (monitor minus panels) under the pointer */
function pointerWorkArea() {
    return Main.layoutManager.getWorkAreaForMonitor(global.display.get_current_monitor());
}

/** Places the actor centered on the pointer, kept inside the work area. */
function placeAtPointer(actor, size) {
    const [x, y] = global.get_pointer();
    const monitor = pointerWorkArea();
    const half = size / 2;
    actor.set_position(
        Math.round(Math.clamp(x, monitor.x + half, monitor.x + monitor.width - half) - half),
        Math.round(Math.clamp(y, monitor.y + half, monitor.y + monitor.height - half) - half));
}

export const Ring = GObject.registerClass(
class Ring extends St.Widget {
    /**
     * @param {object} params parameters
     * @param {object} params.profile resolved profile
     * @param {Gio.Icon|null} params.appIcon icon of the focused application
     * @param {string} params.modeLabel label of the current rotate mode
     * @param {number} params.size diameter in logical pixels
     * @param {string} params.iconDir directory of the bundled icons
     */
    _init({profile, appIcon, modeLabel, size, iconDir}) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._size = size * scale;
        super._init({
            style_class: 'sde-ring',
            width: this._size,
            height: this._size,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            opacity: 0,
            scale_x: 0.6,
            scale_y: 0.6,
        });

        this._items = profile.ring;
        this._selected = 0;
        this._angle = 0;
        this._targetAngle = 0;
        this._timeline = null;
        this._palette = isDark() ? PALETTES.dark : PALETTES.light;
        if (!isDark())
            this.add_style_class_name('sde-light');

        // The accent color is only reachable through CSS (-st-accent-color).
        this._accentProbe = new St.Widget({style_class: 'sde-accent', visible: false});
        this.add_child(this._accentProbe);

        this._canvas = new St.DrawingArea({width: this._size, height: this._size});
        this._canvas.connect('repaint', area => this._repaint(area));
        this.add_child(this._canvas);

        const outer = this._size / 2 * (1 - SHADOW);
        const iconSize = Math.round(Math.min(outer * (1 - INNER_RADIUS) * 0.42,
            Math.PI * outer * ICON_RADIUS / Math.max(this._items.length, 4) * 0.6, 24 * scale) / scale);
        this._icons = this._items.map((item, i) => {
            const icon = new St.Icon({
                gicon: lookupIcon(item.icon, iconDir),
                icon_size: iconSize,
                style_class: 'sde-ring-icon',
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            });
            this.add_child(icon);
            const angle = this._itemAngle(i);
            const radius = outer * ICON_RADIUS;
            const pixels = iconSize * scale;
            icon.set_position(
                Math.round(this._size / 2 + radius * Math.cos(angle) - pixels / 2),
                Math.round(this._size / 2 + radius * Math.sin(angle) - pixels / 2));
            return icon;
        });

        const hubWidth = outer * INNER_RADIUS * 2 * 0.82;
        this._hub = new St.BoxLayout({
            style_class: 'sde-hub',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: hubWidth,
        });
        if (appIcon)
            this._hub.add_child(new St.Icon({gicon: appIcon, style_class: 'sde-hub-app', x_align: Clutter.ActorAlign.CENTER}));
        this._label = new St.Label({style_class: 'sde-hub-label', x_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.line_wrap = true;
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._label.clutter_text.line_alignment = Pango.Alignment.CENTER;
        this._hub.add_child(this._label);
        this._hub.add_child(new St.Label({
            style_class: 'sde-hub-hint',
            text: `${profile.name ?? ''}${modeLabel ? ` · ${modeLabel}` : ''}`,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this.add_child(this._hub);
        this._hub.connect('notify::height', () => this._centerHub());
        this._hub.connect('notify::width', () => this._centerHub());

        this._angle = this._targetAngle = this._itemAngle(0);
        this._updateSelection();
    }

    get selectedItem() {
        return this._items[this._selected] ?? null;
    }

    open() {
        Main.layoutManager.uiGroup.add_child(this);
        placeAtPointer(this, this._size);
        this.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: OPEN_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    /**
     * @param {boolean} executed whether the selected item is being run (pulses it)
     */
    close(executed = false) {
        const icon = this._icons[this._selected];
        if (executed && icon) {
            icon.ease({
                scale_x: 1.6,
                scale_y: 1.6,
                duration: CLOSE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this.ease({
            opacity: 0,
            scale_x: executed ? 1.08 : 0.85,
            scale_y: executed ? 1.08 : 0.85,
            duration: CLOSE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    /**
     * @param {number} steps items to move, positive is clockwise
     */
    move(steps) {
        const count = this._items.length;
        if (!count)
            return;
        this._selected = ((this._selected + steps) % count + count) % count;
        this._updateSelection();
        // Steps that arrive mid-animation add to where the highlight is
        // heading, not to where it currently is, so it never falls behind.
        this._targetAngle += steps * 2 * Math.PI / count;
        this._animateAngle(this._targetAngle);
    }

    _itemAngle(i) {
        return -Math.PI / 2 + i * 2 * Math.PI / Math.max(this._items.length, 1);
    }

    _centerHub() {
        this._hub.set_position(
            Math.round((this._size - this._hub.width) / 2),
            Math.round((this._size - this._hub.height) / 2));
    }

    _updateSelection() {
        this._label.text = this.selectedItem?.label ?? 'No actions';
        this._icons.forEach((icon, i) => {
            const selected = i === this._selected;
            if (selected)
                icon.add_style_pseudo_class('selected');
            else
                icon.remove_style_pseudo_class('selected');
            icon.ease({
                scale_x: selected ? 1.25 : 1,
                scale_y: selected ? 1.25 : 1,
                duration: SELECT_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    // Moves the highlight along the ring; the angle is never wrapped so the
    // highlight always travels the way the dial was turned.
    _animateAngle(target) {
        this._timeline?.stop();
        const from = this._angle;
        if (!St.Settings.get().enable_animations) {
            this._angle = target;
            this._canvas.queue_repaint();
            return;
        }
        this._timeline = new Clutter.Timeline({actor: this, duration: SELECT_TIME});
        this._timeline.connect('new-frame', timeline => {
            this._angle = from + (target - from) * easeOutCubic(timeline.get_progress());
            this._canvas.queue_repaint();
        });
        this._timeline.connect('completed', () => {
            this._angle = target;
            this._canvas.queue_repaint();
        });
        this._timeline.start();
    }

    _accent() {
        const color = this._accentProbe.get_theme_node().get_color('color');
        return [color.red / 255, color.green / 255, color.blue / 255, 1];
    }

    _repaint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const c = width / 2;
        const outer = width / 2 * (1 - SHADOW);
        const inner = outer * INNER_RADIUS;
        const count = Math.max(this._items.length, 1);
        const p = this._palette;
        const y = height / 2;

        // Soft drop shadow: a few blurred-looking rings below the band.
        for (let i = 6; i > 0; i--) {
            const [r, g, b, a] = p.shadow;
            cr.setSourceRGBA(r, g, b, a / 6 * (1 - i / 7));
            cr.arc(c, y + outer * 0.03, outer + i * width * SHADOW / 14, 0, 2 * Math.PI);
            cr.fill();
        }

        // Glass band, lit from above.
        const band = new Cairo.LinearGradient(0, y - outer, 0, y + outer);
        band.addColorStopRGBA(0, ...p.bandTop);
        band.addColorStopRGBA(1, ...p.bandBottom);
        cr.arc(c, y, outer, 0, 2 * Math.PI);
        cr.arcNegative(c, y, inner, 2 * Math.PI, 0);
        cr.setSource(band);
        cr.fill();

        // Separators between the items.
        if (this._items.length > 1) {
            setSource(cr, p.separator);
            cr.setLineWidth(Math.max(1, width / 300));
            for (let i = 0; i < count; i++) {
                const a = this._itemAngle(i) + Math.PI / count;
                cr.moveTo(c + inner * 1.04 * Math.cos(a), y + inner * 1.04 * Math.sin(a));
                cr.lineTo(c + outer * 0.96 * Math.cos(a), y + outer * 0.96 * Math.sin(a));
            }
            cr.stroke();
        }

        // Accent highlight behind the selected item: a soft glow, then the
        // segment itself, brighter towards the rim.
        if (this._items.length) {
            const half = Math.PI / count;
            const gap = Math.min(0.06, half * 0.25);
            const [r, g, b] = this._accent();
            const segment = (from, to, gapAngle) => {
                cr.arc(c, y, to, this._angle - half + gapAngle, this._angle + half - gapAngle);
                cr.arcNegative(c, y, from, this._angle + half - gapAngle, this._angle - half + gapAngle);
                cr.closePath();
            };

            for (let i = 3; i > 0; i--) {
                const spread = width * 0.008 * i;
                segment(inner + width * 0.012 - spread, outer - width * 0.012 + spread, gap - spread / outer);
                cr.setSourceRGBA(r, g, b, 0.07);
                cr.fill();
            }

            const dx = Math.cos(this._angle), dy = Math.sin(this._angle);
            const fill = new Cairo.LinearGradient(c + inner * dx, y + inner * dy, c + outer * dx, y + outer * dy);
            fill.addColorStopRGBA(0, r * 0.85, g * 0.85, b * 0.85, 1);
            fill.addColorStopRGBA(1, r + (1 - r) * 0.18, g + (1 - g) * 0.18, b + (1 - b) * 0.18, 1);
            segment(inner + width * 0.012, outer - width * 0.012, gap);
            cr.setSource(fill);
            cr.fill();
        }

        // Edges of the band and the hub.
        cr.setLineWidth(Math.max(1, width / 260));
        setSource(cr, p.bandEdge);
        cr.arc(c, y, outer, 0, 2 * Math.PI);
        cr.stroke();
        cr.arc(c, y, inner, 0, 2 * Math.PI);
        setSource(cr, p.hub);
        cr.fillPreserve();
        setSource(cr, p.bandEdge);
        cr.stroke();

        cr.$dispose();
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this._canvas?.queue_repaint();
    }

    destroy() {
        this._timeline?.stop();
        this._timeline = null;
        super.destroy();
    }
});

/** A short-lived pill near the pointer announcing the rotate mode. */
export const ModeToast = GObject.registerClass(
class ModeToast extends St.BoxLayout {
    /**
     * @param {object} params parameters
     * @param {object[]} params.modes modes of the profile
     * @param {number} params.index index of the active mode
     * @param {string} params.iconDir directory of the bundled icons
     */
    _init({modes, index, iconDir}) {
        super._init({style_class: 'sde-toast', opacity: 0});
        if (!isDark())
            this.add_style_class_name('sde-light');

        const mode = modes[index];
        this.add_child(new St.Icon({gicon: lookupIcon(mode.icon, iconDir), style_class: 'sde-toast-icon'}));
        this.add_child(new St.Label({text: mode.label, style_class: 'sde-toast-label', y_align: Clutter.ActorAlign.CENTER}));
        const dots = new St.BoxLayout({style_class: 'sde-toast-dots', y_align: Clutter.ActorAlign.CENTER});
        modes.forEach((_, i) => {
            const dot = new St.Widget({style_class: 'sde-toast-dot', y_align: Clutter.ActorAlign.CENTER});
            if (i === index)
                dot.add_style_pseudo_class('current');
            dots.add_child(dot);
        });
        this.add_child(dots);

        this._timeoutId = 0;
    }

    show() {
        Main.layoutManager.uiGroup.add_child(this);
        const [x, y] = global.get_pointer();
        const [, width] = this.get_preferred_width(-1);
        const monitor = pointerWorkArea();
        this.set_position(
            Math.round(Math.clamp(x - width / 2, monitor.x, monitor.x + monitor.width - width)),
            Math.round(Math.min(y + 32, monitor.y + monitor.height - 64)));
        this.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_TIME, () => {
            this._timeoutId = 0;
            this.ease({
                opacity: 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => this.destroy(),
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        super.destroy();
    }
});
