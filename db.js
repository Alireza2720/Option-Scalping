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
    return db;
}

async function ensureIndexes(database) {
    const FORTY_FIVE_DAYS = 45 * 24 * 60 * 60;

    // یک کالکشن واحد برای کندل‌های پایه (خام)، فارغ از تایم‌فریم نهایی.
    // تبدیل به هر تایم‌فریم دلخواه (۳ دقیقه تا ۱ روزه) در لحظه انجام می‌شود.
    await database.collection('candles_base').createIndex(
        { time: 1 },
        { expireAfterSeconds: FORTY_FIVE_DAYS }
    );
    await database.collection('candles_base').createIndex(
        { symbol: 1, time: 1 },
        { unique: true }
    );

    console.log('✅ ایندکس‌های دیتابیس بررسی/ساخته شدند.');
}

function getDB() {
    if (!db) throw new Error('دیتابیس هنوز متصل نشده است.');
    return db;
}

module.exports = { connectDB, getDB };
