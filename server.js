const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const cron = require('node-cron');
const { ObjectId } = require('mongodb');
const { connectDB, getDB } = require('./db');
const { STRATEGIES, TIMEFRAME_MINUTES, aggregateCandles, getRequiredCandles } = require('./strategies.js');

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.BRSAPI_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.json());

app.get('/ping', (req, res) => res.json({ pong: true, time: new Date().toISOString() }));
app.get('/strategies.js', (req, res) => res.sendFile(path.join(__dirname, 'strategies.js')));

// ==========================================================
// زمان تهران
// ==========================================================
function getTehranParts(date = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tehran',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, weekday: 'short'
    });
    const parts = fmt.formatToParts(date);
    const map = {};
    parts.forEach(p => { map[p.type] = p.value; });
    return {
        year: parseInt(map.year, 10), month: parseInt(map.month, 10), day: parseInt(map.day, 10),
        hour: parseInt(map.hour, 10), minute: parseInt(map.minute, 10), second: parseInt(map.second, 10),
        weekday: map.weekday
    };
}

function isMarketOpen(tehran) {
    const openDays = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed'];
    if (!openDays.includes(tehran.weekday)) return false;
    const minutesNow = tehran.hour * 60 + tehran.minute;
    return minutesNow >= 9 * 60 && minutesNow <= 12 * 60 + 30;
}

function tehranPartsToUTCDate(year, month, day, hour, minute) {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - (3.5 * 60 * 60 * 1000));
}

function getBucketTime(tehran, sizeMinutes) {
    const minuteOfDay = tehran.hour * 60 + tehran.minute;
    const bucketStart = Math.floor(minuteOfDay / sizeMinutes) * sizeMinutes;
    return tehranPartsToUTCDate(tehran.year, tehran.month, tehran.day, Math.floor(bucketStart / 60), bucketStart % 60);
}

function todayDateString(tehran) {
    return `${tehran.year}-${String(tehran.month).padStart(2,'0')}-${String(tehran.day).padStart(2,'0')}`;
}

// ==========================================================
// کش لیست نمادهای بازار
// ==========================================================
let symbolsCache = [];

