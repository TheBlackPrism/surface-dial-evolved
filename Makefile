UUID      := surface-dial-evolved@theblackprism.ch
EXT_DIR   := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
UDEV_RULE := /etc/udev/rules.d/70-surface-dial.rules

.PHONY: all schemas install uninstall install-udev pack test nested plugin

all: schemas

schemas:
	glib-compile-schemas --strict extension/schemas

# Symlinks the working copy, so a re-login (or `make nested`) picks up changes.
install: schemas
	mkdir -p $(dir $(EXT_DIR))
	ln -sfn $(CURDIR)/extension $(EXT_DIR)
	@echo "Log out and back in, then: gnome-extensions enable $(UUID)"

uninstall:
	rm -f $(EXT_DIR)

# One-time, needs sudo: lets the logged-in user read the dial and drive its haptics.
install-udev:
	sudo install -m 644 udev/70-surface-dial.rules $(UDEV_RULE)
	sudo udevadm control --reload
	sudo udevadm trigger --action=change --subsystem-match=input --subsystem-match=hidraw

pack: schemas
	mkdir -p build
	gnome-extensions pack --force --out-dir=build \
		--extra-source=lib --extra-source=profiles --extra-source=icons --extra-source=helpers \
		extension

test:
	gjs -m tests/run.js

# Nested GNOME Shell in a window, for UI work without logging out.
nested: install
	tools/nested.sh

plugin:
	cd intellij-plugin && ./gradlew buildPlugin
