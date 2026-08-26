(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TradingStrategies = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {

    function getTehranParts(date) {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Tehran',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });
        const parts = fmt.formatToParts(date);
        const map = {};
        parts.forEach(p => { map[p.type] = p.value; });
        return {
            year: parseInt(map.year, 10), month: parseInt(map.month, 10), day: parseInt(map.day, 10),
            hour: parseInt(map.hour, 10), minute: parseInt(map.minute, 10), second: parseInt(map.second, 10)
        };
    }

    function tehranPartsToUTC(year, month, day, hour, minute, second) {
        return new Date(Date.UTC(year, month - 1, day, hour, minute, second || 0) - (3.5 * 60 * 60 * 1000));
    }

    const TIMEFRAME_MINUTES = { '3m': 3, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };

    function aggregateCandles(baseCandles, timeframeMinutes) {
        const sorted = [...baseCandles].sort((a, b) => a.time - b.time);
        const map = new Map();
        for (const c of sorted) {
            const t = getTehranParts(new Date(c.time * 1000));
            const minuteOfDay = t.hour * 60 + t.minute;
            const bucketStart = Math.floor(minuteOfDay / timeframeMinutes) * timeframeMinutes;
            const bucketHour = Math.floor(bucketStart / 60);
            const bucketMinute = bucketStart % 60;
            const key = `${t.year}-${t.month}-${t.day}-${bucketHour}-${bucketMinute}`;

            if (!map.has(key)) {
                const bucketTime = Math.floor(tehranPartsToUTC(t.year, t.month, t.day, bucketHour, bucketMinute).getTime() / 1000);
                map.set(key, { time: bucketTime, open: c.open, high: c.high, low: c.low, close: c.close });
            } else {
                const b = map.get(key);
                b.high = Math.max(b.high, c.high);
                b.low = Math.min(b.low, c.low);
                b.close = c.close;
            }
        }
        return Array.from(map.values()).sort((a, b) => a.time - b.time);
    }

    function calculateHeikinAshi(data) {
        const ha = [];
        for (let i = 0; i < data.length; i++) {
            const c = data[i];
            const haClose = (c.open + c.high + c.low + c.close) / 4;
            const haOpen = i === 0 ? (c.open + c.close) / 2 : (ha[i-1].open + ha[i-1].close) / 2;
            const haHigh = Math.max(c.high, haOpen, haClose);
            const haLow = Math.min(c.low, haOpen, haClose);
            ha.push({ time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose, bullish: haClose > haOpen });
        }
        return ha;
    }

    function calculateSimpleCandles(data) {
        return data.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, bullish: c.close > c.open }));
    }

    function getDisplayCandles(rawData, candleType) {
        return candleType === 'simple' ? calculateSimpleCandles(rawData) : calculateHeikinAshi(rawData);
    }

    function calculateRSI(closes, period) {
        const rsi = new Array(closes.length).fill(null);
        if (closes.length <= period) return rsi;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i-1];
            if (diff >= 0) gains += diff; else losses -= diff;
        }
        let avgGain = gains / period, avgLoss = losses / period;
        rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain/avgLoss));
        for (let i = period + 1; i < closes.length; i++) {
            const diff = closes[i] - closes[i-1];
            const gain = diff > 0 ? diff : 0;
            const loss = diff < 0 ? -diff : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain/avgLoss));
        }
        return rsi;
    }

    function calculateEMA(closes, period) {
        const ema = new Array(closes.length).fill(null);
        if (closes.length < period) return ema;
        let sum = 0;
        for (let i = 0; i < period; i++) sum += closes[i];
        ema[period - 1] = sum / period;
        const k = 2 / (period + 1);
        for (let i = period; i < closes.length; i++) {
            ema[i] = closes[i] * k + ema[i-1] * (1 - k);
        }
        return ema;
    }

    function getRequiredCandles(strategyId, params) {
        if (strategyId === 'rsi50_2') return (params.rsiSlowPeriod || 50) + 2;
        if (strategyId === 'ema_heikin') return Math.max(params.emaFast || 25, params.emaMid || 50, params.emaSlow || 100) + 2;
        return 10;
    }

    function runRSI50_2(rawData, params) {
        const rsiFastPeriod = params.rsiFastPeriod || 2;
        const rsiSlowPeriod = params.rsiSlowPeriod || 50;
        const candleType = params.candleType || 'heikin';

        const ha = getDisplayCandles(rawData, candleType);
        const closes = rawData.map(d => d.close);
        const rsiFast = calculateRSI(closes, rsiFastPeriod);
        const rsiSlow = calculateRSI(closes, rsiSlowPeriod);

        const signals = [];
        let position = null;
        const trades = [];

        for (let i = 1; i < rawData.length; i++) {
            if (rsiFast[i] === null || rsiSlow[i] === null) {
                signals.push({ time: rawData[i].time, indicators: { rsiFast: null, rsiSlow: null }, signalType: null, position });
                continue;
            }
            const fastAboveSlow = rsiFast[i] > rsiSlow[i];
            const fastBelowSlow = rsiFast[i] < rsiSlow[i];
            const candle = ha[i];

            const buyCondition = fastAboveSlow && candle.bullish;
            const sellCondition = fastBelowSlow && !candle.bullish;

            let signalType = null;
            if (position === null) {
                if (buyCondition) {
                    position = 'LONG'; signalType = 'BUY';
                    trades.push({ type:'خرید', entryDate: rawData[i].time, entryPrice: rawData[i].close });
                } else if (sellCondition) {
                    position = 'SHORT'; signalType = 'SELL';
                    trades.push({ type:'فروش', entryDate: rawData[i].time, entryPrice: rawData[i].close });
                }
            } else if (position === 'LONG' && fastBelowSlow) {
                position = null; signalType = 'EXIT_LONG';
            } else if (position === 'SHORT' && fastAboveSlow) {
                position = null; signalType = 'EXIT_SHORT';
            }

            signals.push({ time: rawData[i].time, indicators: { rsiFast: rsiFast[i], rsiSlow: rsiSlow[i] }, signalType, position });
        }
        return { ha, signals, trades };
    }

    function runEMA_HeikinAshi(rawData, params) {
        const emaFast = params.emaFast || 25;
        const emaMid = params.emaMid || 50;
        const emaSlow = params.emaSlow || 100;
        const candleType = params.candleType || 'heikin';

        const ha = getDisplayCandles(rawData, candleType);
        const closes = rawData.map(d => d.close);
        const ema25 = calculateEMA(closes, emaFast);
        const ema50 = calculateEMA(closes, emaMid);
        const ema100 = calculateEMA(closes, emaSlow);

        const signals = [];
        let position = null;
        const trades = [];

        for (let i = 0; i < rawData.length; i++) {
            if (ema25[i] === null || ema50[i] === null || ema100[i] === null) {
                signals.push({ time: rawData[i].time, indicators: { ema25: null, ema50: null }, signalType: null, position });
                continue;
            }
            const price = closes[i];
            const candle = ha[i];
            const aboveAll = price > ema25[i] && price > ema50[i] && price > ema100[i];
            const belowAll = price < ema25[i] && price < ema50[i] && price < ema100[i];

            const buyCondition = aboveAll && candle.bullish;
            const sellCondition = belowAll && !candle.bullish;
            const crossedEma25Down = price < ema25[i];
            const crossedEma25Up = price > ema25[i];

            let signalType = null;
            if (position === null) {
                if (buyCondition) { position = 'LONG'; signalType = 'BUY'; trades.push({ type:'خرید', entryDate: rawData[i].time, entryPrice: price }); }
                else if (sellCondition) { position = 'SHORT'; signalType = 'SELL'; trades.push({ type:'فروش', entryDate: rawData[i].time, entryPrice: price }); }
            } else if (position === 'LONG' && crossedEma25Down) {
                position = null; signalType = 'EXIT_LONG';
            } else if (position === 'SHORT' && crossedEma25Up) {
                position = null; signalType = 'EXIT_SHORT';
            }

            signals.push({ time: rawData[i].time, indicators: { ema25: ema25[i], ema50: ema50[i] }, signalType, position });
        }
        return { ha, signals, trades };
    }

    const STRATEGIES = {
        rsi50_2: {
            id: 'rsi50_2', name: 'RSI50-2', defaultTimeframe: '1h',
            defaultParams: { rsiFastPeriod: 2, rsiSlowPeriod: 50 },
            run: runRSI50_2
        },
        ema_heikin: {
            id: 'ema_heikin', name: 'نوسان‌گیری EMA 25/50/100', defaultTimeframe: '30m',
            defaultParams: { emaFast: 25, emaMid: 50, emaSlow: 100 },
            run: runEMA_HeikinAshi
        }
    };

    return {
        calculateHeikinAshi, calculateSimpleCandles, getDisplayCandles,
        calculateRSI, calculateEMA,
        aggregateCandles, TIMEFRAME_MINUTES, getRequiredCandles,
        runRSI50_2, runEMA_HeikinAshi, STRATEGIES
    };
});
