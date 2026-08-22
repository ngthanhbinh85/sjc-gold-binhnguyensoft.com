import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const PROCESS_TIMEOUT_MS = 35 * 1000;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const DEFAULT_X = 15;
const DEFAULT_Y = 15;

function formatPrice(value) {
    if (value === null || value === undefined || value === '')
        return '—';
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat('vi-VN').format(number) : '—';
}

function formatDecimal(value) {
    if (value === null || value === undefined || value === '')
        return '—';
    const number = Number(value);
    if (!Number.isFinite(number))
        return '—';
    return new Intl.NumberFormat('vi-VN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(number);
}

function formatSignedPrice(value) {
    if (value === null || value === undefined || value === '')
        return '—';
    const number = Number(value);
    if (!Number.isFinite(number))
        return '—';
    return `${number > 0 ? '+' : ''}${formatPrice(Math.round(number))}`;
}

function currentTimeText() {
    return GLib.DateTime.new_now_local().format('%H:%M');
}

function makeLabel(text, styleClass, params = {}) {
    return new St.Label({
        text,
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
        ...params,
    });
}

function finiteInRange(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max;
}

function validateData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('Dữ liệu trả về không phải object JSON');

    if (!finiteInRange(data.buy, 1_000_000, 1_000_000_000) ||
        !finiteInRange(data.sell, 1_000_000, 1_000_000_000))
        throw new Error('Giá SJC nằm ngoài phạm vi hợp lệ');

    if (Number(data.sell) < Number(data.buy))
        throw new Error('Giá bán SJC thấp hơn giá mua');

    if (data.spot_usd_oz != null && !finiteInRange(data.spot_usd_oz, 100, 20_000))
        throw new Error('XAU/USD không hợp lệ');

    if (data.usd_vnd_sell != null && !finiteInRange(data.usd_vnd_sell, 10_000, 100_000))
        throw new Error('USD/VND không hợp lệ');

    if (data.international_vnd_luong != null &&
        !finiteInRange(data.international_vnd_luong, 1_000_000, 1_000_000_000))
        throw new Error('Giá quốc tế quy đổi không hợp lệ');

    return data;
}

