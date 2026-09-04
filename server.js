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

const SERVER_VERSION = 'v4.0-1m-multikey';

// ==========================================================
// کلیدهای API (تا ۳ کلید، هر کدام حداکثر ۹۰ درخواست در روز)
// ==========================================================
const API_KEYS = [
    process.env.BRSAPI_KEY_1 || process.env.BRSAPI_KEY,
    process.env.BRSAPI_KEY_2,
    process.env.BRSAPI_KEY_3
].filter(Boolean);
const PER_KEY_LIMIT = 90;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.json());

app.get('/ping', (req, res) => res.json({ pong: true, time: new Date().toISOString() }));
app.get('/api/version', (req, res) => res.json({ version: SERVER_VERSION }));
app.get('/strategies.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'strategies.js'));
});

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
        hour: parseInt(map.hour, 10) % 24, minute: parseInt(map.minute, 10), second: parseInt(map.second, 10),
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
// مدیریت سهمیه‌ی کلیدها (ریست روزانه به تاریخ تهران)
// ==========================================================
function usageId(index) { return `allsymbols_usage_key${index + 1}`; }

async function getKeyUsage(index) {
    const db = getDB();
    const today = todayDateString(getTehranParts());
    let doc = await db.collection('meta').findOne({ _id: usageId(index) });
    if (!doc || doc.date !== today) {
        await db.collection('meta').updateOne(
            { _id: usageId(index) },
            { $set: { date: today, count: 0 } },
            { upsert: true }
        );
        doc = { _id: usageId(index), date: today, count: 0 };
    }
    return doc;
}

// اولین کلیدی که هنوز به سقف نرسیده را انتخاب و یک واحد از آن مصرف می‌کند
async function acquireApiKey() {
    const db = getDB();
    for (let i = 0; i < API_KEYS.length; i++) {
        const usage = await getKeyUsage(i);
        if (usage.count < PER_KEY_LIMIT) {
            await db.collection('meta').updateOne({ _id: usageId(i) }, { $inc: { count: 1 } });
            return { key: API_KEYS[i], index: i };
        }
    }
    return null;
}

async function getAllUsage() {
    const keys = [];
    for (let i = 0; i < API_KEYS.length; i++) {
        const u = await getKeyUsage(i);
        keys.push({ index: i + 1, count: u.count, limit: PER_KEY_LIMIT });
    }
    return {
        date: todayDateString(getTehranParts()),
        keys,
        total: keys.reduce((s, k) => s + k.count, 0),
        totalLimit: API_KEYS.length * PER_KEY_LIMIT
    };
}

app.get('/api/usage', async (req, res, next) => {
    try { res.json(await getAllUsage()); } catch (err) { next(err); }
});

// ==========================================================
// لیست نمادهای بازار (کش در حافظه + ذخیره در Mongo)
// ==========================================================
let symbolsCache = [];