async function fetchAllSymbolsRaw() {
    const url = `https://Api.BrsApi.ir/Tsetmc/AllSymbols.php?key=${API_KEY}&type=1`;
    const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json, text/plain, */*' },
        timeout: 20000
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
}

function updateSymbolsCacheFromRaw(raw) {
    symbolsCache = raw.filter(s => s.l18).map(s => ({ symbol: s.l18, name: s.l30, price: s.pl }));
}

async function refreshSymbolsCache() {
    try {
        const raw = await fetchAllSymbolsRaw();
        updateSymbolsCacheFromRaw(raw);
        console.log(`✅ کش نمادها به‌روزرسانی شد: ${symbolsCache.length} نماد`);
    } catch (err) {
        console.error('❌ خطا در به‌روزرسانی کش نمادها:', err.message);
    }
}

app.get('/api/symbols/search', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    res.json(symbolsCache.filter(s => s.symbol.includes(q) || (s.name && s.name.includes(q))).slice(0, 20));
});

// ==========================================================
// اطلاعات استراتژی‌ها
// ==========================================================
app.get('/api/strategies', (req, res) => {
    res.json(Object.values(STRATEGIES).map(s => ({
        id: s.id, name: s.name, defaultTimeframe: s.defaultTimeframe, defaultParams: s.defaultParams
    })));
});

app.get('/api/timeframes', (req, res) => {
    res.json(Object.keys(TIMEFRAME_MINUTES));
});

// ==========================================================
// نمادهای زیر نظر
// ==========================================================
app.get('/api/monitored-symbols', async (req, res, next) => {
    try {
        const db = getDB();
        const symbols = await db.collection('monitored_symbols').find({}).sort({ addedAt: 1 }).toArray();
        const today = todayDateString(getTehranParts());

        const enriched = await Promise.all(symbols.map(async (s) => {
            const [count, seedDoc] = await Promise.all([
                db.collection('candles_base').countDocuments({ symbol: s.symbol }),
                db.collection('seed_log').findOne({ symbol: s.symbol, date: today })
            ]);
            return { ...s, candleCount: count, seededToday: !!seedDoc };
        }));

        res.json(enriched);
    } catch (err) { next(err); }
});

app.post('/api/monitored-symbols', async (req, res, next) => {
    try {
        const { symbol } = req.body;
        if (!symbol) return res.status(400).json({ error: 'symbol الزامی است' });
        const db = getDB();
        const exists = await db.collection('monitored_symbols').findOne({ symbol });
        if (exists) return res.status(400).json({ error: 'این نماد قبلاً اضافه شده است' });
        const doc = { symbol, addedAt: new Date() };
        const result = await db.collection('monitored_symbols').insertOne(doc);
        res.json({ _id: result.insertedId, ...doc });
    } catch (err) { next(err); }
});

app.delete('/api/monitored-symbols/:id', async (req, res, next) => {
    try {
        const db = getDB();
        const doc = await db.collection('monitored_symbols').findOne({ _id: new ObjectId(req.params.id) });
        if (!doc) return res.status(404).json({ error: 'یافت نشد' });

        const configCount = await db.collection('strategy_configs').countDocuments({ symbol: doc.symbol });
        if (configCount > 0) {
            return res.status(400).json({ error: `این نماد در ${configCount} تنظیم استراتژی استفاده شده است. ابتدا آن‌ها را حذف کنید.` });
        }
        await db.collection('monitored_symbols').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (err) { next(err); }
});

// ==========================================================
// تنظیمات استراتژی
// ==========================================================
app.get('/api/strategy-configs', async (req, res, next) => {
    try {
        const db = getDB();
        res.json(await db.collection('strategy_configs').find({}).sort({ createdAt: 1 }).toArray());
    } catch (err) { next(err); }
});

app.post('/api/strategy-configs', async (req, res, next) => {
    try {
        const { symbol, strategyId, timeframe, candleType, params, enabled } = req.body;
        if (!symbol || !strategyId) return res.status(400).json({ error: 'symbol و strategyId الزامی هستند' });
        if (!STRATEGIES[strategyId]) return res.status(400).json({ error: 'استراتژی نامعتبر است' });
        if (!TIMEFRAME_MINUTES[timeframe]) return res.status(400).json({ error: 'تایم‌فریم نامعتبر است' });

        const db = getDB();
        const symbolExists = await db.collection('monitored_symbols').findOne({ symbol });
        if (!symbolExists) return res.status(400).json({ error: 'ابتدا باید این نماد را به لیست نمادهای زیر نظر اضافه کنید.' });

        const doc = {
            symbol, strategyId,
            timeframe,
            candleType: candleType === 'simple' ? 'simple' : 'heikin',
            params: params || STRATEGIES[strategyId].defaultParams,
            enabled: enabled !== false,
            createdAt: new Date()
        };
        const result = await db.collection('strategy_configs').insertOne(doc);
        res.json({ _id: result.insertedId, ...doc });
    } catch (err) { next(err); }
});

app.put('/api/strategy-configs/:id', async (req, res, next) => {
    try {
        const db = getDB();
        const { params, enabled } = req.body;
        const update = {};
        if (params !== undefined) update.params = params;
        if (enabled !== undefined) update.enabled = enabled;
        await db.collection('strategy_configs').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
        res.json({ success: true });
    } catch (err) { next(err); }
});

app.delete('/api/strategy-configs/:id', async (req, res, next) => {
    try {
        const db = getDB();
        await db.collection('strategy_configs').deleteOne({ _id: new ObjectId(req.params.id) });
        await db.collection('signals_state').deleteOne({ configId: req.params.id });
        res.json({ success: true });
    } catch (err) { next(err); }
});

// ==========================================================
// وضعیت فعلی هر تنظیم استراتژی
// ==========================================================
app.get('/api/status', async (req, res, next) => {
    try {
        const db = getDB();
        res.json(await db.collection('signals_state').find({}).toArray());
    } catch (err) { next(err); }
});

// ==========================================================
// کندل‌ها برای نمودار (تجمیع در لحظه از کالکشن پایه)
// ==========================================================
app.get('/api/candles/:symbol/:timeframe', async (req, res, next) => {
    const { symbol, timeframe } = req.params;
    if (!TIMEFRAME_MINUTES[timeframe]) return res.status(400).json({ error: 'تایم‌فریم نامعتبر است' });
    try {
        const db = getDB();
        const base = await db.collection('candles_base').find({ symbol }).sort({ time: 1 }).toArray();
        const baseFormatted = base.map(c => ({
            time: Math.floor(c.time.getTime() / 1000),
            open: c.open, high: c.high, low: c.low, close: c.close
        }));
        res.json(aggregateCandles(baseFormatted, TIMEFRAME_MINUTES[timeframe]));
    } catch (err) { next(err); }
});

// ==========================================================
// سهمیه Candlestick
// ==========================================================
async function getUsageDoc() {
    const db = getDB();
    const today = todayDateString(getTehranParts());
    let doc = await db.collection('meta').findOne({ _id: 'candlestick_usage' });
    if (!doc || doc.date !== today) {
        doc = { _id: 'candlestick_usage', date: today, count: 0 };
        await db.collection('meta').updateOne({ _id: 'candlestick_usage' }, { $set: doc }, { upsert: true });
    }
    return doc;
}

async function incrementUsage() {
    const db = getDB();
    const today = todayDateString(getTehranParts());
    await db.collection('meta').updateOne(
        { _id: 'candlestick_usage' }, { $set: { date: today }, $inc: { count: 1 } }, { upsert: true }
    );
}

app.get('/api/usage', async (req, res, next) => {
    try {
        const usage = await getUsageDoc();
        res.json({ date: usage.date, candlestick: `${usage.count}/10` });
    } catch (err) { next(err); }
});

// ==========================================================
// Seed تاریخچه (اختیاری، هر نماد فقط یک‌بار در روز)
// ==========================================================
function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

async function seedSymbolHistory(symbol) {
    const db = getDB();
    const tehran = getTehranParts();
    const today = todayDateString(tehran);

    const alreadySeeded = await db.collection('seed_log').findOne({ symbol, date: today });
    if (alreadySeeded) throw new Error('تاریخچه این نماد امروز قبلاً دریافت شده است.');

    const usage = await getUsageDoc();
    if (usage.count >= 10) throw new Error('سهمیه روزانه Candlestick به پایان رسیده است.');

    const url = `https://Api.BrsApi.ir/Tsetmc/Candlestick.php?key=${API_KEY}&type=1&l18=${encodeURIComponent(symbol)}`;
    const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json, text/plain, */*' },
        timeout: 15000
    });
    await incrementUsage();

    if (!response.ok) throw new Error(`BrsApi با کد ${response.status} پاسخ داد`);

    const data = await response.json();
    const intraday = data.candle_intraday;
    if (!Array.isArray(intraday) || intraday.length === 0) throw new Error('داده‌ای برای این نماد دریافت نشد');

    let count = 0;
    for (const c of intraday) {
        const mins = timeToMinutes(c.time);
        const time = tehranPartsToUTCDate(tehran.year, tehran.month, tehran.day, Math.floor(mins / 60), mins % 60);
        await db.collection('candles_base').updateOne(
            { symbol, time },
            { $set: { symbol, time, open: c.open, high: c.high, low: c.low, close: c.close } },
            { upsert: true }
        );
        count++;
    }

    await db.collection('seed_log').insertOne({ symbol, date: today, createdAt: new Date() });
    return { candlesAdded: count };
}

