const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const cron = require('node-cron');
const { ObjectId } = require('mongodb');
const { connectDB, getDB } = require('./db');
const { STRATEGIES } = require('./strategies.js');

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.BRSAPI_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.json());

// ==========================================================
// سرو کردن فایل مشترک strategies.js برای فرانت‌اند
// ==========================================================
app.get('/strategies.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'strategies.js'));
});

// ==========================================================
// زمان تهران (بدون نیاز به پکیج جانبی)
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
        year: parseInt(map.year, 10),
        month: parseInt(map.month, 10),
        day: parseInt(map.day, 10),
        hour: parseInt(map.hour, 10),
        minute: parseInt(map.minute, 10),
        second: parseInt(map.second, 10),
        weekday: map.weekday // Sat, Sun, Mon, Tue, Wed, Thu, Fri
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
    let { year, month, day, hour, minute } = tehran;
    if (sizeMinutes === 60) minute = 0;
    else if (sizeMinutes === 30) minute = minute < 30 ? 0 : 30;
    return tehranPartsToUTCDate(year, month, day, hour, minute);
}

// ==========================================================
// کش لیست نمادهای بازار (برای autocomplete)
// ==========================================================
let symbolsCache = [];
let symbolsCacheUpdatedAt = null;

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
    symbolsCache = raw
        .filter(s => s.l18)
        .map(s => ({ symbol: s.l18, name: s.l30, price: s.pl }));
    symbolsCacheUpdatedAt = new Date();
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
    const results = symbolsCache
        .filter(s => s.symbol.includes(q) || (s.name && s.name.includes(q)))
        .slice(0, 20);
    res.json(results);
});

app.get('/api/symbols/status', (req, res) => {
    res.json({ count: symbolsCache.length, updatedAt: symbolsCacheUpdatedAt });
});

// ==========================================================
// اطلاعات استراتژی‌ها (برای ساخت UI در فرانت)
// ==========================================================
app.get('/api/strategies', (req, res) => {
    const list = Object.values(STRATEGIES).map(s => ({
        id: s.id, name: s.name, timeframe: s.timeframe, defaultParams: s.defaultParams
    }));
    res.json(list);
});

