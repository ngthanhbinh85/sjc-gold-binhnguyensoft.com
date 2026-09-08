/*
 * Widget giá vàng SJC
 *
 * Copyright (C) 2026 Binh Nguyen (binhnguyensoft.com)
 *
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Refresh dữ liệu mỗi 5 phút
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const PROCESS_TIMEOUT_MS = 35 * 1000;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const MAX_ERROR_CHARS = 240;
const PRICE_FORMAT = new Intl.NumberFormat('vi-VN');
const DECIMAL_FORMAT = new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

function formatPrice(value) {
    return Number.isFinite(value) ? PRICE_FORMAT.format(value) : '—';
}

function formatDecimal(value) {
    return Number.isFinite(value) ? DECIMAL_FORMAT.format(value) : '—';
}

function formatSignedPrice(value) {
    if (!Number.isFinite(value))
        return '—';
    const rounded = Math.round(value);
    return `${rounded > 0 ? '+' : ''}${formatPrice(rounded === 0 ? 0 : rounded)}`;
}

function makeLabel(text, styleClass, params = {}) {
    return new St.Label({
        text,
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
        ...params,
    });
}

function validateData(data) {
    for (const key of ['buy', 'sell']) {
        if (!Number.isFinite(data[key]))
            throw new Error(`Giá ${key} không hợp lệ`);
    }

    for (const key of [
        'spot_usd_oz',
        'usd_vnd_sell',
        'international_vnd_luong',
        'premium_sell',
    ]) {
        if (data[key] != null && !Number.isFinite(data[key]))
            throw new Error(`Dữ liệu ${key} không hợp lệ`);
    }
}

class SafeCommandRunner {
    constructor() {
        this._proc = null;
        this._cancellable = null;
        this._timeoutId = 0;
        this._serial = 0;
        this._destroyed = false;
    }

    get running() {
        return this._proc !== null;
    }

    async run(argv) {
        if (this._destroyed)
            throw new Error('Command runner đã bị hủy');

        this.cancel();
        const serial = this._serial;
        const cancellable = new Gio.Cancellable();
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );

        this._proc = proc;
        this._cancellable = cancellable;

        let timedOut = false;
        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PROCESS_TIMEOUT_MS,
            () => {
                this._timeoutId = 0;
                if (this._proc === proc && serial === this._serial) {
                    timedOut = true;
                    cancellable.cancel();
                    proc.force_exit();
                }
                return GLib.SOURCE_REMOVE;
            }
        );

        try {
            const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
            if (serial !== this._serial || this._destroyed)
                throw new Error('__SJC_CANCELLED__');

            if (timedOut)
                throw new Error(`Quá thời gian ${PROCESS_TIMEOUT_MS / 1000} giây`);

            const out = stdout ?? '';
            const err = stderr ?? '';
            if (out.length > MAX_OUTPUT_CHARS || err.length > MAX_OUTPUT_CHARS)
                throw new Error('Output của tiến trình quá dài');

            return {stdout: out, stderr: err, successful: proc.get_successful()};
        } catch (error) {
            if (timedOut)
                throw new Error(`Quá thời gian ${PROCESS_TIMEOUT_MS / 1000} giây`);
            throw error;
        } finally {
            if (serial === this._serial) {
                if (this._timeoutId) {
                    GLib.source_remove(this._timeoutId);
                    this._timeoutId = 0;
                }
                this._proc = null;
                this._cancellable = null;
            }
        }
    }

    cancel() {
        ++this._serial;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._proc) {
            this._proc.force_exit();
            this._proc = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this.cancel();
    }
}

const SjcGoldWidget = GObject.registerClass(
class SjcGoldWidget extends St.Widget {
    _init(extension) {
        super._init({
            reactive: false,
            can_focus: false,
            layout_manager: new Clutter.BinLayout(),
        });

        this._scriptPath = GLib.build_filenamev([extension.path, 'sjc_price.py']);
        this._refreshSourceId = 0;
        this._failureCount = 0;
        this._destroyed = false;
        this._runner = new SafeCommandRunner();

        this._settings = extension.getSettings();
        this._buildUi();

        this._positionChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'left' || key === 'top')
                this.queue_relayout();
        });
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this.queue_relayout());

        Main.layoutManager._backgroundGroup.add_child(this);
        void this._refresh();
    }

    _buildUi() {
        const card = new St.BoxLayout({
            vertical: true,
            style_class: 'sjc-card',
        });
        this.add_child(card);

        const header = new St.BoxLayout({
            style_class: 'sjc-header',
            x_expand: true,
        });
        const title = makeLabel('GIÁ VÀNG SJC', 'sjc-title', {
            x_expand: true,
        });
        header.add_child(title);
        card.add_child(header);

        const product = new St.BoxLayout({
            style_class: 'sjc-product-row',
            x_expand: true,
        });
        this._productName = makeLabel(
            'Vàng miếng SJC (VND/lượng)',
            'sjc-product',
            {x_expand: true}
        );
        this._updated = makeLabel(
            'Cập nhật: --:--',
            'sjc-product',
            {x_align: Clutter.ActorAlign.END}
        );
        product.add_child(this._productName);
        product.add_child(this._updated);
        card.add_child(product);

        const prices = new St.BoxLayout({
            vertical: true,
            style_class: 'sjc-price-row',
            x_expand: true,
        });

        // Hai hàng nhãn và giá mua/bán
        const labelsRow = new St.BoxLayout({
            x_expand: true,
        });
        const buyLabel = makeLabel('MUA VÀO', 'sjc-label', {
            x_expand: true,
        });
        buyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        buyLabel.clutter_text.set_line_alignment(Pango.Alignment.LEFT);

        const sellLabel = makeLabel('BÁN RA', 'sjc-label', {
            x_align: Clutter.ActorAlign.END,
        });
        sellLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        sellLabel.clutter_text.set_line_alignment(Pango.Alignment.RIGHT);

        labelsRow.add_child(buyLabel);
        labelsRow.add_child(sellLabel);

        const valuesRow = new St.BoxLayout({
            x_expand: true,
        });
        this._buyPrice = makeLabel('—', 'sjc-price', {
            x_expand: true,
        });
        this._buyPrice.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._buyPrice.clutter_text.set_line_alignment(Pango.Alignment.LEFT);

        this._sellPrice = makeLabel('—', 'sjc-price', {
            x_align: Clutter.ActorAlign.END,
        });
        this._sellPrice.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._sellPrice.clutter_text.set_line_alignment(Pango.Alignment.RIGHT);

        valuesRow.add_child(this._buyPrice);
        valuesRow.add_child(this._sellPrice);

        prices.add_child(labelsRow);
        prices.add_child(valuesRow);
        card.add_child(prices);

        // Thông tin chân widget
        const footer = new St.BoxLayout({
            vertical: true,
            style_class: 'sjc-footer',
            x_expand: true,
        });
        card.add_child(footer);

        [this._spreadValue, this._internationalValue, this._premiumValue] = [
            'Chênh lệch bán - mua:',
            'Giá quốc tế quy đổi (chưa thuế phí):',
            'Chênh lệch giá bán SJC - giá quốc tế:',
        ].map(caption => this._makeFooterRow(footer, caption));

        footer.add_child(new St.Widget({height: 3}));

        const marketRow = new St.BoxLayout({
            style_class: 'sjc-footer-row sjc-market-row',
            x_expand: true,
        });
        this._spotValue = makeLabel(
            'XAU/USD: —',
            'sjc-footer-text',
            {x_expand: true}
        );
        this._usdValue = makeLabel(
            'USD/VND: —',
            'sjc-footer-text',
            {x_align: Clutter.ActorAlign.END}
        );
        marketRow.add_child(this._spotValue);
        marketRow.add_child(this._usdValue);
        footer.add_child(marketRow);

        this._errorText = makeLabel('', 'sjc-error-text');
        this._errorText.visible = false;
        card.add_child(this._errorText);
    }

    _makeFooterRow(parent, caption) {
        const row = new St.BoxLayout({
            style_class: 'sjc-footer-row',
            x_expand: true,
        });
        const label = makeLabel(caption, 'sjc-footer-text', {
            x_expand: true,
        });
        const value = makeLabel('—', 'sjc-footer-text', {
            x_align: Clutter.ActorAlign.END,
        });
        row.add_child(label);
        row.add_child(value);
        parent.add_child(row);
        return value;
    }

    _scheduleNextRefresh(delayMs) {
        if (this._destroyed)
            return;

        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        this._refreshSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delayMs,
            () => {
                this._refreshSourceId = 0;
                void this._refresh();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _scheduleAfterFailure() {
        this._failureCount = Math.min(this._failureCount + 1, 10);
        const factor = 2 ** (this._failureCount - 1);
        this._scheduleNextRefresh(
            Math.min(REFRESH_INTERVAL_MS * factor, MAX_BACKOFF_MS)
        );
    }

    async _refresh() {
        if (this._destroyed)
            return;

        // Không chạy đồng thời nhiều tiến trình lấy giá.
        if (this._runner.running)
            return;

        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        try {
            const result = await this._runner.run([
                'python3',
                '-B',
                this._scriptPath,
            ]);

            if (this._destroyed)
                return;

            let data;
            try {
                data = JSON.parse(result.stdout);
            } catch (error) {
                throw new Error(
                    (!result.successful && result.stderr.trim()) ||
                    `JSON không hợp lệ: ${error.message}`
                );
            }

            if (!data || typeof data !== 'object' || Array.isArray(data))
                throw new Error('Dữ liệu trả về không phải object JSON');

            if (data.error)
                throw new Error(data.error);

            if (!result.successful)
                throw new Error(
                    result.stderr.trim() ||
                    'Tiến trình lấy dữ liệu thất bại'
                );

            validateData(data);
            this._renderData(data);
            this._failureCount = 0;
            this._showError(
                data.market_error
                    ? `Một phần dữ liệu thị trường lỗi · ${data.market_error}`
                    : null,
                true
            );
            this._scheduleNextRefresh(REFRESH_INTERVAL_MS);
        } catch (error) {
            if (this._destroyed)
                return;

            if (
                error.message === '__SJC_CANCELLED__' ||
                error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)
            )
                return;

            // Keep the last valid prices visible.
            const message = String(error.message || error);
            this._showError(`Không cập nhật được · ${message}`);
            console.error(`SJC Gold: refresh failed: ${error}`);
            this._scheduleAfterFailure();
        }
    }

    _renderData(data) {
        const {buy, sell, international_vnd_luong: international,
            premium_sell: premium} = data;
        const spread = sell - buy;

        this._productName.text =
            `${data.name || 'Vàng miếng SJC'} (VND/lượng)`;
        this._updated.text = `Cập nhật: ${GLib.DateTime.new_now_local().format('%H:%M')}`;
        this._buyPrice.text = formatPrice(buy);
        this._sellPrice.text = formatPrice(sell);
        this._spreadValue.text = formatPrice(spread);
        this._internationalValue.text =
            Number.isFinite(international)
                ? formatPrice(Math.round(international))
                : '—';
        this._premiumValue.text = formatSignedPrice(premium);
        this._spotValue.text =
            `XAU/USD: ${formatDecimal(data.spot_usd_oz)}`;
        this._usdValue.text =
            `USD/VND: ${formatPrice(data.usd_vnd_sell)}`;
    }

    _showError(message, partial = false) {
        if (!message) {
            this._errorText.visible = false;
            this._errorText.text = '';
            return;
        }

        const text = String(message).replace(/\s+/g, ' ').trim();
        this._errorText.text = text.length > MAX_ERROR_CHARS
            ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
        this._errorText.style_class =
            partial ? 'sjc-warning-text' : 'sjc-error-text';
        this._errorText.visible = true;
    }

    vfunc_allocate(box) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            // Tọa độ preferences tính từ góc trên trái màn hình chính.
            const maxLeft = Math.max(0, monitor.width - box.get_width());
            const maxTop = Math.max(0, monitor.height - box.get_height());
            box.set_origin(
                monitor.x + Math.min(Math.max(this._settings.get_int('left'), 0), maxLeft),
                monitor.y + Math.min(Math.max(this._settings.get_int('top'), 0), maxTop)
            );
        }
        super.vfunc_allocate(box);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._settings.disconnect(this._positionChangedId);
        Main.layoutManager.disconnect(this._monitorsChangedId);

        this._runner?.destroy();
        this._runner = null;

        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        super.destroy();
        this._settings = null;
    }
});

export default class SjcGoldExtension extends Extension {
    enable() {
        this._widget = new SjcGoldWidget(this);
    }

    disable() {
        try {
            this._widget?.destroy();
        } finally {
            this._widget = null;
        }
    }
}
