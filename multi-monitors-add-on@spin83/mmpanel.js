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
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Panel from 'resource:///org/gnome/shell/ui/panel.js';
import { EventEmitter } from 'resource:///org/gnome/shell/misc/signals.js';
import { disconnectObject, debugGetSignalTrackers } from 'resource:///org/gnome/shell/misc/signalTracker.js';

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

// --- Late sessionMode capture ----------------------------------------------
//
// QuickSettings._setupIndicators() (panel.js) is async: after `await
// import(...)` it builds thunderbolt / backgroundApps / system / ... AFTER
// super._init() returns -- i.e. outside the synchronous capture above. Those
// indicators do a plain `Main.sessionMode.connect('updated', ...)` whose id
// GNOME discards and never disconnects (the real panel lives forever, so it
// doesn't care). For our duplicate panels the handler lingers on sessionMode
// after the panel is destroyed and fires _sync()/_syncVisibility() on the
// disposed indicator at the next session-mode change (screen lock/unlock):
//   "Object St.Icon ... already disposed", "Gio.DBusProxy ... already disposed"
//
// A plain connect() can only be undone by its id, so we record the ids of
// connects made on Main.sessionMode during the async construction window. The
// patch is on the sessionMode INSTANCE (not the prototype), so it is scoped to
// that one singleton and cannot touch other emitters. Captured handlers are
// disconnected whenever a panel is torn down (see _mmTeardown). Disconnecting a
// still-live panel's handler too is harmless -- it only toggles indicator
// visibility on the lock screen -- and it is never re-added.
//
// Caveat: with several monitors the panels' async builds interleave, so a
// captured id can't be attributed to one panel; we disconnect them as a group.
let _mmSessionCaptureRefs = 0;
let _mmSessionConnectOrig = null;
let _mmSessionCaptures = [];

function _beginSessionCapture() {
	if (_mmSessionCaptureRefs++ > 0)
		return;
	const sessionMode = Main.sessionMode;
	_mmSessionConnectOrig = sessionMode.connect;
	sessionMode.connect = function (...args) {
		const id = _mmSessionConnectOrig.apply(this, args);
		try {
			_mmSessionCaptures.push(id);
		} catch (e) {
			// never let bookkeeping break a real connect()
		}
		return id;
	};
}

function _endSessionCapture() {
	if (_mmSessionCaptureRefs === 0 || --_mmSessionCaptureRefs > 0)
		return;
	// Remove our own-property override, restoring the inherited prototype method.
	delete Main.sessionMode.connect;
	_mmSessionConnectOrig = null;
}

function _disconnectSessionCaptures() {
	const ids = _mmSessionCaptures;
	_mmSessionCaptures = [];
	for (const id of ids) {
		try {
			Main.sessionMode.disconnect(id);
		} catch (e) {
			// already disconnected / id gone
		}
	}
}

