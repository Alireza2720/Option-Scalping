// ======================== option.js (کامل و نهایی) ========================
'use strict';
const fetch = require('node-fetch');
const Settings = require('./settings.js');

let deps = null;
function init(d) { deps = d; }

const OPTIONS_URL = process.env.OPTIONS_API_URL || 'https://s3.optionschool24.com/last?type=3';
const TRADING_DAYS = 245;

let RISK_FREE = +(process.env.RISK_FREE_RATE || 0.23);
let FEE_BUY = +(process.env.OPTION_FEE_BUY || 0.0012);
let FEE_SELL = +(process.env.OPTION_FEE_SELL || 0.0012);

function reloadFromSettings() {
    const s = Settings.get();
    RISK_FREE = s.RISK_FREE_RATE;
    FEE_BUY = s.OPTION_FEE_BUY;
    FEE_SELL = s.OPTION_FEE_SELL;
}

// ---------------- تنظیمات پیش‌فرض آپشن ----------------
// نکته: snapshotTtlDays حذف شد (مرده بود)
const DEFAULT_SETTINGS = {
    minDays: 20, maxDays: 90,
    maxSpreadPct: 10,          // ۸ → ۱۰
    minOI: 500,                // ۱۰۰ → ۵۰۰
    minTrades: 5,              // ۱ → ۵
    minPremium: 300,           // بدون تغییر
    deltaMin: 0.35, deltaMax: 0.85,
    maxIvHv: 1.4,              // ۱.۶ → ۱.۴
    rewardRisk: 2.0,           // ۱.۵ → ۲
    topN: 3,
    optionStopPct: 30,         // ۴۰ → ۳۰
    take1Pct: 50, take2Pct: 100,
    closeDaysBefore: 7
};

let settingsCache = null;
async function getSettings(force) {
    if (settingsCache && !force) return settingsCache;
    const doc = await deps.getDB().collection('meta').findOne({ _id: 'option_settings' });
    settingsCache = { ...DEFAULT_SETTINGS, ...((doc && doc.values) || {}) };
    return settingsCache;
}
async function saveSettings(values) {
    const clean = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (values[k] !== undefined && Number.isFinite(+values[k])) clean[k] = +values[k];
    }
    await deps.getDB().collection('meta').updateOne({ _id: 'option_settings' }, { $set: { values: clean } }, { upsert: true });
    return getSettings(true);
}

// ---------------- نرمال‌سازی و پارس ----------------
const norm = s => String(s || '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[\u200c\u200f\s]/g, '').trim();
const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const first = s => num(String(s || '').split('/')[0]);

// تبدیل درصد به اعشار: اگر بزرگ‌تر از ۳ باشد درصد است (۲۵ → ۰.۲۵)، در غیر این صورت از قبل اعشار است (۰.۲۵)
const asDecimal = v => {
    const n = num(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 3 ? n / 100 : n;
};

// ---------------- پارس قرارداد آپشن ----------------
// نگاشت دقیق فیلدهای API:
//   imp   = نوسان ضمنی (Implied Volatility)  → ivApi
//   sigma = نوسان تاریخی (Historical Volatility) → hvApi
//   black_sholes = قیمت نظری BS از API
//   delta/gamma/theta/vega = یونانی‌های API
function parseContract(r) {
    const fname = r.fname || '';
    const isPut = /^اخت[يی]ارف/.test(fname), isCallName = /^اخت[يی]ارخ/.test(fname);
    return {
        symbol: r.name, fullName: fname, isin: r.co,
        isCall: isCallName || (!isPut && r.type === 1),
        underlying: norm(r.basis_name), underlyingRaw: r.basis_name,
        S: num(r.basis), strike: num(r.emal),
        expiry: r.to_date, daysLeft: num(r.day_left), tradingDaysLeft: num(r.days_left_actual),
        last: num(r.close), final: num(r.final), yday: num(r.yday),
        bid: first(r.b_price), bidVol: first(r.b_volume),
        ask: first(r.s_price), askVol: first(r.s_volume),
        volume: num(r.Tvolume), value: num(r.Tvalue), trades: num(r.Tcount),
        oi: num(r.op), oiChange: num(r.op_change),
        bsApi: num(r.black_sholes),
        ivApi: asDecimal(r.imp),      // ✅ imp = IV (نوسان ضمنی)
        hvApi: asDecimal(r.sigma),    // ✅ sigma = HV (نوسان تاریخی)
        deltaApi: num(r.delta), gammaApi: num(r.gamma),
        thetaApi: num(r.theta), vegaApi: num(r.vega),
        size: num(r.size) || 1000, margin: num(r.tazmin),
        intrinsic: num(r.value), statusText: r.status_text || ''
    };
}

// ---------------- بلک‌شولز ----------------
function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x >= 0 ? 1 - p : p;
}
function bsCall(S, K, T, r, sig) {
    if (T <= 0 || sig <= 0) {
        const v = Math.max(S - K * Math.exp(-r * Math.max(T, 0)), 0);
        return { price: v, delta: S > K ? 1 : 0, thetaDay: 0, vega: 0, gamma: 0 };
    }
    const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r + sig * sig / 2) * T) / (sig * sq), d2 = d1 - sig * sq;
    const Nd1 = normCdf(d1), Nd2 = normCdf(d2), pdf = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
    return {
        price: S * Nd1 - K * Math.exp(-r * T) * Nd2,
        delta: Nd1,
        gamma: pdf / (S * sig * sq),
        thetaDay: (-(S * pdf * sig) / (2 * sq) - r * K * Math.exp(-r * T) * Nd2) / 365,
        vega: S * pdf * sq / 100
    };
}
function impliedVol(price, S, K, T, r) {
    if (!(price > 0) || T <= 0) return null;
    if (price <= Math.max(S - K * Math.exp(-r * T), 0) * 1.001) return null;
    let lo = 0.01, hi = 5;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (bsCall(S, K, T, r, m).price > price) hi = m; else lo = m; }
    return (lo + hi) / 2;
}
async function hvFromDaily(symbol, n = 20) {
    const rows = await deps.getDB().collection('candles_daily').find({ symbol }).sort({ time: -1 }).limit(n + 1).toArray();
    if (rows.length < n + 1) return null;
    const closes = rows.reverse().map(r => r.close).filter(x => x > 0), rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    if (rets.length < 5) return null;
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(v * TRADING_DAYS);
}

