'use strict';
// تنظیمات پویا که از فرانت قابل تغییرند و در MongoDB ذخیره می‌شوند.
// مقدار پیش‌فرض از .env خوانده می‌شود؛ اگر روی .env خطا باشد، مقدار سخت‌کد امن استفاده می‌شود.

let deps = null;
function init(d) { deps = d; }

const DEFAULTS = {
    ENTRY_START: '09:30',
    ENTRY_END: '12:00',
    OPTION_FEE_BUY: 0.0012,
    OPTION_FEE_SELL: 0.0012,
    RISK_FREE_RATE: 0.23
};

let values = { ...DEFAULTS };

function envDefaults() {
    const num = (v, fallback) => {
        const n = parseFloat(String(v == null ? '' : v).trim());
        return Number.isFinite(n) ? n : fallback;
    };
    const time = (v, fallback) => {
        const s = String(v == null ? '' : v).trim();
        return /^\d{1,2}:\d{2}$/.test(s) ? s : fallback;
    };
    return {
        ENTRY_START: time(process.env.ENTRY_START, DEFAULTS.ENTRY_START),
        ENTRY_END: time(process.env.ENTRY_END, DEFAULTS.ENTRY_END),
        OPTION_FEE_BUY: num(process.env.OPTION_FEE_BUY, DEFAULTS.OPTION_FEE_BUY),
        OPTION_FEE_SELL: num(process.env.OPTION_FEE_SELL, DEFAULTS.OPTION_FEE_SELL),
        RISK_FREE_RATE: num(process.env.RISK_FREE_RATE, DEFAULTS.RISK_FREE_RATE)
    };
}

async function load() {
    const base = envDefaults();
    try {
        const doc = await deps.getDB().collection('meta').findOne({ _id: 'trading_settings' });
        values = { ...base, ...((doc && doc.values) || {}) };
    } catch (e) {
        values = base;
    }
    return values;
}

async function save(partial) {
    const clean = {};
    for (const k of Object.keys(DEFAULTS)) {
        if (partial[k] === undefined || partial[k] === null || partial[k] === '') continue;
        if (k === 'ENTRY_START' || k === 'ENTRY_END') {
            const s = String(partial[k]).trim();
            if (!/^\d{1,2}:\d{2}$/.test(s)) throw new Error(`${k} باید به شکل HH:MM باشد`);
            clean[k] = s;
        } else {
            const n = parseFloat(partial[k]);
            if (!Number.isFinite(n) || n < 0) throw new Error(`${k} باید عدد نامنفی باشد`);
            clean[k] = n;
        }
    }
    const merged = { ...values, ...clean };
    await deps.getDB().collection('meta').updateOne(
        { _id: 'trading_settings' },
        { $set: { values: merged } },
        { upsert: true }
    );
    return load();
}

const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
function get() { return values; }
function entryWindow() {
    return {
        start: toMin(values.ENTRY_START),
        end: toMin(values.ENTRY_END),
        startStr: values.ENTRY_START,
        endStr: values.ENTRY_END
    };
}

module.exports = { init, load, save, get, entryWindow, DEFAULTS };