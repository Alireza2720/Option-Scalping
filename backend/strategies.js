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
    function hourFloatOfDay(timeSec) { const t = getTehranParts(new Date(timeSec * 1000)); return t.hour + t.minute / 60; }

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
    function calculateMACD(closes, fast, slow, signal) {
        const emaFast = calculateEMA(closes, fast);
        const emaSlow = calculateEMA(closes, slow);
        const macdLine = new Array(closes.length).fill(null);
        for (let i = 0; i < closes.length; i++) {
            if (emaFast[i] !== null && emaSlow[i] !== null) macdLine[i] = emaFast[i] - emaSlow[i];
        }
        const validMacd = []; const validIdx = [];
        for (let i = 0; i < macdLine.length; i++) {
            if (macdLine[i] !== null) { validMacd.push(macdLine[i]); validIdx.push(i); }
        }
        const signalEma = calculateEMA(validMacd, signal);
        const signalLine = new Array(closes.length).fill(null);
        for (let j = 0; j < validIdx.length; j++) {
            if (signalEma[j] !== null) signalLine[validIdx[j]] = signalEma[j];
        }
        const histogram = new Array(closes.length).fill(null);
        for (let i = 0; i < closes.length; i++) {
            if (macdLine[i] !== null && signalLine[i] !== null) histogram[i] = macdLine[i] - signalLine[i];
        }
        return { macdLine, signalLine, histogram };
    }
    function calculateIchimoku(candles, tenkanP, kijunP, senkouBP) {
        const n = candles.length;
        const tenkan = new Array(n).fill(null);
        const kijun = new Array(n).fill(null);
        const spanA = new Array(n).fill(null);
        const spanB = new Array(n).fill(null);
        function highestHigh(arr, from, to) { let h = -Infinity; for (let i = from; i <= to && i < arr.length; i++) h = Math.max(h, arr[i].high); return h; }
        function lowestLow(arr, from, to) { let l = Infinity; for (let i = from; i <= to && i < arr.length; i++) l = Math.min(l, arr[i].low); return l; }
        for (let i = 0; i < n; i++) {
            if (i >= tenkanP - 1) tenkan[i] = (highestHigh(candles, i - tenkanP + 1, i) + lowestLow(candles, i - tenkanP + 1, i)) / 2;
            if (i >= kijunP - 1) kijun[i] = (highestHigh(candles, i - kijunP + 1, i) + lowestLow(candles, i - kijunP + 1, i)) / 2;
            if (i >= senkouBP - 1) spanB[i] = (highestHigh(candles, i - senkouBP + 1, i) + lowestLow(candles, i - senkouBP + 1, i)) / 2;
            if (tenkan[i] !== null && kijun[i] !== null) spanA[i] = (tenkan[i] + kijun[i]) / 2;
        }
        return { tenkan, kijun, spanA, spanB };
    }

    // ---------------- تایم‌فریم بالا ----------------
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
            forTime(t) {
                while (p + 1 < rows.length && rows[p + 1].closeTime <= t) p++;
                return rows[p] && rows[p].closeTime <= t ? rows[p] : null;
            }
        };
    }
    function inEntryWindow(timeSec, w) {
        if (!w) return true;
        const m = minuteOfDay(timeSec); if (m === 0) return true;
        return m >= w.start && m <= w.end;
    }
    const round = v => (v === null || v === undefined) ? null : Math.round(v * 100) / 100;

    // ==========================================================
    // استراتژی ۱: پولبک RSI در روند (کانرز) — فقط کال
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
                    const flip = h.bullish && ((hp && !hp.bullish) || (rsiFast[i - 1] !== null && rsiFast[i - 1] <= p.rsiOversold));
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
                entry.stop = Math.max(entry.stop, c.close - p.atrMult * atr[i]);
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

    // ==========================================================
    // استراتژی ۳: مومنتوم MACD — فقط کال
    // ==========================================================
    const MACD_DEFAULTS = { macdFast: 12, macdSlow: 26, macdSignal: 9, atrPeriod: 14, atrMult: 2, maxHoldBars: 15, cooldownBars: 2, requireNoLowerWick: 0, htfEma: 20, htfRsiPeriod: 14 };
    function runMACDMomentum(candles, params, ctx) {
        const p = { ...MACD_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, p.atrPeriod);
        const { macdLine, signalLine, histogram } = calculateMACD(closes, p.macdFast, p.macdSlow, p.macdSignal);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i], hp = ha[i - 1];
            const row = htf.forTime(c.time), trend = row ? row.trend : null; if (trend) lastTrend = trend;
            const ind = { macd: round(macdLine[i]), signal: round(signalLine[i]), hist: round(histogram[i]), atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            let signalType = null, reason = null;
            if (macdLine[i] === null || signalLine[i] === null || histogram[i] === null || atr[i] === null || i < 1 || macdLine[i - 1] === null || signalLine[i - 1] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue;
            }
            if (position === 'LONG') {
                const bars = i - entry.idx;
                const deathCross = macdLine[i] < signalLine[i] && macdLine[i - 1] >= signalLine[i - 1];
                const histShrinking = histogram[i] !== null && histogram[i - 1] !== null && histogram[i - 2] !== null &&
                    histogram[i] > 0 && histogram[i] < histogram[i - 1] && histogram[i - 1] < histogram[i - 2];
                if (deathCross) reason = 'کراس نزولی MACD (Death Cross)';
                else if (histShrinking) reason = 'هیستوگرام MACD دو کندل پیاپی کوچک‌شونده';
                else if (c.close < entry.stop) reason = `شکست حد ضرر ATR (${Math.round(entry.stop).toLocaleString()})`;
                else if (trend === 'نزولی') reason = `روند ${htfName} نزولی شد`;
                else if (bars >= p.maxHoldBars) reason = `سقف زمانی ${p.maxHoldBars} کندل`;
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1]; if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const goldenCross = macdLine[i] > signalLine[i] && macdLine[i - 1] <= signalLine[i - 1];
                    const aboveZero = macdLine[i] > 0;
                    const flip = h.bullish && hp && !hp.bullish;
                    const strong = !p.requireNoLowerWick || noLowerWick(h);
                    if (goldenCross && aboveZero && flip && strong) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: c.close, stop: c.close - p.atrMult * atr[i] };
                        ind.stop = round(entry.stop);
                        reason = `کراس صعودی MACD بالای صفر + کندل HA صعودی + روند ${htfName} صعودی`;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice: c.close, stop: entry.stop, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==========================================================
    // استراتژی ۴: ابر ایچیموکو (Ichimoku Cloud) — فقط کال
    // ==========================================================
    const ICHIMOKU_DEFAULTS = { tenkanPeriod: 9, kijunPeriod: 26, senkouBPeriod: 52, maxHoldBars: 20, cooldownBars: 3, atrPeriod: 14, atrMult: 2.5, requireNoLowerWick: 1, htfEma: 20, htfRsiPeriod: 14 };
    function runIchimoku(candles, params, ctx) {
        const p = { ...ICHIMOKU_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const { tenkan, kijun, spanA, spanB } = calculateIchimoku(candles, p.tenkanPeriod, p.kijunPeriod, p.senkouBPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        const minBars = p.senkouBPeriod + 2;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i], hp = ha[i - 1];
            const row = htf.forTime(c.time), trend = row ? row.trend : null; if (trend) lastTrend = trend;
            const ind = { tenkan: round(tenkan[i]), kijun: round(kijun[i]), spanA: round(spanA[i]), spanB: round(spanB[i]), atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            let signalType = null, reason = null;
            if (i < minBars || atr[i] === null || tenkan[i] === null || kijun[i] === null || spanA[i] === null || spanB[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue;
            }
            const cloudTop = Math.max(spanA[i], spanB[i]);
            const cloudBottom = Math.min(spanA[i], spanB[i]);
            const aboveCloud = c.close > cloudTop;
            const belowCloud = c.close < cloudBottom;
            const greenCloud = spanA[i] > spanB[i];
            const tkBullish = tenkan[i] > kijun[i];
            if (position === 'LONG') {
                const bars = i - entry.idx;
                const tkCrossDown = tenkan[i] < kijun[i] && tenkan[i - 1] >= kijun[i - 1];
                if (belowCloud) reason = 'قیمت به زیر ابر Kumo رفت';
                else if (tkCrossDown) reason = 'کراس نزولی Tenkan/Kijun';
                else if (c.close < entry.stop) reason = `شکست حد ضرر ATR (${Math.round(entry.stop).toLocaleString()})`;
                else if (trend === 'نزولی') reason = `روند ${htfName} نزولی شد`;
                else if (bars >= p.maxHoldBars) reason = `سقف زمانی ${p.maxHoldBars} کندل`;
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1]; if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const tkCrossUp = tenkan[i] > kijun[i] && tenkan[i - 1] <= kijun[i - 1];
                    const flip = h.bullish && hp && !hp.bullish;
                    const strong = !p.requireNoLowerWick || noLowerWick(h);
                    if (aboveCloud && greenCloud && tkBullish && flip && strong) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: c.close, stop: c.close - p.atrMult * atr[i] };
                        ind.stop = round(entry.stop);
                        reason = `قیمت بالای ابر سبز Kumo + کراس صعودی Tenkan/Kijun + روند ${htfName} صعودی`;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice: c.close, stop: entry.stop, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==========================================================
    // استراتژی ۵: Smart Money Concepts (SMC) — ICT Unicorn
    // ==========================================================
    const SMC_DEFAULTS = {
        swingLength: 5,
        htfEma: 20,
        htfRsiPeriod: 14,
        fvgMinGapPct: 0.05,
        useOTE: 1,
        oteLow: 0.618,
        oteHigh: 0.786,
        atrPeriod: 14,
        atrMult: 1.5,
        maxHoldBars: 20,
        cooldownBars: 3,
        useBreakEven: 1,
        tp1R: 1,
        tp2R: 2,
        tp3R: 3,
        minLiquiditySweepPct: 0.1,
        requireVolumeFilter: 0,
        useKillzone: 0,
        killzone1Start: 9.5,
        killzone1End: 10.5,
        killzone2Start: 11.5,
        killzone2End: 12.0,
        minConfluence: 2
    };

    function runSMCUnicorn(candles, params, ctx) {
        const p = { ...SMC_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;

        // ---- توابع کمکی داخلی ----
        function findSwingHigh(idx, len) {
            const start = Math.max(0, idx - len);
            let hi = -Infinity, hiIdx = -1;
            for (let i = start; i <= idx; i++) {
                if (candles[i].high > hi) { hi = candles[i].high; hiIdx = i; }
            }
            return { price: hi, idx: hiIdx };
        }
        function findSwingLow(idx, len) {
            const start = Math.max(0, idx - len);
            let lo = Infinity, loIdx = -1;
            for (let i = start; i <= idx; i++) {
                if (candles[i].low < lo) { lo = candles[i].low; loIdx = i; }
            }
            return { price: lo, idx: loIdx };
        }
        function detectBullishFVG(i) {
            if (i < 2) return null;
            const c1 = candles[i - 2], c3 = candles[i];
            if (c3.low > c1.high) {
                const gap = c3.low - c1.high;
                const gapPct = gap / c1.high * 100;
                if (gapPct >= p.fvgMinGapPct) {
                    return { top: c3.low, bottom: c1.high, mid: (c3.low + c1.high) / 2, gap, gapPct, idx: i };
                }
            }
            return null;
        }
        function detectBullishBreaker(i) {
            if (i < p.swingLength) return null;
            const prevSwing = findSwingHigh(i - 1, p.swingLength);
            if (!(candles[i].close > prevSwing.price && closes[i] > closes[i - 1])) return null;
            for (let k = i - 1; k >= Math.max(0, i - 10); k--) {
                if (candles[k].close < candles[k].open) {
                    return {
                        top: candles[k].high,
                        bottom: candles[k].low,
                        mid: (candles[k].high + candles[k].low) / 2,
                        idx: k,
                        bosIdx: i,
                        swingHigh: prevSwing.price
                    };
                }
            }
            return null;
        }
        function detectLiquiditySweep(i) {
            if (i < p.swingLength + 1) return null;
            const prevLow = findSwingLow(i - 1, p.swingLength);
            const c = candles[i], prev = candles[i - 1];
            const swept = (c.low < prevLow.price || prev.low < prevLow.price);
            const reclaimed = c.close > prevLow.price;
            if (swept && reclaimed) {
                const depthPct = (prevLow.price - Math.min(c.low, prev.low)) / prevLow.price * 100;
                if (depthPct >= p.minLiquiditySweepPct) {
                    return { sweptLevel: prevLow.price, depthPct, idx: i, sweepLow: Math.min(c.low, prev.low) };
                }
            }
            return null;
        }
        function calcOTE(swingLow, swingHigh) {
            const range = swingHigh - swingLow;
            return {
                low: swingLow + range * (1 - p.oteHigh),
                high: swingLow + range * (1 - p.oteLow)
            };
        }
        function inKillzone(timeSec) {
            if (!p.useKillzone) return true;
            const h = hourFloatOfDay(timeSec);
            return (h >= p.killzone1Start && h <= p.killzone1End) ||
                   (h >= p.killzone2Start && h <= p.killzone2End);
        }
        function checkVolumeFilter(i) {
            if (!p.requireVolumeFilter) return true;
            const start = Math.max(0, i - 20);
            let sum = 0, count = 0;
            for (let k = start; k < i; k++) { sum += (candles[k].volume || 0); count++; }
            if (!count) return true;
            const avg = sum / count;
            return avg > 0 && (candles[i].volume || 0) >= avg * 1.5;
        }

        // ---- حلقه اصلی ----
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;

            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null, trend: trend || '-' };

            if (i < Math.max(p.swingLength + 3, p.atrPeriod + 2) || atr[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }

            let signalType = null, reason = null;

            // ---- مدیریت موقعیت باز ----
            if (position === 'LONG') {
                const bars = i - entry.idx;
                const R = entry.risk;

                if (c.close < entry.stop) {
                    reason = `شکست حد ضرر (${Math.round(entry.stop).toLocaleString()})`;
                }
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) {
                    entry.tp1Hit = true;
                    if (p.useBreakEven) entry.stop = entry.entry;
                }
                else if (entry.tp1Hit && !entry.tp2Hit && c.close >= entry.entry + R * p.tp2R) {
                    entry.tp2Hit = true;
                }
                else if (entry.tp2Hit && c.close >= entry.entry + R * p.tp3R) {
                    reason = `رسیدن به هدف سوم (${p.tp3R}R)`;
                }
                else if (trend === 'نزولی') {
                    reason = `روند ${htfName} نزولی شد`;
                }
                else if (bars >= p.maxHoldBars) {
                    reason = `سقف زمانی ${p.maxHoldBars} کندل`;
                }

                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) {
                        tr.exitDate = c.time;
                        tr.exitPrice = c.close;
                        tr.pnlPct = (c.close / tr.entryPrice - 1) * 100;
                        tr.exitReason = reason;
                    }
                    entry = null; cooldown = p.cooldownBars;
                }
            }
            // ---- ورود به معامله ----
            else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow) && inKillzone(c.time) && checkVolumeFilter(i)) {
                    const sweep = detectLiquiditySweep(i);
                    const bb = detectBullishBreaker(i);
                    const fvg = detectBullishFVG(i);

                    // شمارش شرط‌ها (حداقل ۲ شرط از ۳)
                    const conditions = [!!sweep, !!bb, !!fvg];
                    const condCount = conditions.filter(Boolean).length;

                    if (condCount >= p.minConfluence) {
                        // ساخت ناحیه ورود از ترکیب شرط‌های موجود
                        let zoneLow = -Infinity, zoneHigh = Infinity;
                        if (bb) { zoneLow = Math.max(zoneLow, Math.min(bb.bottom, bb.top)); zoneHigh = Math.min(zoneHigh, Math.max(bb.bottom, bb.top)); }
                        if (fvg) { zoneLow = Math.max(zoneLow, Math.min(fvg.bottom, fvg.top)); zoneHigh = Math.min(zoneHigh, Math.max(fvg.bottom, fvg.top)); }
                        // اگر sweep-only و zone تعریف نشده، از سوئینگ اخیر استفاده کن
                        if (zoneLow === -Infinity) zoneLow = findSwingLow(i, p.swingLength).price;
                        if (zoneHigh === Infinity) zoneHigh = c.close;

                        if (zoneHigh > zoneLow) {
                            const swingLow = findSwingLow(i, p.swingLength).price;
                            const swingHigh = findSwingHigh(i, p.swingLength).price;
                            const ote = calcOTE(swingLow, swingHigh);
                            const inOTE = !p.useOTE || (zoneLow <= ote.high && zoneHigh >= ote.low);

                            if (inOTE && h.bullish) {
                                position = 'LONG'; signalType = 'BUY';
                                const entryPrice = Math.min(zoneHigh, c.close);
                                let stopPrice;
                                if (sweep) stopPrice = Math.min(zoneLow, sweep.sweepLow);
                                else if (bb) stopPrice = bb.bottom;
                                else stopPrice = zoneLow;
                                stopPrice -= p.atrMult * atr[i];
                                const risk = entryPrice - stopPrice;
                                if (risk <= 0) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

                                entry = {
                                    idx: i, price: entryPrice, stop: stopPrice, risk,
                                    entry: entryPrice, tp1Hit: false, tp2Hit: false,
                                    zoneLow, zoneHigh,
                                    sweepLevel: sweep ? sweep.sweptLevel : null,
                                    oteLow: ote.low, oteHigh: ote.high
                                };
                                ind.stop = round(stopPrice);

                                const parts = [];
                                if (sweep) parts.push('Sweep');
                                if (bb) parts.push('BB');
                                if (fvg) parts.push('FVG');
                                reason = `SMC [${parts.join('+')}]`;
                                if (p.useOTE) reason += ` + OTE`;
                                reason += ` | ${condCount}/3 confluence`;

                                trades.push({
                                    type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk,
                                    tp1R: p.tp1R, tp2R: p.tp2R, tp3R: p.tp3R, reason
                                });
                            }
                        }
                    }
                }
            }

            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }

        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==========================================================
    // استراتژی ۶: ICT Silver Bullet
    // ==========================================================
    const SB_DEFAULTS = {
        htfEma: 20, htfRsiPeriod: 14,
        fvgMinGapPct: 0.05,
        atrPeriod: 14, atrMult: 1.2,
        maxHoldBars: 15, cooldownBars: 2,
        // پنجره‌های Silver Bullet (به ساعت تهران)
        sb1Start: 9.5, sb1End: 10.0,
        sb2Start: 10.5, sb2End: 11.0,
        sb3Start: 11.5, sb3End: 12.0,
        useSessionEndExit: 1,
        requireDisplacement: 1,
        displacementMult: 1.3
    };

    function runSilverBullet(candles, params, ctx) {
        const p = { ...SB_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;

        function inSilverBulletWindow(timeSec) {
            const h = hourFloatOfDay(timeSec);
            return (h >= p.sb1Start && h < p.sb1End) ||
                   (h >= p.sb2Start && h < p.sb2End) ||
                   (h >= p.sb3Start && h < p.sb3End);
        }

        function detectFVG(i) {
            if (i < 2) return null;
            const c1 = candles[i - 2], c3 = candles[i];
            if (c3.low > c1.high) {
                const gap = c3.low - c1.high;
                if (gap / c1.high * 100 >= p.fvgMinGapPct) {
                    return { top: c3.low, bottom: c1.high, gap, idx: i };
                }
            }
            return null;
        }

        function isDisplacement(i, atrVal) {
            if (!p.requireDisplacement) return true;
            const body = Math.abs(candles[i].close - candles[i].open);
            return body >= p.displacementMult * atrVal;
        }

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };

            if (i < Math.max(p.atrPeriod + 3, 5) || atr[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }

            let signalType = null, reason = null;

            if (position === 'LONG') {
                const bars = i - entry.idx;
                if (c.close < entry.stop) reason = `شکست حد ضرر`;
                else if (c.close >= entry.target) reason = `رسیدن به هدف (${entry.rr}R)`;
                else if (p.useSessionEndExit && !inSilverBulletWindow(c.time) && hourFloatOfDay(c.time) > p.sb3End) reason = 'پایان پنجره Silver Bullet';
                else if (trend === 'نزولی') reason = `روند ${htfName} نزولی شد`;
                else if (bars >= p.maxHoldBars) reason = `سقف زمانی ${p.maxHoldBars} کندل`;

                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow) && inSilverBulletWindow(c.time)) {
                    const fvg = detectFVG(i);
                    if (fvg && isDisplacement(i - 1, atr[i - 1]) && h.bullish) {
                        const entryPrice = fvg.top;
                        const stopPrice = fvg.bottom - p.atrMult * atr[i];
                        const risk = entryPrice - stopPrice;
                        if (risk <= 0) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
                        const target = entryPrice + risk * 2.5;

                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, target, rr: 2.5, fvgTop: fvg.top, fvgBottom: fvg.bottom };
                        ind.stop = round(stopPrice);

                        reason = `ICT Silver Bullet: FVG retest + displacement`;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, target, reason });
                    }
                }
            }

            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==========================================================
    // استراتژی ۷: Order Block + Liquidity Sweep
    // ==========================================================
    const OB_DEFAULTS = {
        swingLength: 5,
        htfEma: 20, htfRsiPeriod: 14,
        atrPeriod: 14, atrMult: 1.5,
        maxHoldBars: 25, cooldownBars: 3,
        tp1R: 1.5, tp2R: 2.5,
        obLookback: 10,
        minSweepPct: 0.05
    };

    function runOBSweep(candles, params, ctx) {
        const p = { ...OB_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;

        function findSwingLow(idx, len) {
            const start = Math.max(0, idx - len);
            let lo = Infinity, loIdx = -1;
            for (let i = start; i <= idx; i++) { if (candles[i].low < lo) { lo = candles[i].low; loIdx = i; } }
            return { price: lo, idx: loIdx };
        }
        function findSwingHigh(idx, len) {
            const start = Math.max(0, idx - len);
            let hi = -Infinity, hiIdx = -1;
            for (let i = start; i <= idx; i++) { if (candles[i].high > hi) { hi = candles[i].high; hiIdx = i; } }
            return { price: hi, idx: hiIdx };
        }

        function detectSweep(i) {
            if (i < p.swingLength + 1) return null;
            const prevLow = findSwingLow(i - 1, p.swingLength);
            const c = candles[i], prev = candles[i - 1];
            if ((c.low < prevLow.price || prev.low < prevLow.price) && c.close > prevLow.price) {
                const depth = (prevLow.price - Math.min(c.low, prev.low)) / prevLow.price * 100;
                if (depth >= p.minSweepPct) return { sweptLevel: prevLow.price, sweepLow: Math.min(c.low, prev.low), idx: i };
            }
            return null;
        }

        function findOrderBlock(i) {
            for (let k = i - 1; k >= Math.max(0, i - p.obLookback); k--) {
                if (candles[k].close < candles[k].open) {
                    const isBigEnough = Math.abs(candles[k].close - candles[k].open) > atr[k] * 0.5;
                    if (isBigEnough) return { top: candles[k].high, bottom: candles[k].low, idx: k };
                }
            }
            return null;
        }

        function detectMSS(i) {
            if (i < p.swingLength) return null;
            const prevHigh = findSwingHigh(i - 1, p.swingLength);
            if (candles[i].close > prevHigh.price && closes[i] > closes[i - 1]) {
                return { level: prevHigh.price, idx: i };
            }
            return null;
        }

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };

            if (i < Math.max(p.swingLength + 3, p.atrPeriod + 2) || atr[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }

            let signalType = null, reason = null;

            if (position === 'LONG') {
                const bars = i - entry.idx;
                const R = entry.risk;
                if (c.close < entry.stop) reason = `شکست حد ضرر (${Math.round(entry.stop).toLocaleString()})`;
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = `رسیدن به هدف دوم (${p.tp2R}R)`;
                else if (trend === 'نزولی') reason = `روند ${htfName} نزولی شد`;
                else if (bars >= p.maxHoldBars) reason = `سقف زمانی`;

                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const sweep = detectSweep(i);
                    const mss = detectMSS(i);
                    const ob = findOrderBlock(i);

                    if (sweep && mss && ob && h.bullish) {
                        const entryPrice = ob.top;
                        const stopPrice = Math.min(ob.bottom, sweep.sweepLow) - p.atrMult * atr[i];
                        const risk = entryPrice - stopPrice;
                        if (risk <= 0) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false, obTop: ob.top, obBottom: ob.bottom };
                        ind.stop = round(stopPrice);

                        reason = `OB+Sweep: Liquidity Sweep + MSS + Order Block`;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, tp1R: p.tp1R, tp2R: p.tp2R, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }
    // ==========================================================
    // استراتژی ۸: Ensemble (رأی‌گیری وزنی از ۷ استراتژی)
    // منطق: هر استراتژی یه وزن بر اساس PF×WinRate داره
    // وقتی مجموع وزن BUY از آستانه بگذره + حداقل N استراتژی موافق، بخر
    // ==========================================================
    const ENSEMBLE_DEFAULTS = {
        threshold: 1.5,
        minAgree: 2,
        wRsi: 0.70,
        wEma: 0.88,
        wMacd: 0.59,
        wIchimoku: 0.75,
        wSmc: 1.38,
        wSilver: 1.05,
        wOb: 0.52,
        cooldownBars: 3,
        maxHoldBars: 30,
        atrPeriod: 14,
        atrMult: 2.0,
        htfEma: 20,
        htfRsiPeriod: 14
    };

    function runEnsemble(candles, params, ctx) {
        const p = { ...ENSEMBLE_DEFAULTS, ...(params || {}) };
        const subStrategies = [
            { id: 'rsi50_2', weight: p.wRsi, run: runRSIPullback, defaults: RSI_DEFAULTS },
            { id: 'ema_heikin', weight: p.wEma, run: runEMAPullback, defaults: EMA_DEFAULTS },
            { id: 'macd_momentum', weight: p.wMacd, run: runMACDMomentum, defaults: MACD_DEFAULTS },
            { id: 'ichimoku_cloud', weight: p.wIchimoku, run: runIchimoku, defaults: ICHIMOKU_DEFAULTS },
            { id: 'smc_unicorn', weight: p.wSmc, run: runSMCUnicorn, defaults: SMC_DEFAULTS },
            { id: 'silver_bullet', weight: p.wSilver, run: runSilverBullet, defaults: SB_DEFAULTS },
            { id: 'ob_sweep', weight: p.wOb, run: runOBSweep, defaults: OB_DEFAULTS }
        ];

        const subCtx = { ...ctx, entryWindow: ctx && ctx.entryWindow };
        const results = {};
        for (const sub of subStrategies) {
            try {
                const subParams = {
                    ...sub.defaults,
                    candleType: p.candleType,
                    htfEma: p.htfEma,
                    htfRsiPeriod: p.htfRsiPeriod
                };
                results[sub.id] = sub.run(candles, subParams, subCtx);
            } catch (e) {
                results[sub.id] = { signals: [], trades: [], htfTrend: null, ha: [] };
            }
        }

        const n = candles.length;
        const atr = calculateATR(candles, p.atrPeriod);
        const firstHa = results.rsi50_2.ha && results.rsi50_2.ha.length ? results.rsi50_2.ha : getDisplayCandles(candles, p.candleType || 'heikin');
        const signals = [];
        const trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;

        for (let i = 0; i < n; i++) {
            const c = candles[i];
            let buyWeight = 0, buyCount = 0, exitWeight = 0, exitCount = 0;
            const voters = [];

            for (const sub of subStrategies) {
                const subSigs = results[sub.id].signals;
                if (!subSigs || !subSigs[i]) continue;
                const s = subSigs[i];
                if (s.signalType === 'BUY') {
                    buyWeight += sub.weight;
                    buyCount++;
                    voters.push(`${sub.id}(${sub.weight.toFixed(2)})`);
                } else if (s.signalType === 'EXIT_LONG') {
                    exitWeight += sub.weight;
                    exitCount++;
                }
            }

            for (const sub of subStrategies) {
                if (results[sub.id].htfTrend) { lastTrend = results[sub.id].htfTrend; break; }
            }

            const ind = {
                stop: entry ? round(entry.stop) : null,
                buyWeight: round(buyWeight),
                exitWeight: round(exitWeight)
            };
            let signalType = null, reason = null;

            if (position === 'LONG') {
                const bars = i - entry.idx;
                if (exitWeight >= p.threshold && exitCount >= p.minAgree) {
                    reason = `Ensemble EXIT: ${exitCount} استراتژی موافق (وزن ${exitWeight.toFixed(2)})`;
                } else if (c.close < entry.stop) {
                    reason = `شکست حد ضرر (${Math.round(entry.stop).toLocaleString()})`;
                } else if (bars >= p.maxHoldBars) {
                    reason = `سقف زمانی ${p.maxHoldBars} کندل`;
                }
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) {
                        tr.exitDate = c.time;
                        tr.exitPrice = c.close;
                        tr.pnlPct = (c.close / tr.entryPrice - 1) * 100;
                        tr.exitReason = reason;
                    }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (buyWeight >= p.threshold && buyCount >= p.minAgree && atr[i] !== null) {
                    position = 'LONG'; signalType = 'BUY';
                    const stopPrice = c.close - p.atrMult * atr[i];
                    entry = { idx: i, price: c.close, stop: stopPrice };
                    ind.stop = round(stopPrice);
                    reason = `Ensemble BUY: ${buyCount} استراتژی (وزن ${buyWeight.toFixed(2)}) | ${voters.join(', ')}`;
                    trades.push({
                        type: 'خرید', entryDate: c.time, entryPrice: c.close, stop: stopPrice,
                        reason, buyWeight, buyCount
                    });
                }
            }

            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }

        return { ha: firstHa, signals, trades, htfTrend: lastTrend };
    }
    // ---------------- تعریف استراتژی‌ها ----------------
    const STRATEGIES = {
        rsi50_2: {
            id: 'rsi50_2', name: 'RSI', defaultTimeframe: '30m', htfTimeframe: '1d',
            defaultParams: RSI_DEFAULTS,
            indicators: { overlay: [], panel: ['rsiFast', 'rsiSlow'] },
            run: runRSIPullback
        },
        ema_heikin: {
            id: 'ema_heikin', name: 'EMA', defaultTimeframe: '15m', htfTimeframe: '1d',
            defaultParams: EMA_DEFAULTS,
            indicators: { overlay: ['emaFast', 'emaMid', 'emaSlow'], panel: [] },
            run: runEMAPullback
        },
        macd_momentum: {
            id: 'macd_momentum', name: 'MACD', defaultTimeframe: '15m', htfTimeframe: '1d',
            defaultParams: MACD_DEFAULTS,
            indicators: { overlay: [], panel: ['macd', 'signal', 'hist'] },
            run: runMACDMomentum
        },
        ichimoku_cloud: {
            id: 'ichimoku_cloud', name: 'Ichimoku', defaultTimeframe: '30m', htfTimeframe: '1d',
            defaultParams: ICHIMOKU_DEFAULTS,
            indicators: { overlay: ['tenkan', 'kijun'], panel: [] },
            run: runIchimoku
        },
        smc_unicorn: {
            id: 'smc_unicorn', name: 'SMC Unicorn', defaultTimeframe: '1h', htfTimeframe: '1d',
            defaultParams: SMC_DEFAULTS,
            indicators: { overlay: ['stop'], panel: [] },
            run: runSMCUnicorn
        },
        silver_bullet: {
            id: 'silver_bullet', name: 'ICT Silver Bullet', defaultTimeframe: '15m', htfTimeframe: '1d',
            defaultParams: SB_DEFAULTS,
            indicators: { overlay: ['stop'], panel: [] },
            run: runSilverBullet
        },
        ob_sweep: {
            id: 'ob_sweep', name: 'OB + Sweep', defaultTimeframe: '1h', htfTimeframe: '1d',
            defaultParams: OB_DEFAULTS,
            indicators: { overlay: ['stop'], panel: [] },
            run: runOBSweep
        },
        ensemble: {
            id: 'ensemble', name: 'Ensemble (ترکیبی)', defaultTimeframe: '30m', htfTimeframe: '1d',
            defaultParams: ENSEMBLE_DEFAULTS,
            indicators: { overlay: ['stop'], panel: [] },
            run: runEnsemble
        }
    };

    function getRequiredCandles(id, params) {
        const p = { ...(STRATEGIES[id] ? STRATEGIES[id].defaultParams : {}), ...(params || {}) };
        if (id === 'rsi50_2') return Math.max(p.rsiSlowPeriod, p.atrPeriod) + p.lookback + 2;
        if (id === 'ema_heikin') return Math.max(p.emaSlow, p.atrPeriod) + p.lookback + 2;
        if (id === 'macd_momentum') return Math.max(p.macdSlow, p.macdSignal, p.atrPeriod) + 5;
        if (id === 'ichimoku_cloud') return Math.max(p.senkouBPeriod, p.atrPeriod) + 3;
        if (id === 'smc_unicorn') return Math.max(p.swingLength + 5, p.atrPeriod + 3, p.maxHoldBars);
        if (id === 'silver_bullet') return Math.max(p.atrPeriod + 5, 10);
        if (id === 'ob_sweep') return Math.max(p.swingLength + p.obLookback + 5, p.atrPeriod + 3, p.maxHoldBars);
        if (id === 'ensemble') return 100; // چون همه‌ی زیراستراتژی‌ها رو اجرا می‌کنه، بیشترین نیاز رو داره
        return 10;
    }
    function getRequiredHtfCandles(id, params) {
        const p = { ...(STRATEGIES[id] ? STRATEGIES[id].defaultParams : {}), ...(params || {}) };
        return Math.max(p.htfEma || 20, p.htfRsiPeriod || 14) + 2;
    }

    return {
        calculateHeikinAshi, calculateSimpleCandles, getDisplayCandles,
        calculateRSI, calculateEMA, calculateATR, calculateMACD, calculateIchimoku,
        aggregateCandles, TIMEFRAME_MINUTES, getRequiredCandles, getRequiredHtfCandles,
        runRSIPullback, runEMAPullback, runMACDMomentum, runIchimoku,
        runSMCUnicorn, runSilverBullet, runOBSweep, runEnsemble,
        RSI_DEFAULTS, EMA_DEFAULTS, MACD_DEFAULTS, ICHIMOKU_DEFAULTS,
        SMC_DEFAULTS, SB_DEFAULTS, OB_DEFAULTS, ENSEMBLE_DEFAULTS,
        STRATEGIES
    };
});