// ---------------- دریافت زنجیره (با کش) ----------------
let chainCache = { at: 0, list: [] };
async function fetchChain(maxAgeMs = 60000) {
    if (Date.now() - chainCache.at < maxAgeMs && chainCache.list.length) return chainCache.list;
    const r = await fetch(OPTIONS_URL, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 30000 });
    if (!r.ok) throw new Error(`Options API HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('پاسخ نامعتبر از API آپشن');
    chainCache = { at: Date.now(), list: data.map(parseContract).filter(c => c.symbol && c.strike > 0) };
    return chainCache.list;
}
const chainAge = () => chainCache.at ? Math.round((Date.now() - chainCache.at) / 1000) : null;

// ---------------- متریک‌های یک قرارداد ----------------
function metrics(c, S, hv) {
    const T = Math.max(c.daysLeft, 0.5) / 365;
    const mid = c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : 0;
    const spreadPct = mid > 0 ? (c.ask - c.bid) / mid * 100 : null;

    // HV: اولویت ورودی (محاسبه‌شده از کندل روزانه) → hvApi (sigma) → 0.4
    const vol = hv || c.hvApi || 0.4;

    const theo = bsCall(S, c.strike, T, RISK_FREE, vol);

    // IV: اولویت ivApi (imp) → استخراج از قیمت بازار
    let iv = c.ivApi;
    if (!iv || iv <= 0) {
        iv = impliedVol(c.ask > 0 ? c.ask : c.last, S, c.strike, T, RISK_FREE);
    }

    return {
        T, mid, spreadPct, hv: vol,
        theo: theo.price,
        theoApi: c.bsApi || null,
        delta: theo.delta, deltaApi: c.deltaApi || null,
        gamma: theo.gamma, gammaApi: c.gammaApi || null,
        thetaDay: theo.thetaDay, thetaApi: c.thetaApi || null,
        vega: theo.vega, vegaApi: c.vegaApi || null,
        iv,
        ivApi: c.ivApi || null,
        ivHv: iv ? iv / vol : null,
        leverage: c.ask > 0 ? theo.delta * S / c.ask : null,
        moneynessPct: (S / c.strike - 1) * 100
    };
}

// ---------------- رد دلایل ----------------
function rejectReasons(c, m, s) {
    const R = [];
    if (c.daysLeft < s.minDays) R.push('سررسید نزدیک');
    else if (c.daysLeft > s.maxDays) R.push('سررسید دور');
    if (!(c.bid > 0 && c.ask > 0)) R.push('سفارش دوطرفه ندارد');
    else if (m.spreadPct > s.maxSpreadPct) R.push('اسپرد بالا');
    if (c.oi < s.minOI) R.push('OI کم');
    if (c.trades < s.minTrades) R.push('بدون معامله امروز');
    if (c.ask > 0 && c.ask < s.minPremium) R.push('پرمیوم خیلی کم');
    if (m.delta < s.deltaMin) R.push('دلتا پایین');
    else if (m.delta > s.deltaMax) R.push('دلتا بالا');
    if (m.ivHv && m.ivHv > s.maxIvHv) R.push('IV گران');
    return R;
}
function breakevenMove(S, K, T2, sig, cost, halfSpread) {
    const f = x => Math.max(bsCall(x, K, T2, RISK_FREE, sig).price - halfSpread, 0) * (1 - FEE_SELL) - cost;
    let lo = S * 0.5, hi = S * 2;
    if (f(hi) < 0) return null;
    if (f(lo) > 0) return (lo / S - 1) * 100;
    for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
    return ((lo + hi) / 2 / S - 1) * 100;
}

// ---------------- Position Sizing ----------------
// حجم بر اساس: قدرت سیگنال (RR)، ارزانی IV، نزدیکی stop
function calcPositionSize(pick, scenario, settings) {
    const rrScore = Math.min(1, (pick.rr || 0) / 4);
    const ivScore = pick.ivHv ? Math.min(1, Math.max(0.3, 1.2 / pick.ivHv)) : 0.6;
    const stopDist = scenario.stop && scenario.entry ? Math.abs(scenario.entry - scenario.stop) / scenario.entry : 0.03;
    const stopScore = Math.min(1, 0.03 / Math.max(stopDist, 0.005));
    const score = Math.max(0.3, Math.min(1, (rrScore * 0.4 + ivScore * 0.3 + stopScore * 0.3)));
    return Math.max(1, Math.round(score * 5));
}

// ---------------- انتخاب قرارداد ----------------
function selectCalls(chain, underlying, sc, s) {
    const names = Array.isArray(underlying) ? underlying : [underlying];
    const cands = chain.filter(c => c.isCall && names.includes(c.underlying));
    const rejected = {}, scored = [];
    for (const c of cands) {
        const S = sc.S || c.S, m = metrics(c, S, sc.hv);
        const R = rejectReasons(c, m, s);
        if (R.length) { R.forEach(x => rejected[x] = (rejected[x] || 0) + 1); continue; }
        const h = Math.min(sc.horizonDays, Math.max(c.daysLeft - 1, 1));
        const T2 = Math.max((c.daysLeft - h) / 365, 1 / 365);
        const sig = m.iv || m.hv, cost = c.ask * (1 + FEE_BUY), half = (c.ask - c.bid) / 2;
        const exitAdj = v => Math.max(v - half, 0) * (1 - FEE_SELL);
        const pt = exitAdj(bsCall(sc.target, c.strike, T2, RISK_FREE, sig).price) - cost;
        const pl = exitAdj(bsCall(sc.stop, c.strike, T2, RISK_FREE, sig).price) - cost;
        const pf = exitAdj(bsCall(S, c.strike, T2, RISK_FREE, sig).price) - cost;
        const rr = pl < 0 ? pt / -pl : (pt > 0 ? 99 : 0);
        const liq = Math.pow(Math.min(1, c.oi / 1000), 0.25) * (1 - (m.spreadPct / s.maxSpreadPct) * 0.4);
        const ivPen = m.ivHv ? Math.max(0.6, Math.min(1, 1.3 / m.ivHv)) : 1;
        const pick = {
            symbol: c.symbol, fullName: c.fullName, strike: c.strike, expiry: c.expiry,
            daysLeft: c.daysLeft, ask: c.ask, bid: c.bid, oi: c.oi, volume: c.volume, size: c.size,
            spreadPct: m.spreadPct, theo: m.theo, iv: m.iv, hv: m.hv, ivHv: m.ivHv,
            delta: m.delta, thetaDay: m.thetaDay, leverage: m.leverage,
            profitPct: pt / cost * 100, lossPct: pl / cost * 100, flatPct: pf / cost * 100, rr,
            bePct: breakevenMove(S, c.strike, T2, sig, cost, half),
            score: rr * liq * ivPen, S
        };
        pick.positionSize = calcPositionSize(pick, sc, s);
        scored.push(pick);
    }
    scored.sort((a, b) => b.score - a.score);
    return { picks: scored.slice(0, s.topN), considered: cands.length, passed: scored.length, rejected };
}
function horizonDaysFor(config) {
    const bars = (config.params && config.params.maxHoldBars) || 10;
    const tfMin = deps.TIMEFRAME_MINUTES[config.timeframe] || 30;
    const tradingDays = tfMin >= 1440 ? bars : Math.max(1, Math.ceil(bars * tfMin / 210));
    return Math.max(2, Math.ceil(tradingDays * 7 / 5));
}
async function buildScenario(config, price, liveS, indicators, s) {
    const stop = indicators && indicators.stop, atr = indicators && indicators.atr;
    const risk = stop && stop < price ? price - stop : atr ? 2 * atr : price * 0.03;
    return {
        S: liveS || price,
        entry: price,
        stop: price - risk,
        target: price + risk * s.rewardRisk,
        horizonDays: horizonDaysFor(config),
        hv: await hvFromDaily(config.symbol)
    };
}
const f0 = n => Math.round(n).toLocaleString('en-US');
const pc = v => v === null || v === undefined ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}٪`;

function formatRecommendation(symbol, sc, res, title = '🎯 انتخاب قرارداد کال') {
    let t = `${title} — ${symbol}\nسناریو: ورود ${f0(sc.entry)} | حد ضرر ${f0(sc.stop)} | هدف ${f0(sc.target)} | افق ~${sc.horizonDays} روز${sc.hv ? ` | HV ${(sc.hv * 100).toFixed(0)}٪` : ''}\n`;
    if (!res.picks.length) {
        return t + `⛔ قرارداد مناسبی یافت نشد (${res.considered} بررسی شد)\n` +
            Object.entries(res.rejected).map(([k, v]) => `• ${k}: ${v}`).join('\n');
    }
    res.picks.forEach((p, i) => {
        t += `\n${i + 1}) ${p.symbol} | اعمال ${f0(p.strike)} | ${p.expiry} (${p.daysLeft} روز)\n` +
            `   خرید ${f0(p.ask)} (اسپرد ${p.spreadPct.toFixed(1)}٪) | منصفانه ${f0(p.theo)} | IV ${p.iv ? (p.iv * 100).toFixed(0) + '٪' : '-'}${p.ivHv ? ` (${p.ivHv.toFixed(2)}×HV)` : ''}\n` +
            `   دلتا ${p.delta.toFixed(2)} | اهرم ${p.leverage.toFixed(1)}x | OI ${p.oi} | تتا/روز ${f0(p.thetaDay)} | سربه‌سر تا افق ${pc(p.bePct)}\n` +
            `   هدف ${pc(p.profitPct)} | حد ضرر ${pc(p.lossPct)} | بی‌حرکت ${pc(p.flatPct)} | RR ${p.rr.toFixed(2)} | حجم پیشنهادی ${p.positionSize} قرارداد`;
    });
    const rej = Object.entries(res.rejected);
    if (rej.length) t += `\n\n⛔ رد شده ${res.considered - res.passed}: ` + rej.map(([k, v]) => `${k} ${v}`).join('، ');
    return t;
}

// ---------------- رویداد سیگنال خرید ----------------
async function onBuySignal({ config, indicators, price, liveS, tradeId, confluence = 1 }) {
    const s = await getSettings();
    const chain = await fetchChain(60000);
    const sc = await buildScenario(config, price, liveS, indicators, s);
    const names = deps.getUnderlyingNames ? deps.getUnderlyingNames(config.symbol) : [norm(config.symbol)];
    const res = selectCalls(chain, names, sc, s);

    await deps.notify(formatRecommendation(
        config.symbol, sc, res,
        confluence > 1 ? `🎯 انتخاب قرارداد کال (هم‌گرایی ${confluence} استراتژی)` : undefined
    ));

    if (res.picks.length) {
        const p = res.picks[0];
        const db = deps.getDB();

        // Auto Roll: بستن پوزیشن باز قبلی روی همین configId
        const existing = await db.collection('option_positions').findOne({ configId: config._id.toString(), status: 'open' });
        if (existing) {
            await db.collection('option_positions').updateOne(
                { _id: existing._id },
                { $set: { status: 'closed', exitTime: new Date(), exitReason: 'رول به قرارداد جدید' } }
            );
        }

        await db.collection('option_positions').insertOne({
            configId: config._id.toString(),
            tradeId: tradeId ? tradeId.toString() : null,
            underlying: config.symbol, underlyingNames: names,
            symbol: p.symbol, fullName: p.fullName,
            strike: p.strike, expiry: p.expiry,
            entryTime: new Date(), entryAsk: p.ask, entryBid: p.bid,
            entryS: p.S, entryIv: p.iv, entryDelta: p.delta,
            entryDaysLeft: p.daysLeft, size: p.size,
            positionSize: p.positionSize,
            scenario: sc, paper: true, status: 'open',
            confluence,
            stagedExits: []
        });
    }
    return res;
}

async function recommendForState(config, state) {
    const s = await getSettings();
    const chain = await fetchChain(60000);
    const sc = await buildScenario(config, state.price, state.livePrice, state.indicators, s);
    const names = deps.getUnderlyingNames ? deps.getUnderlyingNames(config.symbol) : [norm(config.symbol)];
    return { scenario: sc, ...selectCalls(chain, names, sc, s) };
}

// ---------------- مدیریت موقعیت‌های باز ----------------
async function managePositions(chain) {
    const db = deps.getDB(), s = await getSettings();
    const open = await db.collection('option_positions').find({ status: 'open' }).toArray();
    if (!open.length) return;

    const map = new Map(chain.map(c => [c.symbol, c]));
    const longIds = new Set(
        (await db.collection('signals_state').find({ position: 'LONG' }).project({ configId: 1 }).toArray())
            .map(x => x.configId)
    );

    for (const p of open) {
        const c = map.get(p.symbol);
        if (!c) {
            if (!p.missingWarned) {
                await deps.notify(`⚠️ قرارداد ${p.symbol} در داده‌ی آپشن یافت نشد.`);
                await db.collection('option_positions').updateOne({ _id: p._id }, { $set: { missingWarned: true } });
            }
            continue;
        }

        const exitPx = c.bid > 0 ? c.bid : c.last;
        const cost = p.entryAsk * (1 + FEE_BUY);
        const pnlPct = (exitPx * (1 - FEE_SELL) / cost - 1) * 100;
        const T = Math.max(c.daysLeft, 0.5) / 365;
        const iv = impliedVol((c.bid > 0 && c.ask > 0) ? (c.bid + c.ask) / 2 : c.last, c.S, c.strike, T, RISK_FREE);
        const spreadPct = c.bid > 0 && c.ask > 0 ? (c.ask - c.bid) / ((c.ask + c.bid) / 2) * 100 : null;

        const upd = {
            lastBid: c.bid, lastAsk: c.ask, lastS: c.S,
            lastPnlPct: pnlPct, lastIv: iv, lastDaysLeft: c.daysLeft,
            lastCheck: new Date()
        };
        let reason = null;

        // Time filter: ۳۰ دقیقه آخر بازار
        const now = new Date();
        const tehranMin = (now.getUTCHours() + 3.5) * 60 + now.getUTCMinutes();
        const isLast30Min = tehranMin >= 12 * 60 && tehranMin <= 12 * 60 + 30;

        // Staged Profit Taking
        const staged = p.stagedExits || [];
        const taken1 = staged.includes(1), taken2 = staged.includes(2);
        if (!reason && pnlPct >= s.take1Pct && !taken1) {
            upd.stagedExits = [...staged, 1];
            await deps.notify(`💰 ${p.symbol} | سود ${pnlPct.toFixed(0)}٪ — فروش ۳۳٪ موقعیت (پله ۱)`);
        }
        if (!reason && pnlPct >= s.take2Pct && !taken2) {
            upd.stagedExits = [...(upd.stagedExits || staged), 2];
            await deps.notify(`💰 ${p.symbol} | سود ${pnlPct.toFixed(0)}٪ — فروش ۳۳٪ موقعیت (پله ۲)`);
        }

        // دلایل بستن کامل
        if (!longIds.has(p.configId)) reason = 'سیگنال خروج / لغو روی سهم پایه';
        else if (c.daysLeft <= s.closeDaysBefore) reason = `${c.daysLeft} روز تا سررسید`;
        else if (pnlPct <= -s.optionStopPct) reason = `حد ضرر آپشن (${pnlPct.toFixed(0)}٪)`;
        else if (pnlPct >= s.take2Pct && taken2) reason = `حد سود کامل (${pnlPct.toFixed(0)}٪)`;

        // هشدارها
        const warns = [];
        if (!reason && pnlPct >= s.take1Pct && !p.take1Notified) {
            warns.push(`💰 سود ${pnlPct.toFixed(0)}٪ — پیشنهاد: فروش نیمی از موقعیت`);
            upd.take1Notified = true;
        }
        if (!reason && p.entryIv && iv && iv < p.entryIv * 0.8 && !p.ivWarned) {
            warns.push(`📉 IV از ${(p.entryIv * 100).toFixed(0)}٪ به ${(iv * 100).toFixed(0)}٪ افت کرد`);
            upd.ivWarned = true;
        }
        if (!reason && spreadPct !== null && spreadPct > 15 && !p.spreadWarned) {
            warns.push(`⚠️ اسپرد ${spreadPct.toFixed(0)}٪ — نقدشوندگی افت کرد`);
            upd.spreadWarned = true;
        }
        if (isLast30Min && !reason && !p.timeWarned) {
            warns.push(`⏰ در ۳۰ دقیقه آخر بازار هستیم — خروج یا ورود جدید توصیه نمی‌شود`);
            upd.timeWarned = true;
        }

        if (reason) {
            Object.assign(upd, {
                status: 'closed', exitTime: new Date(),
                exitBid: exitPx, exitS: c.S, pnlPct, exitReason: reason
            });

            let roll = '';
            if (longIds.has(p.configId) && c.daysLeft <= s.closeDaysBefore && p.scenario) {
                const names = p.underlyingNames && p.underlyingNames.length ? p.underlyingNames : [norm(p.underlying)];
                const r = selectCalls(chain, names, { ...p.scenario, S: c.S }, s);
                if (r.picks.length) {
                    const q = r.picks[0];
                    roll = `\n🔁 پیشنهاد رول: ${q.symbol} اعمال ${f0(q.strike)} سررسید ${q.expiry} (${q.daysLeft} روز) خرید ${f0(q.ask)} دلتا ${q.delta.toFixed(2)}`;
                }
            }

            await deps.notify(
                `🔔 بستن کال ${p.symbol} (${p.underlying})\n` +
                `دلیل: ${reason}\n` +
                `ورود ${f0(p.entryAsk)} → خروج ${f0(exitPx)} | بازده ${pc(pnlPct)} (پس از کارمزد)\n` +
                `سهم پایه: ${f0(p.entryS)} → ${f0(c.S)} (${pc((c.S / p.entryS - 1) * 100)})${roll}`
            );
        } else if (warns.length) {
            await deps.notify(`${p.symbol} (${p.underlying}) | بازده فعلی ${pc(pnlPct)}\n${warns.join('\n')}`);
        }

        await db.collection('option_positions').updateOne({ _id: p._id }, { $set: upd });
    }
}
const openPositionsCount = () => deps.getDB().collection('option_positions').countDocuments({ status: 'open' });

// ---------------- ذخیره‌ی تاریخچه ----------------
const wanted = (c, set) => c.isCall && set.has(c.underlying) && (c.oi > 0 || c.trades > 0);

async function storeSnapshots(chain, monitoredSet) {
    const time = new Date();
    const docs = chain.filter(c => wanted(c, monitoredSet)).map(c => ({
        symbol: c.symbol, underlying: c.underlying, time,
        S: c.S, last: c.last, bid: c.bid, ask: c.ask,
        oi: c.oi, volume: c.volume, trades: c.trades
    }));
    if (docs.length) await deps.getDB().collection('option_snapshots').insertMany(docs, { ordered: false });
    return docs.length;
}

async function storeEOD(chain, monitoredSet) {
    const date = deps.todayDateString(), col = deps.getDB().collection('option_daily');
    let n = 0;
    for (const c of chain.filter(c => wanted(c, monitoredSet))) {
        const m = metrics(c, c.S, null);
        await col.updateOne(
            { symbol: c.symbol, date },
            {
                $set: {
                    symbol: c.symbol, underlying: c.underlying, date,
                    strike: c.strike, expiry: c.expiry, daysLeft: c.daysLeft,
                    S: c.S, last: c.last, final: c.final, bid: c.bid, ask: c.ask,
                    oi: c.oi, volume: c.volume, value: c.value, trades: c.trades,
                    iv: m.iv, delta: m.delta, hvApi: c.hvApi
                }
            },
            { upsert: true }
        );
        n++;
    }
    return n;
}

async function ensureIndexes() {
    const db = deps.getDB();
    await db.collection('option_snapshots').createIndex({ symbol: 1, time: 1 });
    try { await db.collection('option_snapshots').dropIndex('time_1'); } catch (e) {}
    await db.collection('option_snapshots').createIndex({ time: 1 });
    await db.collection('option_daily').createIndex({ symbol: 1, date: 1 }, { unique: true });
    await db.collection('option_daily').createIndex({ underlying: 1, date: 1 });
    await db.collection('option_positions').createIndex({ status: 1, configId: 1 });
}

async function storageStats() {
    const db = deps.getDB(), st = await db.stats();
    const names = ['candles_base', 'candles_daily', 'candles_tf', 'option_snapshots', 'option_daily', 'option_positions', 'signal_history', 'trades', 'telegram_outbox', 'logs'];
    const cols = [];
    for (const n of names) {
        try {
            const c = await db.command({ collStats: n });
            cols.push({
                name: n, count: c.count,
                sizeMB: +(c.size / 1048576).toFixed(2),
                storageMB: +((c.storageSize + c.totalIndexSize) / 1048576).toFixed(2)
            });
        } catch (e) {}
    }
    return {
        dataMB: +(st.dataSize / 1048576).toFixed(1),
        storageMB: +((st.storageSize + st.indexSize) / 1048576).toFixed(1),
        cols
    };
}

function positionStats(list) {
    const closed = list.filter(p => p.status === 'closed' && typeof p.pnlPct === 'number');
    const wins = closed.filter(p => p.pnlPct > 0);
    const sum = a => a.reduce((x, p) => x + p.pnlPct, 0);
    const gp = sum(wins), gl = -sum(closed.filter(p => p.pnlPct <= 0));
    const pf = gl > 0 ? gp / gl : (gp > 0 ? null : 0);  // null به‌جای Infinity برای JSON
    return {
        open: list.length - closed.length,
        closed: closed.length,
        winRate: closed.length ? wins.length / closed.length * 100 : 0,
        avgPnl: closed.length ? sum(closed) / closed.length : 0,
        totalPnl: sum(closed),
        profitFactor: pf,
        avgWin: wins.length ? gp / wins.length : 0,
        avgLoss: closed.length - wins.length ? -gl / (closed.length - wins.length) : 0
    };
}

// ---------------- بک‌تست تقریبی آپشن ----------------
const OPT_BT_DEFAULTS = { assumedMaturityDays: 45, ivMultiplier: 1.0, spreadPct: 5 };

function historicalHV(closes, uptoIndex, n = 20) {
    const start = Math.max(0, uptoIndex - n), slice = closes.slice(start, uptoIndex + 1);
    if (slice.length < 6) return null;
    const rets = [];
    for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]));
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(v * TRADING_DAYS);
}

