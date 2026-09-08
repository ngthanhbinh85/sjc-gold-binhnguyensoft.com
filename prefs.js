/*
 * Widget giá vàng SJC
 *
 * Copyright (C) 2026 Binh Nguyen (binhnguyensoft.com)
 *
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SjcGoldPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(600, 400);
        this._settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Widget giá vàng SJC',
            icon_name: 'preferences-desktop-display-symbolic',
        });

        // Vị trí
        const positionGroup = new Adw.PreferencesGroup({
            title: 'Vị trí',
            description: 'Thay đổi vị trí xuất hiện của widget',
        });

        // Trái
        const left = new Gtk.Adjustment({
            lower: 0,
            upper: 10000,
            step_increment: 5,
            value: this._settings.get_int('left'),
        });

        const leftRow = new Adw.SpinRow({
            title: 'Trái',
            subtitle: 'Lề trái theo pixel',
            adjustment: left,
            digits: 0,
            numeric: true,
            snap_to_ticks: true,
        });

        leftRow.connect('notify::value', row => {
            const value = Math.round(row.get_value());
            if (this._settings.get_int('left') !== value)
                this._settings.set_int('left', value);
        });

        // Trên
        const top = new Gtk.Adjustment({
            lower: 0,
            upper: 10000,
            step_increment: 5,
            value: this._settings.get_int('top'),
        });

        const topRow = new Adw.SpinRow({
            title: 'Trên',
            subtitle: 'Lề trên theo pixel',
            adjustment: top,
            digits: 0,
            numeric: true,
            snap_to_ticks: true,
        });

        topRow.connect('notify::value', row => {
            const value = Math.round(row.get_value());
            if (this._settings.get_int('top') !== value)
                this._settings.set_int('top', value);
        });

        positionGroup.add(leftRow);
        positionGroup.add(topRow);
        page.add(positionGroup);
        window.add(page);
        this._addAboutButton(window);

        window.connect('close-request', () => {
            if (this._settingsChangedId) {
                this._settings.disconnect(this._settingsChangedId);
                this._settingsChangedId = 0;
            }
            return false;
        });
    }

    _addAboutButton(window) {
        const headerBar = this._findHeaderBar(window);
        if (!headerBar)
            return;

        const aboutButton = new Gtk.Button({
            icon_name: 'open-menu-symbolic',
            tooltip_text: 'About',
            valign: Gtk.Align.CENTER,
        });
        aboutButton.add_css_class('flat');
        aboutButton.connect('clicked', () => this._showAbout(window));

        headerBar.pack_end(aboutButton);
    }

    _findHeaderBar(widget) {
        if (widget instanceof Adw.HeaderBar)
            return widget;

        for (let child = widget.get_first_child(); child;
            child = child.get_next_sibling()) {
            const headerBar = this._findHeaderBar(child);
            if (headerBar)
                return headerBar;
        }

        return null;
    }

    _showAbout(window) {
        const params = {
            application_name: this.metadata.name,
            developer_name: 'Bình Nguyễn',
            website: 'https://www.binhnguyensoft.com',
            issue_url: `${this.metadata.url.replace(/\/+$/, '')}/issues`,
        };

        if (Adw.AboutDialog) {
            const about = new Adw.AboutDialog(params);
            about.present(window);
        } else {
            const about = new Adw.AboutWindow({
                ...params,
                transient_for: window,
                modal: true,
            });
            about.present();
        }
    }

}