/**
 * A small, purpose-built equivalent of azClock's CommandLabel runner.
 * It never executes synchronously on the GNOME Shell main thread.
 */
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
        const serial = ++this._serial;
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
                    try {
                        proc.force_exit();
                    } catch (_) {
                        // Process may already have exited.
                    }
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
                throw new Error('Output của tiến trình vượt giới hạn an toàn');

            return {stdout: out, stderr: err, successful: proc.get_successful()};
        } catch (error) {
            if (timedOut)
                throw new Error(`Quá thời gian ${PROCESS_TIMEOUT_MS / 1000} giây`);
            throw error;
        } finally {
            if (this._timeoutId && serial === this._serial) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            if (serial === this._serial) {
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
            try {
                this._proc.force_exit();
            } catch (_) {
                // Process may already have exited.
            }
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

        this._extension = extension;
        this._refreshSourceId = 0;
        this._failureCount = 0;
        this._destroyed = false;
        this._runner = new SafeCommandRunner();

        this._buildUi();

        // Desktop/background layer only: no button, no drag, no pointer interaction.
        Main.layoutManager._backgroundGroup.add_child(this);
        void this._refresh();
    }

    _buildUi() {
        this._card = new St.BoxLayout({
            vertical: true,
            style_class: 'sjc-card',
        });
        this.add_child(this._card);

        const header = new St.BoxLayout({
            style_class: 'sjc-header',
            x_expand: true,
        });
        this._title = makeLabel('GIÁ VÀNG SJC', 'sjc-title', {
            x_expand: true,
        });
        header.add_child(this._title);
        this._card.add_child(header);

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
        this._card.add_child(product);

        const prices = new St.BoxLayout({
            vertical: true,
            style_class: 'sjc-price-row',
            x_expand: true,
        });

        // Use two full-width rows instead of two independent columns.
        // This anchors the sell label and sell price to the true right edge
        // of the card content area.
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
        this._card.add_child(prices);

        const footer = new St.BoxLayout({
            vertical: true,
            style_class: 'sjc-footer',
            x_expand: true,
        });
        this._card.add_child(footer);

        [this._spreadValue, this._internationalValue, this._premiumValue] = [
            ['Chênh lệch bán - mua:', '—'],
            ['Giá quốc tế quy đổi (chưa thuế phí):', '—'],
            ['Chênh lệch giá bán SJC - giá quốc tế:', '—'],
        ].map(([caption, value]) => this._makeFooterRow(footer, caption, value));

        footer.add_child(new St.Widget({height: 3}));

        const marketRow = new St.BoxLayout({
            style_class: 'sjc-footer-row sjc-market-row',
            x_expand: true,
        });
        this._spotValue = makeLabel(
            'XAU/USD: ASK —',
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
        this._card.add_child(this._errorText);
    }

    _makeFooterRow(parent, caption, initialValue) {
        const row = new St.BoxLayout({
            style_class: 'sjc-footer-row',
            x_expand: true,
        });
        const label = makeLabel(caption, 'sjc-footer-text', {
            x_expand: true,
        });
        const value = makeLabel(initialValue, 'sjc-footer-text', {
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
                try {
                    void this._refresh();
                } catch (error) {
                    console.error(`SJC Gold: timer callback failed: ${error}`);
                    this._scheduleAfterFailure();
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _scheduleAfterFailure() {
        this._failureCount = Math.min(this._failureCount + 1, 10);
        const factor = 2 ** Math.max(0, this._failureCount - 1);
        this._scheduleNextRefresh(
            Math.min(REFRESH_INTERVAL_MS * factor, MAX_BACKOFF_MS)
        );
    }

    async _refresh() {
        if (this._destroyed)
            return;

        // Never overlap workers. Network/parsing remains outside GNOME Shell.
        if (this._runner.running)
            return;

        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        try {
            const scriptPath = GLib.build_filenamev([
                this._extension.path,
                'sjc_price.py',
            ]);
            const result = await this._runner.run([
                'python3',
                '-B',
                scriptPath,
            ]);

            if (this._destroyed)
                return;

            const raw = result.stdout.trim();
            let data;
            try {
                data = JSON.parse(raw);
            } catch (error) {
                throw new Error(
                    raw ||
                    result.stderr.trim() ||
                    `JSON không hợp lệ: ${error.message}`
                );
            }

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
        const buy = Number(data.buy);
        const sell = Number(data.sell);
        const international =
            data.international_vnd_luong == null
                ? NaN
                : Number(data.international_vnd_luong);
        const premium =
            data.premium_sell == null
                ? NaN
                : Number(data.premium_sell);
        const spread = sell - buy;

        this._productName.text =
            `${data.name || 'Vàng miếng SJC'} (VND/lượng)`;
        this._updated.text = `Cập nhật: ${currentTimeText()}`;
        this._buyPrice.text = formatPrice(buy);
        this._sellPrice.text = formatPrice(sell);
        this._spreadValue.text = formatPrice(spread);
        this._internationalValue.text =
            Number.isFinite(international)
                ? formatPrice(Math.round(international))
                : '—';
        this._premiumValue.text =
            Number.isFinite(premium)
                ? formatSignedPrice(premium)
                : '—';
        this._spotValue.text =
            `XAU/USD: ASK ${formatDecimal(data.spot_usd_oz)}`;
        this._usdValue.text =
            `USD/VND: ${formatPrice(data.usd_vnd_sell)}`;
    }

    _showError(message, partial = false) {
        if (!message) {
            this._errorText.visible = false;
            this._errorText.text = '';
            return;
        }

        this._errorText.text = message;
        this._errorText.style_class =
            partial ? 'sjc-warning-text' : 'sjc-error-text';
        this._errorText.visible = true;
    }

    vfunc_allocate(box) {
        // Fixed desktop position; no drag state and no position file.
        box.set_origin(DEFAULT_X, DEFAULT_Y);
        super.vfunc_allocate(box);
    }

    destroy() {
        this._destroyed = true;

        this._runner?.destroy();
        this._runner = null;

        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        super.destroy();
    }
});

export default class SjcGoldExtension extends Extension {
    enable() {
        try {
            this._widget = new SjcGoldWidget(this);
        } catch (error) {
            console.error(`SJC Gold: enable failed: ${error}`);
            this._widget?.destroy();
            this._widget = null;
        }
    }

    disable() {
        try {
            this._widget?.destroy();
        } catch (error) {
            console.error(`SJC Gold: disable cleanup failed: ${error}`);
        } finally {
            this._widget = null;
        }
    }
}