// ==========================================================
// مدیریت Watchlist
// ==========================================================
app.get('/api/watchlist', async (req, res) => {
    try {
        const db = getDB();
        const items = await db.collection('watchlist').find({}).sort({ createdAt: 1 }).toArray();
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/watchlist', async (req, res) => {
    try {
        const { symbol, strategyId, params, enabled } = req.body;
        if (!symbol || !strategyId) {
            return res.status(400).json({ error: 'symbol و strategyId الزامی هستند' });
        }
        if (!STRATEGIES[strategyId]) {
            return res.status(400).json({ error: 'استراتژی نامعتبر است' });
        }
        const db = getDB();
        const doc = {
            symbol,
            strategyId,
            params: params || STRATEGIES[strategyId].defaultParams,
            enabled: enabled !== false,
            createdAt: new Date()
        };
        const result = await db.collection('watchlist').insertOne(doc);
        res.json({ _id: result.insertedId, ...doc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/watchlist/:id', async (req, res) => {
    try {
        const db = getDB();
        const { params, enabled } = req.body;
        const update = {};
        if (params !== undefined) update.params = params;
        if (enabled !== undefined) update.enabled = enabled;
        await db.collection('watchlist').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: update }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/watchlist/:id', async (req, res) => {
    try {
        const db = getDB();
        await db.collection('watchlist').deleteOne({ _id: new ObjectId(req.params.id) });
        await db.collection('signals_state').deleteOne({ watchlistId: req.params.id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================================
// وضعیت فعلی هر آیتم لیست پایش (خروجی cron)
// ==========================================================
app.get('/api/status', async (req, res) => {
    try {
        const db = getDB();
        const states = await db.collection('signals_state').find({}).toArray();
        res.json(states);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================================
// گرفتن کندل‌های ذخیره‌شده (برای رسم نمودار در فرانت)
// ==========================================================
app.get('/api/candles/:symbol/:timeframe', async (req, res) => {
    const { symbol, timeframe } = req.params;
    const collectionName = timeframe === '30m' ? 'candles_30m' : 'candles_1h';
    try {
        const db = getDB();
        const candles = await db.collection(collectionName)
            .find({ symbol }).sort({ time: 1 }).toArray();
        res.json(candles.map(c => ({
            time: Math.floor(c.time.getTime() / 1000),
            open: c.open, high: c.high, low: c.low, close: c.close
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================================
// شمارش سهمیه کندل‌استیک (در دیتابیس، پایدار در برابر ری‌استارت)
// ==========================================================
function getTodayDateString() {
    return new Date().toISOString().split('T')[0];
}

async function getUsageDoc() {
    const db = getDB();
    const today = getTodayDateString();
    let doc = await db.collection('meta').findOne({ _id: 'candlestick_usage' });
    if (!doc || doc.date !== today) {
        doc = { _id: 'candlestick_usage', date: today, count: 0 };
        await db.collection('meta').updateOne({ _id: 'candlestick_usage' }, { $set: doc }, { upsert: true });
    }
    return doc;
}

async function incrementUsage() {
    const db = getDB();
    const today = getTodayDateString();
    await db.collection('meta').updateOne(
        { _id: 'candlestick_usage' },
        { $set: { date: today }, $inc: { count: 1 } },
        { upsert: true }
    );
}

app.get('/api/usage', async (req, res) => {
    const usage = await getUsageDoc();
    res.json({ date: usage.date, candlestick: `${usage.count}/10` });
});

// ==========================================================
// ساخت تاریخچه اولیه از Candlestick (۲ دقیقه‌ای) -> ۳۰ دقیقه و ۱ ساعته
// ==========================================================
function timeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

function aggregateIntraday(intraday, bucketMinutes) {
    const sorted = [...intraday].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    const map = new Map();
    for (const c of sorted) {
        const mins = timeToMinutes(c.time);
        const bucketStart = Math.floor(mins / bucketMinutes) * bucketMinutes;
        if (!map.has(bucketStart)) {
            map.set(bucketStart, { bucketMinutes: bucketStart, open: c.open, high: c.high, low: c.low, close: c.close });
        } else {
            const b = map.get(bucketStart);
            b.high = Math.max(b.high, c.high);
            b.low = Math.min(b.low, c.low);
            b.close = c.close;
        }
    }
    return Array.from(map.values()).sort((a, b) => a.bucketMinutes - b.bucketMinutes);
}

app.post('/api/seed/:symbol', async (req, res) => {
    const symbol = req.params.symbol;
    try {
        const usage = await getUsageDoc();
        if (usage.count >= 10) {
            return res.status(429).json({ error: 'سهمیه روزانه Candlestick به پایان رسیده است.' });
        }

        const url = `https://Api.BrsApi.ir/Tsetmc/Candlestick.php?key=${API_KEY}&type=1&l18=${encodeURIComponent(symbol)}`;
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json, text/plain, */*' },
            timeout: 15000
        });
        await incrementUsage();

        if (!response.ok) {
            return res.status(response.status).json({ error: `BrsApi با کد ${response.status} پاسخ داد` });
        }

        const data = await response.json();
        const intraday = data.candle_intraday;
        if (!Array.isArray(intraday) || intraday.length === 0) {
            return res.status(404).json({ error: 'داده‌ای برای این نماد دریافت نشد' });
        }

        const tehran = getTehranParts();
        const db = getDB();
        const agg30 = aggregateIntraday(intraday, 30);
        const agg60 = aggregateIntraday(intraday, 60);

        for (const c of agg30) {
            const hour = Math.floor(c.bucketMinutes / 60);
            const minute = c.bucketMinutes % 60;
            const time = tehranPartsToUTCDate(tehran.year, tehran.month, tehran.day, hour, minute);
            await db.collection('candles_30m').updateOne(
                { symbol, time },
                { $set: { symbol, time, open: c.open, high: c.high, low: c.low, close: c.close } },
                { upsert: true }
            );
        }
        for (const c of agg60) {
            const hour = Math.floor(c.bucketMinutes / 60);
            const minute = c.bucketMinutes % 60;
            const time = tehranPartsToUTCDate(tehran.year, tehran.month, tehran.day, hour, minute);
            await db.collection('candles_1h').updateOne(
                { symbol, time },
                { $set: { symbol, time, open: c.open, high: c.high, low: c.low, close: c.close } },
                { upsert: true }
            );
        }

        res.json({ success: true, added30m: agg30.length, added60m: agg60.length });
    } catch (err) {
        res.status(502).json({ error: 'خطا: ' + err.message });
    }
});

// ==========================================================
// تلگرام
// ==========================================================
async function sendTelegramMessage(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('⚠️ توکن یا chat_id تلگرام تنظیم نشده است.');
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
        });
    } catch (err) {
        console.error('❌ خطا در ارسال پیام تلگرام:', err.message);
    }
}

// ==========================================================
// موتور اصلی: به‌روزرسانی کندل زنده + اجرای استراتژی‌ها (هر ۳ دقیقه)
// ==========================================================
async function upsertCandle(collectionName, symbol, time, price) {
    const db = getDB();
    await db.collection(collectionName).updateOne(
        { symbol, time },
        {
            $setOnInsert: { symbol, time, open: price },
            $set: { close: price },
            $max: { high: price },
            $min: { low: price }
        },
        { upsert: true }
    );
}

async function evaluateWatchlistItem(item) {
    const strategyDef = STRATEGIES[item.strategyId];
    if (!strategyDef) return;

    const collectionName = strategyDef.timeframe === '30m' ? 'candles_30m' : 'candles_1h';
    const db = getDB();
    const candles = await db.collection(collectionName)
        .find({ symbol: item.symbol }).sort({ time: 1 }).toArray();

    if (candles.length < 5) return;

    const rawData = candles.map(c => ({
        time: Math.floor(c.time.getTime() / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close
    }));

    let result;
    try {
        result = strategyDef.run(rawData, item.params || strategyDef.defaultParams);
    } catch (err) {
        console.error(`❌ خطا در اجرای استراتژی برای ${item.symbol}:`, err.message);
        return;
    }

    const lastSignal = result.signals[result.signals.length - 1];
    if (!lastSignal) return;

    const lastPrice = rawData[rawData.length - 1].close;
    const watchlistId = item._id.toString();
    const stateColl = db.collection('signals_state');
    const prevState = await stateColl.findOne({ watchlistId });

    await stateColl.updateOne(
        { watchlistId },
        {
            $set: {
                watchlistId,
                symbol: item.symbol,
                strategyId: item.strategyId,
                position: lastSignal.position,
                indicators: lastSignal.indicators,
                price: lastPrice,
                candleCount: candles.length,
                updatedAt: new Date()
            }
        },
        { upsert: true }
    );

    const isActionable = ['BUY', 'SELL', 'EXIT_LONG', 'EXIT_SHORT'].includes(lastSignal.signalType);
    const alreadyNotified = prevState && prevState.lastNotifiedTime === lastSignal.time;

    if (isActionable && !alreadyNotified) {
        const titles = {
            BUY: '📈 سیگنال خرید',
            SELL: '📉 سیگنال فروش',
            EXIT_LONG: '🔔 خروج از موقعیت خرید',
            EXIT_SHORT: '🔔 خروج از موقعیت فروش'
        };
        const text = `${titles[lastSignal.signalType]}\nنماد: ${item.symbol}\nاستراتژی: ${strategyDef.name}\nقیمت: ${lastPrice.toLocaleString()}`;
        await sendTelegramMessage(text);
        await stateColl.updateOne(
            { watchlistId },
            { $set: { lastNotifiedTime: lastSignal.time, lastNotifiedType: lastSignal.signalType } }
        );
        console.log(`📨 پیام ارسال شد: ${item.symbol} - ${lastSignal.signalType}`);
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
    const watchlist = await db.collection('watchlist').find({ enabled: true }).toArray();
    if (watchlist.length === 0) return;

    const distinctSymbols = [...new Set(watchlist.map(w => w.symbol))];
    const tehran = getTehranParts();
    const bucket30 = getBucketTime(tehran, 30);
    const bucket60 = getBucketTime(tehran, 60);

    for (const symbol of distinctSymbols) {
        const price = priceMap.get(symbol);
        if (!price) continue;
        await upsertCandle('candles_30m', symbol, bucket30, price);
        await upsertCandle('candles_1h', symbol, bucket60, price);
    }

    for (const item of watchlist) {
        await evaluateWatchlistItem(item);
    }

    console.log(`⏱ تیک اجرا شد - ${tehran.hour}:${tehran.minute} - ${distinctSymbols.length} نماد`);
}

// ==========================================================
// وضعیت کلی سرور
// ==========================================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        apiKeyConfigured: !!API_KEY,
        telegramConfigured: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
        symbolsCached: symbolsCache.length,
        marketOpenNow: isMarketOpen(getTehranParts())
    });
});

// ==========================================================
// راه‌اندازی
// ==========================================================
async function start() {
    await connectDB();
    await refreshSymbolsCache();

    // هر ۳ دقیقه (فقط داخل تابع بررسی می‌شود که آیا بازار باز است)
    cron.schedule('*/3 * * * *', async () => {
        const tehran = getTehranParts();
        if (!isMarketOpen(tehran)) return;
        try {
            await tick();
        } catch (err) {
            console.error('❌ خطا در tick:', err.message);
        }
    });

    // هر روز ساعت ۷ صبح به وقت تهران، کش نمادها را قبل از باز شدن بازار تازه کن
    cron.schedule('0 7 * * *', () => refreshSymbolsCache(), { timezone: 'Asia/Tehran' });

    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}

start().catch(err => {
    console.error('❌ خطا در راه‌اندازی سرور:', err);
    process.exit(1);
});