app.post('/api/seed/:symbol', async (req, res, next) => {
    try {
        const result = await seedSymbolHistory(req.params.symbol);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/seed-all', async (req, res, next) => {
    try {
        const db = getDB();
        const monitored = await db.collection('monitored_symbols').find({}).toArray();
        const results = [];
        for (const m of monitored) {
            try {
                const result = await seedSymbolHistory(m.symbol);
                results.push({ symbol: m.symbol, status: 'success', ...result });
            } catch (err) {
                results.push({ symbol: m.symbol, status: 'skipped', reason: err.message });
            }
        }
        res.json({ results });
    } catch (err) { next(err); }
});

// ==========================================================
// تلگرام
// ==========================================================
async function sendTelegramMessage(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('توکن یا chat_id تلگرام تنظیم نشده است.');
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.description || 'خطای نامشخص تلگرام');
    return data;
}

app.post('/api/test/telegram', async (req, res, next) => {
    try {
        await sendTelegramMessage('✅ این یک پیام آزمایشی از سیستم پایش سیگنال است.');
        res.json({ success: true });
    } catch (err) { next(err); }
});

app.get('/api/test/mongo', async (req, res, next) => {
    try {
        await getDB().command({ ping: 1 });
        res.json({ success: true, message: 'اتصال به MongoDB سالم است.' });
    } catch (err) { next(err); }
});

// ==========================================================
// موتور اصلی: ساخت کندل زنده + اجرای استراتژی‌ها (هر ۳ دقیقه)
// ==========================================================
async function upsertLiveCandle(symbol, time, price) {
    const db = getDB();
    await db.collection('candles_base').updateOne(
        { symbol, time },
        { $setOnInsert: { symbol, time, open: price }, $set: { close: price }, $max: { high: price }, $min: { low: price } },
        { upsert: true }
    );
}