async function fetchAllSymbolsRaw() {
    if (API_KEYS.length === 0) throw new Error('هیچ کلید BrsApi تنظیم نشده است.');
    const picked = await acquireApiKey();
    if (!picked) throw new Error('سهمیه‌ی روزانه‌ی همه‌ی کلیدها به پایان رسیده است.');

    const url = `https://Api.BrsApi.ir/Tsetmc/AllSymbols.php?key=${picked.key}&type=1`;
    const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json, text/plain, */*' },
        timeout: 20000
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} (کلید ${picked.index + 1})`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('پاسخ نامعتبر از BrsApi');
    return data;
}

async function updateSymbolsCacheFromRaw(raw) {
    symbolsCache = raw.filter(s => s.l18).map(s => ({ symbol: s.l18, name: s.l30, price: s.pl }));
    try {
        await getDB().collection('meta').updateOne(
            { _id: 'symbols_cache' },
            { $set: { symbols: symbolsCache, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (e) { console.error('❌ ذخیره‌ی کش نمادها:', e.message); }
}

async function loadSymbolsCacheFromDB() {
    const doc = await getDB().collection('meta').findOne({ _id: 'symbols_cache' });
    if (doc && Array.isArray(doc.symbols) && doc.symbols.length) {
        symbolsCache = doc.symbols;
        console.log(`✅ کش نمادها از دیتابیس بارگذاری شد: ${symbolsCache.length} نماد`);
        return true;
    }
    return false;
}

app.get('/api/symbols/search', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    res.json(symbolsCache.filter(s => s.symbol.includes(q) || (s.name && s.name.includes(q))).slice(0, 20));
});

// ==========================================================
// اطلاعات استراتژی‌ها و تایم‌فریم‌ها
// ==========================================================
app.get('/api/strategies', (req, res) => {
    res.json(Object.values(STRATEGIES).map(s => ({
        id: s.id, name: s.name, defaultTimeframe: s.defaultTimeframe, defaultParams: s.defaultParams, indicators: s.indicators
    })));
});
app.get('/api/timeframes', (req, res) => res.json(Object.keys(TIMEFRAME_MINUTES)));

// ==========================================================
// نمادهای زیر نظر
// ==========================================================
app.get('/api/monitored-symbols', async (req, res, next) => {
    try {
        const db = getDB();
        const [symbols, counts] = await Promise.all([
            db.collection('monitored_symbols').find({}).sort({ addedAt: 1 }).toArray(),
            db.collection('candles_base').aggregate([{ $group: { _id: '$symbol', count: { $sum: 1 } } }]).toArray()
        ]);
        const countMap = new Map(counts.map(c => [c._id, c.count]));
        res.json(symbols.map(s => ({ ...s, candleCount: countMap.get(s.symbol) || 0 })));
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
        if (configCount > 0) return res.status(400).json({ error: `این نماد در ${configCount} تنظیم استراتژی استفاده شده است. ابتدا آن‌ها را حذف کنید.` });
        await db.collection('monitored_symbols').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (err) { next(err); }
});

// ==========================================================
// تنظیمات استراتژی
// ==========================================================
app.get('/api/strategy-configs', async (req, res, next) => {
    try {
        res.json(await getDB().collection('strategy_configs').find({}).sort({ createdAt: 1 }).toArray());
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
            symbol, strategyId, timeframe,
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
        const { params, enabled } = req.body;
        const update = {};
        if (params !== undefined) update.params = params;
        if (enabled !== undefined) update.enabled = enabled;
        await getDB().collection('strategy_configs').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
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
// وضعیت فعلی + تاریخچه سیگنال‌ها
// ==========================================================
app.get('/api/status', async (req, res, next) => {
    try { res.json(await getDB().collection('signals_state').find({}).toArray()); } catch (err) { next(err); }
});

app.get('/api/signal-history', async (req, res, next) => {
    try {
        res.json(await getDB().collection('signal_history').find({}).sort({ createdAt: -1 }).limit(300).toArray());
    } catch (err) { next(err); }
});

app.delete('/api/signal-history', async (req, res, next) => {
    try { await getDB().collection('signal_history').deleteMany({}); res.json({ success: true }); } catch (err) { next(err); }
});

// ==========================================================
// کندل‌ها برای نمودار
// ==========================================================
async function getAggregatedCandles(symbol, timeframe) {
    const base = await getDB().collection('candles_base').find({ symbol }).sort({ time: 1 }).toArray();
    const baseFormatted = base.map(c => ({ time: Math.floor(c.time.getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
    return aggregateCandles(baseFormatted, TIMEFRAME_MINUTES[timeframe]);
}

app.get('/api/candles/:symbol/:timeframe', async (req, res, next) => {
    const { symbol, timeframe } = req.params;
    if (!TIMEFRAME_MINUTES[timeframe]) return res.status(400).json({ error: 'تایم‌فریم نامعتبر است' });
    try { res.json(await getAggregatedCandles(symbol, timeframe)); } catch (err) { next(err); }
});

// ==========================================================
// تلگرام (فقط ارسال سیگنال)
// ==========================================================
async function sendTelegramMessage(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('توکن یا chat_id تلگرام تنظیم نشده است.');
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }) });
    const data = await response.json();
    if (!data.ok) throw new Error(data.description || 'خطای نامشخص تلگرام');
    return data;
}

// ==========================================================
// موتور اصلی: ساخت کندل زنده (۱ دقیقه‌ای) + اجرای استراتژی‌ها
// ==========================================================
async function upsertLiveCandle(symbol, time, price) {
    await getDB().collection('candles_base').updateOne(
        { symbol, time },
        { $setOnInsert: { symbol, time, open: price }, $set: { close: price }, $max: { high: price }, $min: { low: price } },
        { upsert: true }
    );
}

async function evaluateStrategyConfig(config) {
    const strategyDef = STRATEGIES[config.strategyId];
    if (!strategyDef) return;

    const db = getDB();
    const candles = await getAggregatedCandles(config.symbol, config.timeframe);
    const configId = config._id.toString();
    const required = getRequiredCandles(config.strategyId, config.params);
    const stateColl = db.collection('signals_state');

    if (candles.length < required) {
        await stateColl.updateOne(
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
    const prevState = await stateColl.findOne({ configId });

    await stateColl.updateOne(
        { configId },
        { $set: { configId, symbol: config.symbol, strategyId: config.strategyId, position: lastSignal.position, indicators: lastSignal.indicators, price: lastPrice, candleCount: candles.length, requiredCandles: required, updatedAt: new Date(), insufficientData: false } },
        { upsert: true }
    );

    const isActionable = ['BUY', 'SELL', 'EXIT_LONG', 'EXIT_SHORT'].includes(lastSignal.signalType);
    const alreadyNotified = prevState
        && prevState.lastNotifiedTime === lastSignal.time
        && prevState.lastNotifiedType === lastSignal.signalType;

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
        await db.collection('signal_history').insertOne({
            symbol: config.symbol, strategyId: config.strategyId, strategyName: strategyDef.name,
            signalType: lastSignal.signalType, price: lastPrice, time: lastSignal.time, createdAt: new Date()
        });
    }
}

let tickRunning = false;

async function tick() {
    if (tickRunning) { console.warn('⏳ تیک قبلی هنوز تمام نشده؛ این تیک رد شد.'); return; }
    tickRunning = true;
    try {
        const db = getDB();
        const monitored = await db.collection('monitored_symbols').find({}).toArray();
        if (monitored.length === 0) return; // بدون نماد، سهمیه مصرف نکن

        let raw;
        try {
            raw = await fetchAllSymbolsRaw();
        } catch (err) {
            console.error('❌ خطا در دریافت قیمت‌های لحظه‌ای:', err.message);
            return;
        }
        await updateSymbolsCacheFromRaw(raw);

        const priceMap = new Map();
        raw.forEach(s => { if (s.l18) priceMap.set(s.l18, s.pl); });

        const tehran = getTehranParts();
        const bucket1 = getBucketTime(tehran, 1);

        for (const m of monitored) {
            const price = priceMap.get(m.symbol);
            if (!price) continue;
            await upsertLiveCandle(m.symbol, bucket1, price);
        }

        const configs = await db.collection('strategy_configs').find({ enabled: true }).toArray();
        for (const config of configs) {
            await evaluateStrategyConfig(config);
        }

        console.log(`⏱ تیک - ${tehran.hour}:${String(tehran.minute).padStart(2,'0')} - ${monitored.length} نماد - ${configs.length} استراتژی`);
    } finally {
        tickRunning = false;
    }
}

// ==========================================================
// وضعیت کلی سرور
// ==========================================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok', version: SERVER_VERSION,
        apiKeysConfigured: API_KEYS.length,
        telegramConfigured: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
        symbolsCached: symbolsCache.length,
        marketOpenNow: isMarketOpen(getTehranParts())
    });
});

app.use((req, res) => res.status(404).json({ error: 'مسیر یافت نشد' }));
app.use((err, req, res, next) => {
    console.error('❌ خطای سرور:', err.message);
    res.status(500).json({ error: err.message || 'خطای داخلی سرور' });
});

async function start() {
    await connectDB();

    // کش نمادها: از دیتابیس؛ فقط اگر خالی بود یک بار از API
    const loaded = await loadSymbolsCacheFromDB();
    if (!loaded) {
        try {
            const raw = await fetchAllSymbolsRaw();
            await updateSymbolsCacheFromRaw(raw);
            console.log(`✅ کش نمادها از API ساخته شد: ${symbolsCache.length} نماد`);
        } catch (err) { console.error('❌ ساخت اولیه‌ی کش نمادها:', err.message); }
    }

    // هر ۱ دقیقه در ساعات بازار
    cron.schedule('* * * * *', async () => {
        if (!isMarketOpen(getTehranParts())) return;
        try { await tick(); } catch (err) { console.error('❌ خطا در tick:', err.message); }
    });

    app.listen(PORT, () => console.log(`🚀 Server ${SERVER_VERSION} on port ${PORT} | keys: ${API_KEYS.length}`));
}

start().catch(err => {
    console.error('❌ خطا در راه‌اندازی سرور:', err);
    process.exit(1);
});