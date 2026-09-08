(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.TradingStrategies = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    // ---------------- زمان تهران ----------------
    function getTehranParts(date) {
        const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const map = {}; fmt.formatToParts(date).forEach(p => { map[p.type] = p.value; });
        return { year: +map.year, month: +map.month, day: +map.day, hour: (+map.hour) % 24, minute: +map.minute, second: +map.second };
    }
    function tehranPartsToUTC(y, mo, d, h, mi, s) { return new Date(Date.UTC(y, mo - 1, d, h, mi, s || 0) - 3.5 * 3600 * 1000); }
    function minuteOfDay(timeSec) { const t = getTehranParts(new Date(timeSec * 1000)); return t.hour * 60 + t.minute; }

    const TIMEFRAME_MINUTES = { '1m': 1, '3m': 3, '5m': 5, '10m': 10, '15m': 15, '30m': 30, '1h': 60, '1d': 1440 };

    // ---------------- تجمیع کندل ----------------
    const SESSION_START_MIN = 9 * 60, SESSION_END_MIN = 12 * 60 + 30;
    function expectedBarsFor(bucketStartMin, tfMin) {
        const overlap = Math.max(0, Math.min(bucketStartMin + tfMin, SESSION_END_MIN) - Math.max(bucketStartMin, SESSION_START_MIN));
        return Math.min(tfMin, overlap) || tfMin;
    }
    function aggregateCandles(baseCandles, tfMin) {
        const sorted = [...baseCandles].sort((a, b) => a.time - b.time);
        const map = new Map();
        for (const c of sorted) {
            const t = getTehranParts(new Date(c.time * 1000));
            const b = Math.floor((t.hour * 60 + t.minute) / tfMin) * tfMin;
            const bh = Math.floor(b / 60), bm = b % 60;
            const key = `${t.year}-${t.month}-${t.day}-${bh}-${bm}`;
            if (!map.has(key)) {
                map.set(key, { time: Math.floor(tehranPartsToUTC(t.year, t.month, t.day, bh, bm).getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0, barCount: 1, expectedBars: expectedBarsFor(b, tfMin) });
            } else {
                const x = map.get(key); x.high = Math.max(x.high, c.high); x.low = Math.min(x.low, c.low); x.close = c.close; x.volume += c.volume || 0; x.barCount++;
            }
        }
        return Array.from(map.values()).map(x => ({ ...x, complete: x.barCount >= Math.max(1, x.expectedBars) * 0.6 })).sort((a, b) => a.time - b.time);
    }

    // ---------------- کندل‌ها ----------------
    function calculateHeikinAshi(data) {
        const ha = [];
        for (let i = 0; i < data.length; i++) {
            const c = data[i];
            const close = (c.open + c.high + c.low + c.close) / 4;
            const open = i === 0 ? (c.open + c.close) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
            const high = Math.max(c.high, open, close), low = Math.min(c.low, open, close);
            ha.push({ time: c.time, open, high, low, close, bullish: close > open, complete: c.complete !== false });
        }
        return ha;
    }
    function calculateSimpleCandles(data) { return data.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, bullish: c.close > c.open, complete: c.complete !== false })); }
    function getDisplayCandles(data, candleType) { return candleType === 'simple' ? calculateSimpleCandles(data) : calculateHeikinAshi(data); }
    // کندل HA «قوی»: بدون سایه‌ی پایین (با تلورانس ۰.۱٪)
    function noLowerWick(h) { return h.low >= Math.min(h.open, h.close) * 0.999; }

    // ---------------- اندیکاتورها ----------------
    function calculateRSI(closes, period) {
        const rsi = new Array(closes.length).fill(null); if (closes.length <= period) return rsi;
        let g = 0, l = 0;
        for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
        let ag = g / period, al = l / period;
        rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
        for (let i = period + 1; i < closes.length; i++) {
            const d = closes[i] - closes[i - 1];
            ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period; al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
            rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
        }
        return rsi;
    }
    function calculateEMA(closes, period) {
        const ema = new Array(closes.length).fill(null); if (closes.length < period) return ema;
        let s = 0; for (let i = 0; i < period; i++) s += closes[i];
        ema[period - 1] = s / period; const k = 2 / (period + 1);
        for (let i = period; i < closes.length; i++) ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
        return ema;
    }
    function calculateATR(c, period) {
        const atr = new Array(c.length).fill(null); if (c.length <= period) return atr;
        const tr = c.map((x, i) => i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)));
        let s = 0; for (let i = 1; i <= period; i++) s += tr[i];
        atr[period] = s / period;
        for (let i = period + 1; i < c.length; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
        return atr;
    }

    // ---------------- تایم‌فریم بالا (فیلتر روند، بدون نگاه به آینده) ----------------
    function htfCloseTime(c, htfMin) {
        const t = getTehranParts(new Date(c.time * 1000));
        if (htfMin >= 1440 || (htfMin === 60 && t.hour === 11)) return Math.floor(tehranPartsToUTC(t.year, t.month, t.day, 12, 30).getTime() / 1000);
        return c.time + htfMin * 60;
    }
    function buildHtf(ctx, params) {
        const htf = (ctx && ctx.htfCandles) || [];
        const htfMin = TIMEFRAME_MINUTES[(ctx && ctx.htfTimeframe) || '1d'] || 1440;
        const closes = htf.map(c => c.close);
        const ema = calculateEMA(closes, params.htfEma), rsi = calculateRSI(closes, params.htfRsiPeriod);
        const rows = htf.map((c, i) => {
            let trend = null;
            if (ema[i] !== null && i > 0 && ema[i - 1] !== null && rsi[i] !== null) {
                if (c.close > ema[i] && ema[i] > ema[i - 1] && rsi[i] > 50) trend = 'صعودی';
                else if (c.close < ema[i] && ema[i] < ema[i - 1] && rsi[i] < 50) trend = 'نزولی';
                else trend = 'خنثی';
            }
            return { closeTime: htfCloseTime(c, htfMin), trend, ema: ema[i], rsi: rsi[i] };
        });
        let p = 0;
        return {
            forTime(t) { // آخرین کندل HTF که قبل از این کندل بسته شده است
                while (p + 1 < rows.length && rows[p + 1].closeTime <= t) p++;
                return rows[p] && rows[p].closeTime <= t ? rows[p] : null;
            }
        };
    }
    function inEntryWindow(timeSec, w) {
        if (!w) return true;
        const m = minuteOfDay(timeSec); if (m === 0) return true; // کندل روزانه
        return m >= w.start && m <= w.end;
    }
    const round = v => (v === null || v === undefined) ? null : Math.round(v * 100) / 100;

    // ==========================================================
    // استراتژی ۱: پولبک RSI در روند (مدل کانرز) — فقط کال
    // ==========================================================
    const RSI_DEFAULTS = { rsiFastPeriod: 2, rsiSlowPeriod: 50, rsiOversold: 10, rsiOverbought: 80, lookback: 3, maxHoldBars: 10, cooldownBars: 2, atrPeriod: 14, atrMult: 2, requireNoLowerWick: 0, htfEma: 20, htfRsiPeriod: 14 };

    function runRSIPullback(candles, params, ctx) {
        const p = { ...RSI_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const rsiFast = calculateRSI(closes, p.rsiFastPeriod), rsiSlow = calculateRSI(closes, p.rsiSlowPeriod), atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i], hp = ha[i - 1];
            const row = htf.forTime(c.time), trend = row ? row.trend : null; if (trend) lastTrend = trend;
            const ind = { rsiFast: round(rsiFast[i]), rsiSlow: round(rsiSlow[i]), atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            let signalType = null, reason = null;

            if (rsiFast[i] === null || rsiSlow[i] === null || atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

            if (position === 'LONG') {
                const bars = i - entry.idx;
                if (rsiFast[i] >= p.rsiOverbought) reason = `RSI${p.rsiFastPeriod} به ${rsiFast[i].toFixed(0)} رسید (اشباع خرید)`;
                else if (c.close < entry.stop) reason = `شکست حد ضرر ATR (${Math.round(entry.stop).toLocaleString()})`;
                else if (!h.bullish && hp && !hp.bullish) reason = 'دو کندل HA نزولی متوالی';
                else if (trend === 'نزولی') reason = `روند ${htfName} نزولی شد`;
                else if (bars >= p.maxHoldBars) reason = `سقف زمانی ${p.maxHoldBars} کندل`;
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1]; if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && rsiSlow[i] > 50 && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    let dipped = false;
                    for (let k = Math.max(0, i - p.lookback); k < i; k++) if (rsiFast[k] !== null && rsiFast[k] <= p.rsiOversold) dipped = true;
                    const flip = h.bullish && ((hp && !hp.bullish) || (rsiFast[i - 1] !== null && rsiFast[i - 1] <= p.rsiOversold)); // تغییر وضعیت، نه وضعیت
                    const strong = !p.requireNoLowerWick || noLowerWick(h);
                    if (dipped && flip && strong && rsiFast[i] > p.rsiOversold) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: c.close, stop: c.close - p.atrMult * atr[i] };
                        ind.stop = round(entry.stop);
                        reason = `پولبک RSI${p.rsiFastPeriod} در روند صعودی ${htfName} + برگشت کندل به صعودی`;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice: c.close, stop: entry.stop, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==========================================================
    // استراتژی ۲: پولبک به EMA در روند (EMA 25/50/100) — فقط کال
    // ==========================================================
    const EMA_DEFAULTS = { emaFast: 25, emaMid: 50, emaSlow: 100, pullbackPct: 1, lookback: 5, exitBufferPct: 0.5, maxHoldBars: 40, cooldownBars: 3, atrPeriod: 14, atrMult: 2.5, requireNoLowerWick: 1, htfEma: 20, htfRsiPeriod: 14 };

    function runEMAPullback(candles, params, ctx) {
        const p = { ...EMA_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const eF = calculateEMA(closes, p.emaFast), eM = calculateEMA(closes, p.emaMid), eS = calculateEMA(closes, p.emaSlow), atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i], hp = ha[i - 1];
            const row = htf.forTime(c.time), trend = row ? row.trend : null; if (trend) lastTrend = trend;
            const ind = { emaFast: round(eF[i]), emaMid: round(eM[i]), emaSlow: round(eS[i]), atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            let signalType = null, reason = null;

            if (eF[i] === null || eM[i] === null || eS[i] === null || atr[i] === null || i === 0 || eS[i - 1] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

            if (position === 'LONG') {
                entry.stop = Math.max(entry.stop, c.close - p.atrMult * atr[i]); // حد ضرر تریلینگ
                ind.stop = round(entry.stop);
                const bars = i - entry.idx;
                if (c.close < entry.stop) reason = `شکست حد ضرر تریلینگ (${Math.round(entry.stop).toLocaleString()})`;
                else if (c.close < eF[i] * (1 - p.exitBufferPct / 100) && !h.bullish) reason = `بسته‌شدن زیر EMA${p.emaFast} (بافر ${p.exitBufferPct}٪) با کندل نزولی`;
                else if (eF[i] < eM[i]) reason = `هم‌ترازی EMA شکست (EMA${p.emaFast} < EMA${p.emaMid})`;
                else if (trend === 'نزولی') reason = `روند ${htfName} نزولی شد`;
                else if (bars >= p.maxHoldBars) reason = `سقف زمانی ${p.maxHoldBars} کندل`;
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1]; if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else {
                    const aligned = eF[i] > eM[i] && eM[i] > eS[i] && eS[i] >= eS[i - 1];
                    if (trend === 'صعودی' && aligned && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                        let pulled = false;
                        for (let k = Math.max(0, i - p.lookback); k <= i; k++) if (eF[k] !== null && candles[k].low <= eF[k] * (1 + p.pullbackPct / 100)) pulled = true;
                        const flip = h.bullish && hp && !hp.bullish;
                        const strong = !p.requireNoLowerWick || noLowerWick(h);
                        if (pulled && flip && strong && c.close > eF[i]) {
                            position = 'LONG'; signalType = 'BUY';
                            entry = { idx: i, price: c.close, stop: c.close - p.atrMult * atr[i] };
                            ind.stop = round(entry.stop);
                            reason = `پولبک به EMA${p.emaFast} در روند صعودی ${htfName} + کندل صعودی${p.requireNoLowerWick ? ' بدون سایه' : ''}`;
                            trades.push({ type: 'خرید', entryDate: c.time, entryPrice: c.close, stop: entry.stop, reason });
                        }
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ---------------- تعریف استراتژی‌ها ----------------
    const STRATEGIES = {
        rsi50_2: {
            id: 'rsi50_2', name: 'پولبک RSI در روند', defaultTimeframe: '30m', htfTimeframe: '1d',
            defaultParams: RSI_DEFAULTS,
            indicators: { overlay: [], panel: ['rsiFast', 'rsiSlow'] },
            run: runRSIPullback
        },
        ema_heikin: {
            id: 'ema_heikin', name: 'پولبک EMA 25/50/100', defaultTimeframe: '15m', htfTimeframe: '1d',
            defaultParams: EMA_DEFAULTS,
            indicators: { overlay: ['emaFast', 'emaMid', 'emaSlow'], panel: [] },
            run: runEMAPullback
        }
    };

    function getRequiredCandles(id, params) {
        const p = { ...(STRATEGIES[id] ? STRATEGIES[id].defaultParams : {}), ...(params || {}) };
        if (id === 'rsi50_2') return Math.max(p.rsiSlowPeriod, p.atrPeriod) + p.lookback + 2;
        if (id === 'ema_heikin') return Math.max(p.emaSlow, p.atrPeriod) + p.lookback + 2;
        return 10;
    }
    function getRequiredHtfCandles(id, params) {
        const p = { ...(STRATEGIES[id] ? STRATEGIES[id].defaultParams : {}), ...(params || {}) };
        return Math.max(p.htfEma || 20, p.htfRsiPeriod || 14) + 2;
    }

    return {
        calculateHeikinAshi, calculateSimpleCandles, getDisplayCandles,
        calculateRSI, calculateEMA, calculateATR,
        aggregateCandles, TIMEFRAME_MINUTES, getRequiredCandles, getRequiredHtfCandles,
        runRSIPullback, runEMAPullback, STRATEGIES
    };
});