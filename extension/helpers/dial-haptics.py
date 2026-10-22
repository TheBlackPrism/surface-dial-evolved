#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Yves Lütjens
"""Configures the haptics of a Surface Dial through its hidraw node.

GJS cannot issue ioctls, so the GNOME Shell extension runs this helper:

    dial-haptics.py /dev/hidrawN mode STEPS on|off
        Sets the resolution to STEPS per revolution (REL_DIAL then reports
        one unit per step) and whether the dial clicks on every step.
    dial-haptics.py /dev/hidrawN buzz click|buzz|rumble [REPEAT]
        Plays a waveform once (plus REPEAT repetitions).

Report layout from the dial's HID report descriptor, report ID 1:
    feature: resolution multiplier (u16), repeat count (u8),
             auto trigger (u8), waveform cutoff time (u8), retrigger period (u16)
    output:  repeat count (u8), manual trigger (u8), retrigger period (u16)
Waveform ordinals: 2 = stop/none, 3 = click, 4 = buzz, 5 = rumble.
"""

import fcntl
import os
import struct
import sys

WAVEFORMS = {"click": 3, "buzz": 4, "rumble": 5}
WAVEFORM_NONE = 2


def hidiocsfeature(length):
    # _IOC(_IOC_WRITE | _IOC_READ, 'H', 0x06, len)
    return (3 << 30) | (length << 16) | (ord("H") << 8) | 0x06


def set_mode(fd, steps, haptics):
    report = struct.pack("<BHBBBH", 1, steps, 0, WAVEFORMS["click"] if haptics else WAVEFORM_NONE, 0, 0)
    fcntl.ioctl(fd, hidiocsfeature(len(report)), bytearray(report))


def buzz(fd, waveform, repeat):
    os.write(fd, struct.pack("<BBBH", 1, repeat, WAVEFORMS[waveform], 0))


def main(argv):
    if len(argv) < 3:
        sys.exit(__doc__)
    path, command, args = argv[1], argv[2], argv[3:]
    fd = os.open(path, os.O_RDWR)
    try:
        if command == "mode" and len(args) == 2 and args[1] in ("on", "off"):
            steps = int(args[0])
            if not 1 <= steps <= 3600:
                sys.exit("STEPS must be between 1 and 3600")
            set_mode(fd, steps, args[1] == "on")
        elif command == "buzz" and 1 <= len(args) <= 2 and args[0] in WAVEFORMS:
            buzz(fd, args[0], int(args[1]) if len(args) == 2 else 0)
        else:
            sys.exit(__doc__)
    finally:
        os.close(fd)


if __name__ == "__main__":
    main(sys.argv)
