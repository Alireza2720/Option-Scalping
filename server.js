const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { connectDB, getDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.BRSAPI_KEY;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.json());

// ==========================================================
// سرو کردن فایل مشترک strategies.js برای استفاده در فرانت‌اند
// (همچنین کل پوشه public در صورت نیاز آینده)
// ==========================================================
app.get('/strategies.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'strategies.js'));
});

const { STRATEGIES } = require('./strategies.js');

// ==========================================================
// کش لیست نمادهای بازار (برای autocomplete)
// ==========================================================
let symbolsCache = [];
let symbolsCacheUpdatedAt = null;

async function refreshSymbolsCache() {
    try {
        const url = `https://Api.BrsApi.ir/Tsetmc/AllSymbols.php?key=${API_KEY}&type=1`;
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json, text/plain, */*' },
            timeout: 20000
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        // فقط فیلدهای لازم برای جستجو و نمایش نگه داشته می‌شود
        symbolsCache = data.map(s => ({
            symbol: s.l18,
            name: s.l30,
            price: s.pl
        }));
        symbolsCacheUpdatedAt = new Date();
        console.log(`✅ کش نمادها به‌روزرسانی شد: ${symbolsCache.length} نماد`);
    } catch (err) {
        console.error('❌ خطا در به‌روزرسانی کش نمادها:', err.message);
    }
}

app.get('/api/symbols/search', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const results = symbolsCache
        .filter(s => s.symbol.includes(q) || s.name.includes(q))
        .slice(0, 20);
    res.json(results);
});

app.get('/api/symbols/status', (req, res) => {
    res.json({
        count: symbolsCache.length,
        updatedAt: symbolsCacheUpdatedAt
    });
});

// ==========================================================
// اطلاعات استراتژی‌ها (بدون تابع run، فقط برای ساخت UI در فرانت)
// ==========================================================
app.get('/api/strategies', (req, res) => {
    const list = Object.values(STRATEGIES).map(s => ({
        id: s.id,
        name: s.name,
        timeframe: s.timeframe,
        defaultParams: s.defaultParams
    }));
    res.json(list);
});

// ==========================================================
// مدیریت Watchlist (نماد + استراتژی + پارامترهای انتخابی کاربر)
// ==========================================================
app.get('/api/watchlist', async (req, res) => {
    try {
        const db = getDB();
        const items = await db.collection('watchlist').find({}).toArray();
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
        const { ObjectId } = require('mongodb');
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
        const { ObjectId } = require('mongodb');
        const db = getDB();
        await db.collection('watchlist').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================================
// شمارش سهمیه کندل‌استیک (ذخیره در دیتابیس تا با ری‌استارت سرور از بین نرود)
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
        await db.collection('meta').updateOne(
            { _id: 'candlestick_usage' },
            { $set: doc },
            { upsert: true }
        );
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

app.get('/api/candlestick', async (req, res) => {
    const { symbol, type = '1' } = req.query;
    if (!symbol) {
        return res.status(400).json({ error: 'پارامتر symbol الزامی است' });
    }

    try {
        const usage = await getUsageDoc();
        if (usage.count >= 10) {
            return res.status(429).json({ error: 'سهمیه روزانه Candlestick به پایان رسیده است.' });
        }

        const url = `https://Api.BrsApi.ir/Tsetmc/Candlestick.php?key=${API_KEY}&type=${type}&l18=${encodeURIComponent(symbol)}`;
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json, text/plain, */*' },
            timeout: 15000
        });

        await incrementUsage();

        if (!response.ok) {
            return res.status(response.status).json({ error: `BrsApi با کد ${response.status} پاسخ داد` });
        }

        const data = await response.json();
        res.json(data);

    } catch (err) {
        res.status(502).json({ error: 'خطا در ارتباط با BrsApi: ' + err.message });
    }
});

app.get('/api/usage', async (req, res) => {
    const usage = await getUsageDoc();
    res.json({
        date: usage.date,
        candlestick: `${usage.count}/10`
    });
});

// ==========================================================
// وضعیت کلی سرور
// ==========================================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        apiKeyConfigured: !!API_KEY,
        dbConnected: true,
        symbolsCached: symbolsCache.length
    });
});

// ==========================================================
// راه‌اندازی سرور
// ==========================================================
async function start() {
    await connectDB();
    await refreshSymbolsCache();
    setInterval(refreshSymbolsCache, 6 * 60 * 60 * 1000); // هر ۶ ساعت یک‌بار

    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}

start().catch(err => {
    console.error('❌ خطا در راه‌اندازی سرور:', err);
    process.exit(1);
});
