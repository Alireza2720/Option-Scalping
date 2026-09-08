'use strict';
// سیستم لاگ: نگه‌داری در حافظه (۳۰۰ رکورد آخر) + ذخیره‌ی warn/error در Mongo با TTL هفت روز
const RING = 300;
const mem = [];
let getDB = null;

const SECRETS = [
    [/key=[^&\s"']+/gi, 'key=***'],
    [/\/bot[^/\s"']+/g, '/bot***'],
    [/mongodb(\+srv)?:\/\/[^\s"']+/gi, 'mongodb://***']
];
const sanitize = s => SECRETS.reduce((t, [re, rep]) => t.replace(re, rep), s);
const fmt = a => a.map(x => x instanceof Error ? (x.stack || x.message) : (typeof x === 'object' && x !== null) ? JSON.stringify(x) : String(x)).join(' ');

function init(fn) { getDB = fn; }

function push(level, msg) {
    const e = { level, msg: sanitize(String(msg)).slice(0, 4000), at: new Date() };
    mem.push(e); if (mem.length > RING) mem.shift();
    if (getDB && level !== 'info') {
        try { getDB().collection('logs').insertOne(e).catch(() => {}); } catch (_) { /* دیتابیس هنوز وصل نیست */ }
    }
    return e;
}
function recent(limit = 200, level) {
    const a = level ? mem.filter(x => x.level === level) : mem;
    return a.slice(-limit).reverse();
}

const origLog = console.log, origWarn = console.warn, origErr = console.error;
function patchConsole() {
    console.log = (...a) => { origLog(...a); push('info', fmt(a)); };
    console.warn = (...a) => { origWarn(...a); push('warn', fmt(a)); };
    console.error = (...a) => { origErr(...a); push('error', fmt(a)); };
    process.on('unhandledRejection', r => push('error', 'unhandledRejection: ' + fmt([r])));
    process.on('uncaughtException', e => { push('error', 'uncaughtException: ' + fmt([e])); origErr(e); });
}

async function ensureIndexes(db) {
    // بدون TTL — لاگ‌های قدیمی به‌جای حذف، توسط archive.js منتقل می‌شوند
    try { await db.collection('logs').dropIndex('at_1'); } catch (e) {}
    await db.collection('logs').createIndex({ at: 1 });
    await db.collection('logs').createIndex({ level: 1, at: -1 });
}

module.exports = { init, push, recent, patchConsole, ensureIndexes };