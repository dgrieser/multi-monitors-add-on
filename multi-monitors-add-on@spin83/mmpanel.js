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
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export var MultiMonitorsPanel = (() => {
	let MultiMonitorsPanel = class MultiMonitorsPanel extends St.Widget {
		_init(monitorIndex, mmPanelBox) {
			super._init({
				name: 'panel',
				style_class: 'panel',
				layout_manager: new Clutter.BoxLayout(),
				x_expand: true,
				y_expand: true,
			});

			this.monitorIndex = monitorIndex;
			this.statusArea = {};

			this._leftBox = new St.BoxLayout({
				style_class: 'panel-box panel-left',
				x_expand: true,
				y_expand: true,
			});
			this._centerBox = new St.BoxLayout({
				style_class: 'panel-box panel-center',
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.CENTER,
			});
			this._rightBox = new St.BoxLayout({
				style_class: 'panel-box panel-right',
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.END,
			});

			this.add_child(this._leftBox);
			this.add_child(this._centerBox);
			this.add_child(this._rightBox);

			mmPanelBox.panelBox.add_child(this);
			this.connect('destroy', this._onDestroy.bind(this));
		}

		_onDestroy() {
			this.statusArea = {};
		}

		vfunc_get_preferred_width(_forHeight) {
			if (Main.layoutManager.monitors.length > this.monitorIndex)
				return [0, Main.layoutManager.monitors[this.monitorIndex].width];

			return [0, 0];
		}

		addToStatusArea(role, indicator, position = 0, box = 'right') {
			if (!indicator?.container)
				throw new Error(`Indicator for role ${role} has no container`);

			let panelBox = this._rightBox;
			if (box === 'left')
				panelBox = this._leftBox;
			else if (box === 'center')
				panelBox = this._centerBox;

			if (this.statusArea[role])
				throw new Error(`Role ${role} already exists`);

			let children = panelBox.get_children();
			let index = Math.max(0, Math.min(position, children.length));
			panelBox.insert_child_at_index(indicator.container, index);
			this.statusArea[role] = indicator;
			return indicator;
		}

		removeFromStatusArea(role, indicator = null) {
			let currentIndicator = this.statusArea[role];
			if (!currentIndicator)
				return;

			if (indicator && currentIndicator !== indicator)
				return;

			delete this.statusArea[role];
		}
	};
	return GObject.registerClass(MultiMonitorsPanel);
})();