export var MultiMonitorsPanel = (() => {
	let MultiMonitorsPanel = class MultiMonitorsPanel extends Panel.Panel {
		_init(monitorIndex, mmPanelBox) {
			// Build the full duplicate panel, recording every signal it wires
			// up so we can unwire it again on destroy (see notes above).
			this._mmCapturedConnections = _captureConnections(() => {
				super._init();
			});

			// Some captured targets are actors GNOME disposes during the
			// panel's life (e.g. the keyboard LayoutMenuItem, rebuilt on every
			// input-source change). Watch each actor target's 'destroy' and mark
			// its entry dead, so teardown never touches a freed wrapper -- that
			// was the "already disposed" / "no handler with id" spam. Long-lived
			// actor targets (the genuine leaks, e.g. handlers left on the real
			// panel) are never destroyed, so their entries survive to teardown
			// and get disconnected. Non-actor singletons need no watch.
			for (const entry of this._mmCapturedConnections) {
				if (entry.target instanceof Clutter.Actor)
					entry.watchId = entry.target.connect('destroy', () => {
						entry.dead = true;
					});
			}

			// Capture sessionMode connects made by the async-built indicators
			// (see notes above). Keep capturing until the construction settles
			// on the next low-priority idle, then restore the instance method.
			_beginSessionCapture();
			this._mmSessionDrainId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
				this._mmSessionDrainId = 0;
				_endSessionCapture();
				return GLib.SOURCE_REMOVE;
			});

			Main.layoutManager.panelBox.remove_child(this);
			mmPanelBox.panelBox.add_child(this);
			this.monitorIndex = monitorIndex;
			this.connect('destroy', this._onDestroy.bind(this));
		}

		// Collect per-toggle Gio.DBusProxy objects (e.g. PowerToggle._proxy
		// watching UPower) to run_dispose() at teardown. They connect
		// g-properties-changed -> _sync() only after their async DBus init, i.e.
		// after super._init() returns, so the build-time capture never sees
		// them; they are private to each duplicated toggle, so disposing is safe.
		// (The bluetooth SystemIndicator's own client sits on a private field the
		// walk doesn't reach -- it's disposed directly in _mmTeardown. Shared
		// singletons -- NM client, Gvc mixer -- are never disposed; their leaked
		// handlers are cleaned by owner via the signal tracker in _mmTeardown.)
		_mmCollectDisposables() {
			const disposables = new Set();
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
					disposables.add(proxy);

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

			return [...disposables];
		}

		_mmTeardown() {
			// Idempotent. _popPanel() calls this proactively while the actor
			// tree is still alive; the panel's own 'destroy' handler then calls
			// it again as a safety net. Run once.
			if (this._mmTornDown)
				return;
			this._mmTornDown = true;

			// Balance the sessionMode capture. If the drain idle is still
			// pending (panel destroyed before construction settled), cancel it
			// and release our ref now so the instance patch is restored.
			if (this._mmSessionDrainId) {
				GLib.source_remove(this._mmSessionDrainId);
				this._mmSessionDrainId = 0;
				_endSessionCapture();
			}
			// Disconnect the async-built indicators' sessionMode handlers that
			// would otherwise fire on this now-disposed panel at the next lock.
			_disconnectSessionCaptures();

			if (this._mmCapturedConnections) {
				for (const entry of this._mmCapturedConnections) {
					const { target, id, watchId, dead } = entry;
					// Actor target already destroyed during the panel's life:
					// its handlers went with it, so there is nothing to undo and
					// touching the freed wrapper would only spam.
					if (dead)
						continue;
					// Gio.DBusProxy targets are reaped wholesale by run_dispose()
					// below. A proxy recreated/disposed mid-life has no 'destroy'
					// signal to prune it via the dead flag, so probing it here
					// with signal_handler_is_connected() would spam "already
					// disposed". Skip them; run_dispose() covers the live ones.
					if (target instanceof Gio.DBusProxy)
						continue;
					try {
						// The actor is still alive -- drop our destroy watch.
						if (watchId)
							target.disconnect(watchId);
						// For a live GObject, skip a stale id so disconnect()
						// can't raise a "no handler with id" critical. EventEmitter
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
			// during async DBus init after super._init() returns, so we collect
			// at teardown (not build time) to catch every one. Must run while the
			// actor tree is still walkable -> _popPanel() tears down before
			// panelBox.destroy().
			for (const obj of this._mmCollectDisposables()) {
				try {
					obj.run_dispose();
				} catch (e) {
					// already disposed
				}
			}

			// The bluetooth SystemIndicator creates its own GnomeBluetooth.Client
			// with plain connect()s whose ids GNOME discards; that client survives
			// the panel and keeps firing _sync() on the disposed St.Icon (the
			// dominant "St.Icon already disposed" spam). It is held on a private
			// field the actor walk doesn't reliably reach, so dispose it directly.
			try {
				const btClient = this.statusArea?.quickSettings?._bluetooth?._client;
				if (btClient && typeof btClient.run_dispose === 'function')
					btClient.run_dispose();
			} catch (e) {
				// quickSettings/bluetooth not present or already gone
			}

			// Disconnect connectObject() handlers whose owner is one of this
			// panel's actors, across every emitter. The async-built indicators
			// register handlers on SHARED singletons via connectObject with the
			// indicator/slider as owner: volume -> Gvc mixer control, network ->
			// NM.Client, the stream sliders -> their streams. The emitter's
			// signal tracker keeps that owner as a Map key, so it never
			// finalizes after the panel dies and its handlers keep firing on the
			// disposed St.Icon (the volume.js / network.js spam). Untracking by
			// owner disconnects them and releases the owner. We only touch owners
			// contained in THIS panel, so the real panel's indicators (whose
			// owners live elsewhere) are never affected.
			try {
				for (const [emitter, tracker] of [...debugGetSignalTrackers()]) {
					for (const owner of [...tracker._map.keys()]) {
						if (owner instanceof Clutter.Actor && this.contains(owner)) {
							try {
								disconnectObject(emitter, owner);
							} catch (e) {
								// emitter/owner already gone
							}
						}
					}
				}
			} catch (e) {
				// signalTracker debug internals unavailable / changed
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