async function evaluateStrategyConfig(config) {
    const strategyDef = STRATEGIES[config.strategyId];
    if (!strategyDef) return;

    const db = getDB();
    const base = await db.collection('candles_base').find({ symbol: config.symbol }).sort({ time: 1 }).toArray();
    const baseFormatted = base.map(c => ({
        time: Math.floor(c.time.getTime() / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close
    }));
    const candles = aggregateCandles(baseFormatted, TIMEFRAME_MINUTES[config.timeframe]);

    const configId = config._id.toString();
    const required = getRequiredCandles(config.strategyId, config.params);

    if (candles.length < required) {
        await db.collection('signals_state').updateOne(
            { configId },
            { $set: { configId, symbol: config.symbol, strategyId: config.strategyId, position: null, candleCount: candles.length, requiredCandles: required, updatedAt: new Date(), insufficientData: true } },
            { upsert: true }
        );
        return;
    }

    let result;
    try {
        result = strategyDef.run(candles, { ...config.params, candleType: config.candleType });
    } catch (err) {
        console.error(`❌ خطا در اجرای استراتژی برای ${config.symbol}:`, err.message);
        return;
    }

    const lastSignal = result.signals[result.signals.length - 1];
    if (!lastSignal) return;

    const lastPrice = candles[candles.length - 1].close;
    const stateColl = db.collection('signals_state');
    const prevState = await stateColl.findOne({ configId });

    await stateColl.updateOne(
        { configId },
        { $set: { configId, symbol: config.symbol, strategyId: config.strategyId, position: lastSignal.position, indicators: lastSignal.indicators, price: lastPrice, candleCount: candles.length, requiredCandles: required, updatedAt: new Date(), insufficientData: false } },
        { upsert: true }
    );

    const isActionable = ['BUY', 'SELL', 'EXIT_LONG', 'EXIT_SHORT'].includes(lastSignal.signalType);
    const alreadyNotified = prevState && prevState.lastNotifiedTime === lastSignal.time;

    if (isActionable && !alreadyNotified) {
        const titles = { BUY: '📈 سیگنال خرید', SELL: '📉 سیگنال فروش', EXIT_LONG: '🔔 خروج از موقعیت خرید', EXIT_SHORT: '🔔 خروج از موقعیت فروش' };
        const text = `${titles[lastSignal.signalType]}\nنماد: ${config.symbol}\nاستراتژی: ${strategyDef.name}\nتایم‌فریم: ${config.timeframe}\nقیمت: ${lastPrice.toLocaleString()}`;
        try {
            await sendTelegramMessage(text);
            console.log(`📨 پیام ارسال شد: ${config.symbol} - ${lastSignal.signalType}`);
        } catch (err) {
            console.error('❌ خطا در ارسال تلگرام:', err.message);
        }
        await stateColl.updateOne({ configId }, { $set: { lastNotifiedTime: lastSignal.time, lastNotifiedType: lastSignal.signalType } });
    }
}

async function tick() {
    let raw;
    try {
        raw = await fetchAllSymbolsRaw();
    } catch (err) {
        console.error('❌ خطا در دریافت قیمت‌های لحظه‌ای:', err.message);
        return;
    }
    updateSymbolsCacheFromRaw(raw);

    const priceMap = new Map();
    raw.forEach(s => { if (s.l18) priceMap.set(s.l18, s.pl); });

    const db = getDB();
    const monitored = await db.collection('monitored_symbols').find({}).toArray();
    if (monitored.length === 0) return;

    const tehran = getTehranParts();
    const bucket3 = getBucketTime(tehran, 3);

    for (const m of monitored) {
        const price = priceMap.get(m.symbol);
        if (!price) continue;
        await upsertLiveCandle(m.symbol, bucket3, price);
    }

    const configs = await db.collection('strategy_configs').find({ enabled: true }).toArray();
    for (const config of configs) {
        await evaluateStrategyConfig(config);
    }

    console.log(`⏱ تیک اجرا شد - ${tehran.hour}:${tehran.minute} - ${monitored.length} نماد - ${configs.length} تنظیم استراتژی`);
}

// ==========================================================
// وضعیت کلی سرور
// ==========================================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok', apiKeyConfigured: !!API_KEY,
        telegramConfigured: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
        symbolsCached: symbolsCache.length, marketOpenNow: isMarketOpen(getTehranParts())
    });
});

app.use((req, res) => res.status(404).json({ error: 'مسیر یافت نشد' }));
app.use((err, req, res, next) => {
    console.error('❌ خطای سرور:', err.message);
    res.status(500).json({ error: err.message || 'خطای داخلی سرور' });
});

async function start() {
    await connectDB();
    await refreshSymbolsCache();

    cron.schedule('*/3 * * * *', async () => {
        const tehran = getTehranParts();
        if (!isMarketOpen(tehran)) return;
        try { await tick(); } catch (err) { console.error('❌ خطا در tick:', err.message); }
    });

    cron.schedule('0 7 * * *', () => refreshSymbolsCache(), { timezone: 'Asia/Tehran' });

    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

start().catch(err => {
    console.error('❌ خطا در راه‌اندازی سرور:', err);
    process.exit(1);
});
