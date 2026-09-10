'use strict';
const { MongoClient } = require('mongodb');

const SAFETY_MB = +(process.env.ARCHIVE_SAFETY_MB || 450);
const URIS = [
    process.env.MONGO_URI_ARCHIVE_1, process.env.MONGO_URI_ARCHIVE_2,
    process.env.MONGO_URI_ARCHIVE_3, process.env.MONGO_URI_ARCHIVE_4, process.env.MONGO_URI_ARCHIVE_5
].filter(Boolean);

const clients = new Map(); // uri -> { client, db }

async function connectOne(uri) {
    if (clients.has(uri)) return clients.get(uri);
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db('trading_bot_archive');
    await db.collection('candles_base').createIndex({ symbol: 1, time: 1 }, { unique: true }).catch(() => {});
    await db.collection('option_snapshots').createIndex({ symbol: 1, time: 1 }).catch(() => {});
    await db.collection('telegram_outbox').createIndex({ createdAt: 1 }).catch(() => {});
    await db.collection('logs').createIndex({ at: 1 }).catch(() => {});
    const entry = { client, db };
    clients.set(uri, entry);
    console.log(`✅ اتصال به دیتابیس آرشیو برقرار شد (${uri.slice(0, 25)}...)`);
    return entry;
}
async function dbSizeMB(db) {
    try { const st = await db.stats(); return (st.storageSize + st.indexSize) / 1048576; } catch (e) { return null; }
}
// اولین دیتابیس آرشیوی که هنوز جا دارد
async function pickArchiveDB() {
    for (const uri of URIS) {
        try {
            const { db } = await connectOne(uri);
            const mb = await dbSizeMB(db);
            if (mb === null || mb < SAFETY_MB) return { db, mb, uri };
        } catch (e) { console.error('❌ اتصال به یکی از دیتابیس‌های آرشیو ناموفق:', e.message); }
    }
    return null;
}
const hasArchive = () => URIS.length > 0;

// خواندن کندل‌های خام ۱ دقیقه‌ای یک نماد از همه‌ی دیتابیس‌های آرشیو (فقط برای نمودار/بک‌تست، نه مسیر تیک زنده)
const archiveCandlesCache = new Map(); // symbol -> { at, data }
async function getArchivedBaseCandles(symbol, maxAgeMs = 60000) {
    if (!URIS.length) return [];
    const cached = archiveCandlesCache.get(symbol);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.data;
    const out = [];
    for (const uri of URIS) {
        try {
            const { db } = await connectOne(uri);
            const rows = await db.collection('candles_base').find({ symbol }).sort({ time: 1 }).toArray();
            rows.forEach(r => out.push({ time: Math.floor(new Date(r.time).getTime() / 1000), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume || 0 }));
        } catch (e) { console.error(`❌ خواندن کندل آرشیو (${uri.slice(0, 20)}...):`, e.message); }
    }
    archiveCandlesCache.set(symbol, { at: Date.now(), data: out });
    return out;
}

// انتقال (نه حذف واقعی) اسناد قدیمی‌تر از cutoffDate از primaryDB به آرشیو
async function moveOldDocs(primaryDB, collectionName, dateField, cutoffDate, batchSize = 500) {
    if (!URIS.length) return { moved: 0, skipped: 'no-archive-configured' };
    const target = await pickArchiveDB();
    if (!target) { console.error(`⚠️ همه‌ی دیتابیس‌های آرشیو پر هستند — ${collectionName} آرشیو نشد؛ داده در دیتابیس اصلی باقی ماند.`); return { moved: 0, full: true }; }
    const col = primaryDB.collection(collectionName);
    let moved = 0;
    for (;;) {
        const batch = await col.find({ [dateField]: { $lt: cutoffDate } }).limit(batchSize).toArray();
        if (!batch.length) break;
        try { await target.db.collection(collectionName).insertMany(batch, { ordered: false }); }
        catch (e) { if (!/duplicate key/i.test(e.message)) throw e; } // اگر قبلاً آرشیو شده، مشکلی نیست
        await col.deleteMany({ _id: { $in: batch.map(d => d._id) } }); // حذف از اصلی فقط بعد از تضمین ذخیره در آرشیو
        moved += batch.length;
        if (batch.length < batchSize) break;
    }
    return { moved, archivedTo: target.uri.slice(0, 25) + '...' };
}
async function allArchiveStats() {
    if (!URIS.length) return [];
    const out = [];
    for (const uri of URIS) {
        try {
            const { db } = await connectOne(uri);
            const mb = await dbSizeMB(db);
            out.push({ index: out.length + 1, mb: mb === null ? null : +mb.toFixed(1) });
        } catch (e) {
            out.push({ index: out.length + 1, error: 'اتصال ناموفق' });
        }
    }
    return out;
}
module.exports = { hasArchive, moveOldDocs, allArchiveStats, pickArchiveDB, getArchivedBaseCandles, SAFETY_MB };