async function runApproxOptionBacktest(symbol, closedTrades, opts = {}) {
    const p = { ...OPT_BT_DEFAULTS, ...opts };
    const daily = await deps.getDB().collection('candles_daily').find({ symbol }).sort({ time: 1 }).toArray();
    const closes = daily.map(r => r.close);
    const times = daily.map(r => Math.floor(new Date(r.time).getTime() / 1000));

    if (!daily.length) {
        return {
            assumptions: p,
            stats: { count: 0, winRate: 0, avgPnl: 0, totalPnl: 0, profitFactor: null },
            trades: [],
            diagnostic: `کندل روزانه برای ${symbol} وجود ندارد. ابتدا از دکمه‌ی «تاریخچه» در بخش نمادهای زیر نظر استفاده کنید.`
        };
    }
    if (!closedTrades.length) {
        return {
            assumptions: p,
            stats: { count: 0, winRate: 0, avgPnl: 0, totalPnl: 0, profitFactor: null },
            trades: [],
            diagnostic: 'استراتژی سهم پایه هیچ معامله‌ی بسته‌شده‌ای تولید نکرده است. تنظیمات استراتژی را بررسی کنید یا داده‌ی بیشتری جمع کنید.'
        };
    }

    const trades = [];
    for (const t of closedTrades) {
        let idx = -1;
        for (let i = 0; i < times.length; i++) { if (times[i] <= t.entryTime) idx = i; else break; }
        const hv = (idx >= 0 ? historicalHV(closes, idx) : null) || 0.4;
        // استفاده از IV واقعی اگر موجود باشد
        const sigma = t.entryIv && t.entryIv > 0 ? t.entryIv : hv * p.ivMultiplier;
        const daysHeld = Math.max((t.exitTime - t.entryTime) / 86400, 0.1);
        const Tentry = p.assumedMaturityDays / 365;
        const Texit = Math.max(p.assumedMaturityDays - daysHeld, 0.5) / 365;
        const strike = Math.round(t.entryPrice);
        const entryTheo = bsCall(t.entryPrice, strike, Tentry, RISK_FREE, sigma);
        const exitTheo = bsCall(t.exitPrice, strike, Texit, RISK_FREE, sigma);
        const halfSpread = p.spreadPct / 200;
        const entryCost = entryTheo.price * (1 + halfSpread) * (1 + FEE_BUY);
        const exitProceeds = exitTheo.price * (1 - halfSpread) * (1 - FEE_SELL);
        if (!(entryCost > 0)) continue;
        trades.push({
            entryTime: t.entryTime, exitTime: t.exitTime,
            stockEntry: t.entryPrice, stockExit: t.exitPrice,
            strike, hv, entryIv: t.entryIv, sigma,
            entryDelta: entryTheo.delta,
            optionEntry: entryTheo.price, optionExit: exitTheo.price,
            pnlPct: (exitProceeds / entryCost - 1) * 100,
            exitReason: t.exitReason
        });
    }

    const wins = trades.filter(x => x.pnlPct > 0);
    const sum = a => a.reduce((s, x) => s + x.pnlPct, 0);
    const gp = sum(wins), gl = -sum(trades.filter(x => x.pnlPct <= 0));
    const pf = gl > 0 ? gp / gl : (gp > 0 ? null : 0);

    const result = {
        assumptions: p,
        stats: {
            count: trades.length,
            winRate: trades.length ? wins.length / trades.length * 100 : 0,
            avgPnl: trades.length ? sum(trades) / trades.length : 0,
            totalPnl: sum(trades),
            profitFactor: pf
        },
        trades
    };
    if (!trades.length) result.diagnostic = 'هیچ معامله‌ای در بک‌تست تولید نشد (احتمالاً قیمت‌های ورود و خروج یکسان بوده یا داده‌ی کافی نیست).';
    return result;
}

