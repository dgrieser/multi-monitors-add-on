/*
Copyright (C) 2014  spin83

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, visit https://www.gnu.org/licenses/.
*/
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Panel from 'resource:///org/gnome/shell/ui/panel.js';
import { EventEmitter } from 'resource:///org/gnome/shell/misc/signals.js';

// --- Signal-leak guard -----------------------------------------------------
//
// A MultiMonitorsPanel is a full Panel.Panel, so super._init() builds a
// complete duplicate of the top panel for the secondary monitor: quickSettings
// (PowerToggle, BackgroundAppsToggle, screencast/remote-access indicators, ...)
// and dateMenu. Those built-in indicators connect to session-long singletons
// (Main.sessionMode, St.Settings, notification sources, per-toggle DBus
// proxies) and never disconnect, because the real top panel lives for the
// whole session. Our mirror panels are created/destroyed on every
// monitors-changed / enable-disable, so each teardown leaks those handlers.
// They then keep firing on the disposed indicators forever:
//   "Object Gjs_status_system_PowerToggle ... has been already disposed"  (spam)
//   "TypeError: ... this._settings is null"  (dateMenu)
//
// We can't make GNOME's indicators clean up after themselves, so instead we
// record every signal connection made while the panel is built and disconnect
// them all when the panel is destroyed. sessionMode (and friends) are
// EventEmitters, the proxies/St widgets are GObjects, so both prototypes are
// patched for the synchronous build window only.

let _captureSink = null;
let _captureDepth = 0;
let _patchedMethods = [];

function _wrapConnect(orig) {
	return function (...args) {
		const id = orig.apply(this, args);
		if (_captureSink) {
			try {
				_captureSink.push({ target: this, id });
			} catch (e) {
				// never let bookkeeping break a real connect()
			}
		}
		return id;
	};
}

// Override proto[name] with a capturing wrapper. Tolerates a non-writable
// method (degrades to "not captured" instead of throwing in strict mode) and
// remembers the original so it can be restored exactly.
function _patchConnect(proto, name) {
	const orig = proto[name];
	if (typeof orig !== 'function')
		return;
	try {
		proto[name] = _wrapConnect(orig);
		_patchedMethods.push({ proto, name, orig });
	} catch (e) {
		// method is read-only on this GJS build; skip silently
	}
}

function _captureConnections(buildFn) {
	const captured = [];

	if (_captureDepth === 0) {
		_patchedMethods = [];
		_patchConnect(GObject.Object.prototype, 'connect');
		_patchConnect(GObject.Object.prototype, 'connect_after');
		_patchConnect(EventEmitter.prototype, 'connect');
	}

	const prevSink = _captureSink;
	_captureSink = captured;
	_captureDepth++;

	try {
		buildFn();
	} finally {
		_captureSink = prevSink;
		_captureDepth--;

		if (_captureDepth === 0) {
			for (const { proto, name, orig } of _patchedMethods) {
				try {
					proto[name] = orig;
				} catch (e) {
					// unreachable in practice: we only patched writable methods
				}
			}
			_patchedMethods = [];
		}
	}

	return captured;
}

export var MultiMonitorsPanel = (() => {
	let MultiMonitorsPanel = class MultiMonitorsPanel extends Panel.Panel {
		_init(monitorIndex, mmPanelBox) {
			// Build the full duplicate panel, recording every signal it wires
			// up so we can unwire it again on destroy (see notes above).
			this._mmCapturedConnections = _captureConnections(() => {
				super._init();
			});

			Main.layoutManager.panelBox.remove_child(this);
			mmPanelBox.panelBox.add_child(this);
			this.monitorIndex = monitorIndex;
			this.connect('destroy', this._onDestroy.bind(this));
		}

		// Per-toggle Gio.DBusProxy objects (e.g. PowerToggle._proxy watching
		// UPower) connect g-properties-changed -> _sync() only after their
		// async DBus init completes, i.e. after super._init() returns, so the
		// build-time capture above never sees them. They are private to each
		// duplicated indicator, so the safe teardown is to dispose them.
		_mmCollectProxies() {
			const proxies = new Set();
			const seen = new Set();

			const visit = (node, depth) => {
				if (!node || depth > 6 || seen.has(node))
					return;
				seen.add(node);

				let proxy;
				try {
					proxy = node._proxy;
				} catch (e) {
					proxy = null;
				}
				if (proxy instanceof Gio.DBusProxy)
					proxies.add(proxy);

				// descend into a panel menu (the toggles live there, not in
				// the panel actor tree)
				let menu;
				try {
					menu = node.menu;
				} catch (e) {
					menu = null;
				}
				if (menu) {
					for (const key of ['box', '_grid', 'actor']) {
						let sub;
						try {
							sub = menu[key];
						} catch (e) {
							continue;
						}
						if (sub)
							visit(sub, depth + 1);
					}
				}

				let children;
				try {
					children = node.get_children ? node.get_children() : null;
				} catch (e) {
					children = null;
				}
				if (children)
					children.forEach(child => visit(child, depth + 1));
			};

			visit(this, 0);
			try {
				for (const role in this.statusArea)
					visit(this.statusArea[role], 0);
			} catch (e) {
				// statusArea not available; nothing to collect
			}

			return [...proxies];
		}

		_mmTeardown() {
			// Idempotent. _popPanel() calls this proactively while the actor
			// tree is still alive; the panel's own 'destroy' handler then calls
			// it again as a safety net. Run once.
			if (this._mmTornDown)
				return;
			this._mmTornDown = true;

			if (this._mmCapturedConnections) {
				for (const { target, id } of this._mmCapturedConnections) {
					// Skip Clutter actors. Their signal handlers are freed
					// automatically when the actor is destroyed -- both the
					// panel's own widgets and the transient menu items GNOME
					// rebuilds during the panel's life (e.g. the keyboard
					// LayoutMenuItem, recreated on every input-source change).
					// Disconnecting those by hand is unnecessary and, once the
					// actor is disposed, only emits "already disposed" /
					// "no handler with id" spam. The genuine leaks we must undo
					// are connections to long-lived NON-actor singletons
					// (sessionMode, St.Settings, GSettings), still alive here.
					if (target instanceof Clutter.Actor)
						continue;
					try {
						// Live GObject: skip a stale id so disconnect() can't
						// raise a "no handler with id" critical. EventEmitter
						// targets short-circuit past this and disconnect directly
						// (a safe no-op if the handler is already gone).
						if (target instanceof GObject.Object &&
							!GObject.signal_handler_is_connected(target, id))
							continue;
						target.disconnect(id);
					} catch (e) {
						// target already disposed / id already gone
					}
				}
				this._mmCapturedConnections = null;
			}

			// Dispose the per-toggle Gio.DBusProxy objects. They are created
			// during async DBus init that finishes AFTER _init() returns, so we
			// collect at teardown (not build time) to catch every one. This must
			// run while the actor tree is still walkable -> _popPanel() tears
			// down before panelBox.destroy(), so the subtree is still intact.
			for (const proxy of this._mmCollectProxies()) {
				try {
					proxy.run_dispose();
				} catch (e) {
					// already disposed
				}
			}
		}

		_onDestroy() {
			Main.ctrlAltTabManager.removeGroup(this);
			this._mmTeardown();
		}

		vfunc_get_preferred_width(_forHeight) {
			if (Main.layoutManager.monitors.length > this.monitorIndex)
				return [0, Main.layoutManager.monitors[this.monitorIndex].width];

			return [0, 0];
		}

	};
	return GObject.registerClass(MultiMonitorsPanel);
})();
