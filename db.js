const { MongoClient } = require('mongodb');

const uri = process.env.MONGO_URI;
let client;
let db;

async function connectDB() {
    if (db) return db;
    if (!uri) throw new Error('متغیر محیطی MONGO_URI تنظیم نشده است.');

    client = new MongoClient(uri);
    await client.connect();
    db = client.db('trading_bot');
    console.log('✅ اتصال به MongoDB برقرار شد.');

    await ensureIndexes(db);
    await cleanupLegacy(db);
    return db;
}

async function ensureIndexes(database) {
    const FORTY_FIVE_DAYS = 45 * 24 * 60 * 60;

    // کندل‌های پایه‌ی ۱ دقیقه‌ای (۴۵ روز)
    await database.collection('candles_base').createIndex({ time: 1 }, { expireAfterSeconds: FORTY_FIVE_DAYS });
    await database.collection('candles_base').createIndex({ symbol: 1, time: 1 }, { unique: true });

    await database.collection('signal_history').createIndex({ createdAt: -1 });
    await database.collection('signals_state').createIndex({ configId: 1 }, { unique: true });
    await database.collection('notify_queue').createIndex({ createdAt: 1 });

    console.log('✅ ایندکس‌های دیتابیس بررسی/ساخته شدند.');
}

async function cleanupLegacy(database) {
    try {
        await database.collection('meta').deleteMany({ _id: { $in: ['candlestick_usage', 'allsymbols_usage'] } });
        for (const name of ['seed_log', 'candles_tf']) {
            const cols = await database.listCollections({ name }).toArray();
            if (cols.length) await database.collection(name).drop();
        }
    } catch (e) { /* بی‌اهمیت */ }
}

function getDB() {
    if (!db) throw new Error('دیتابیس هنوز متصل نشده است.');
    return db;
}

module.exports = { connectDB, getDB };