// ---------------- روت‌ها ----------------
function registerRoutes(app, ObjectId) {
    app.get('/api/options/settings', async (req, res, next) => {
        try {
            res.json({
                values: await getSettings(),
                defaults: DEFAULT_SETTINGS,
                fees: { buy: FEE_BUY, sell: FEE_SELL },
                riskFree: RISK_FREE
            });
        } catch (e) { next(e); }
    });
    app.put('/api/options/settings', async (req, res, next) => {
        try { res.json(await saveSettings(req.body || {})); } catch (e) { next(e); }
    });

    app.get('/api/options/chain/:underlying', async (req, res, next) => {
        try {
            const s = await getSettings(), chain = await fetchChain(60000);
            const names = deps.getUnderlyingNames ? deps.getUnderlyingNames(req.params.underlying) : [norm(req.params.underlying)];
            const matched = chain.filter(c => c.isCall && names.includes(c.underlying));
            if (req.query.raw === '1') {
                return res.json({ underlying: req.params.underlying, matchedNames: names, totalMatched: matched.length, raw: matched });
            }
            const hv = await hvFromDaily(req.params.underlying);
            const rows = matched.map(c => { const m = metrics(c, c.S, hv); return { ...c, ...m, reject: rejectReasons(c, m, s) }; })
                .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
            res.json({ underlying: req.params.underlying, matchedNames: names, S: rows[0] ? rows[0].S : null, hv, chainAgeSec: chainAge(), rows });
        } catch (e) { next(e); }
    });

    app.get('/api/options/underlyings', async (req, res, next) => {
        try {
            const chain = await fetchChain(60000), map = new Map();
            chain.filter(c => c.isCall).forEach(c => map.set(c.underlying, (map.get(c.underlying) || 0) + 1));
            res.json({
                count: map.size,
                underlyings: Array.from(map.entries())
                    .map(([underlying, contracts]) => ({ underlying, contracts }))
                    .sort((a, b) => a.underlying.localeCompare(b.underlying))
            });
        } catch (e) { next(e); }
    });

    app.get('/api/options/recommend/:configId', async (req, res, next) => {
        try {
            const db = deps.getDB(), cfg = await db.collection('strategy_configs').findOne({ _id: new ObjectId(req.params.configId) });
            if (!cfg) return res.status(404).json({ error: 'تنظیم یافت نشد' });
            const st = await db.collection('signals_state').findOne({ configId: req.params.configId });
            if (!st || !st.price) return res.status(400).json({ error: 'هنوز وضعیتی برای این تنظیم محاسبه نشده' });
            res.json(await recommendForState(cfg, st));
        } catch (e) { next(e); }
    });

    app.get('/api/options/positions', async (req, res, next) => {
        try {
            const list = await deps.getDB().collection('option_positions').find({}).sort({ entryTime: -1 }).limit(300).toArray();
            res.json({ positions: list, stats: positionStats(list) });
        } catch (e) { next(e); }
    });
    app.delete('/api/options/positions/:id', async (req, res, next) => {
        try {
            await deps.getDB().collection('option_positions').deleteOne({ _id: new ObjectId(req.params.id) });
            res.json({ success: true });
        } catch (e) { next(e); }
    });
    app.get('/api/storage', async (req, res, next) => {
        try { res.json(await storageStats()); } catch (e) { next(e); }
    });
}

module.exports = {
    init, norm, ensureIndexes, registerRoutes, fetchChain,
    storeSnapshots, storeEOD, managePositions, onBuySignal,
    openPositionsCount, storageStats, positionStats,
    getSettings, runApproxOptionBacktest, reloadFromSettings
};