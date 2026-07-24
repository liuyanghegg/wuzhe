const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'config', '.env'), override: true });

const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '.';
const DATA_FILE = path.join(DATA_DIR, 'codes.json');
const APP_TZ = process.env.TZ || 'Asia/Shanghai';
const TARGET_IMAGE_WIDTH = 1200;
const TARGET_IMAGE_HEIGHT = 1500;
const IMAGE_TOLERANCE = 100;
const OCR_MAX_CONCURRENT = parsePositiveInteger(process.env.OCR_MAX_CONCURRENT, 1);
const OCR_RATE_LIMIT_PER_MINUTE = parsePositiveInteger(process.env.OCR_RATE_LIMIT_PER_MINUTE, 3);
const OCR_RATE_LIMIT_PER_DAY = parsePositiveInteger(process.env.OCR_RATE_LIMIT_PER_DAY, 20);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Supabase 配置
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('✅ Supabase 客户端初始化完成');
} else {
    console.log('⚠️ 未配置 Supabase，使用本地文件存储');
}

// 静态文件只暴露前端目录，避免 data/config/logs 等文件被直接访问
app.set('trust proxy', 1);
app.use(express.static(__dirname, { index: false }));
app.use(express.json({ limit: '64kb' }));

// 创建 Tesseract Worker 池，复用语言包
let workerPool = null;
let chineseWorkerPool = null;

async function initWorkerPool() {
    console.log('正在初始化 Tesseract Worker 池(英文)...');
    workerPool = await Tesseract.createWorker('eng', 1, {
        logger: m => {
            if (m.status === 'loading tesseract core') {
                console.log('加载 Tesseract 核心...');
            } else if (m.status === 'loading language traineddata') {
                console.log('加载语言包...');
            }
        },
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
        load_system_dawg: false,
        load_freq_dawg: false,
        load_unambig_dawg: false,
        load_punc_dawg: false,
        load_number_dawg: false,
        load_bigram_dawg: false,
        tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
        preserve_interword_spaces: '0',
        textord_heavy_nr: '1',
        textord_fast_make_prop_words: '1',
        edges_use_new_outline_complexity: '0',
        classify_adapt_feature_threshold: '999',
        classify_enable_learning: '0',
        tessedit_do_invert: '0',
        user_words_dawg: '',
        user_patterns_dawg: ''
    });
    console.log('正在初始化 Tesseract Worker 池(中文)...');
    chineseWorkerPool = await Tesseract.createWorker('chi_sim+eng', 1, {
        logger: m => console.log(m.status, m.progress),
        tessedit_char_whitelist: '0123456789\u4e00-\u9fa5',
        tessedit_pageseg_mode: Tesseract.PSM.AUTO
    });
    console.log('✅ Tesseract Worker 池初始化完成');
}

// 文件上传（使用内存存储，不保存到磁盘）
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            cb(null, true);
            return;
        }

        cb(new Error('只支持上传图片文件'));
    }
});

function handleImageUpload(req, res, next) {
    upload.single('image')(req, res, err => {
        if (!err) {
            next();
            return;
        }

        const message = err.code === 'LIMIT_FILE_SIZE' ? '图片不能超过 8MB' : err.message;
        res.json({ success: false, message });
    });
}

// 获取今天日期
function getToday() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 数据缓存
let dataCache = null;
let dataCacheTime = 0;
const CACHE_TTL = 1000; // 缓存1秒
let lastCleanupDate = null;
let cleanupPromise = null;
let cleanupTimer = null;
let activeOcrJobs = 0;
const ocrRateLimits = new Map();

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getMsUntilNextMidnight() {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    return nextMidnight.getTime() - now.getTime();
}

function isAllowedImageSize(width, height) {
    return Math.abs(width - TARGET_IMAGE_WIDTH) <= IMAGE_TOLERANCE
        && Math.abs(height - TARGET_IMAGE_HEIGHT) <= IMAGE_TOLERANCE;
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const rawIp = Array.isArray(forwarded) ? forwarded[0] : forwarded || req.ip || req.socket.remoteAddress || 'unknown';
    return String(rawIp).split(',')[0].trim() || 'unknown';
}

function pruneOcrRateLimits(now, today) {
    for (const [ip, item] of ocrRateLimits.entries()) {
        if (item.date !== today && now - item.minuteStart > RATE_LIMIT_WINDOW_MS) {
            ocrRateLimits.delete(ip);
        }
    }
}

function limitOcrRequests(req, res, next) {
    const now = Date.now();
    const today = getToday();
    const ip = getClientIp(req);
    const current = ocrRateLimits.get(ip) || {
        date: today,
        dayCount: 0,
        minuteStart: now,
        minuteCount: 0
    };

    if (current.date !== today) {
        current.date = today;
        current.dayCount = 0;
    }

    if (now - current.minuteStart >= RATE_LIMIT_WINDOW_MS) {
        current.minuteStart = now;
        current.minuteCount = 0;
    }

    if (current.minuteCount >= OCR_RATE_LIMIT_PER_MINUTE) {
        return res.status(429).json({ success: false, message: '操作过于频繁，请稍后再试' });
    }

    if (current.dayCount >= OCR_RATE_LIMIT_PER_DAY) {
        return res.status(429).json({ success: false, message: '今日识别次数已达上限，请明天再试' });
    }

    current.minuteCount += 1;
    current.dayCount += 1;
    ocrRateLimits.set(ip, current);

    if (ocrRateLimits.size > 1000) {
        pruneOcrRateLimits(now, today);
    }

    next();
}

function acquireOcrSlot() {
    if (activeOcrJobs >= OCR_MAX_CONCURRENT) {
        return false;
    }

    activeOcrJobs += 1;
    return true;
}

function releaseOcrSlot() {
    activeOcrJobs = Math.max(0, activeOcrJobs - 1);
}

function isInviteCode(code) {
    return /^\d{8}$/.test(String(code || ''));
}

function normalizeCodeRecord(item) {
    return {
        id: item.id,
        number: item.number || item.code,
        timestamp: item.timestamp || (item.created_at ? new Date(item.created_at).getTime() : Date.now()),
        date: item.date,
        used: Boolean(item.used),
        usedAt: item.usedAt || (item.used_at ? new Date(item.used_at).getTime() : undefined)
    };
}

function pickCanonicalRecord(current, candidate) {
    if (!current) {
        return candidate;
    }

    // 只要同日同码曾被标记已用，就不再回到可用列表。
    if (candidate.used !== current.used) {
        return candidate.used ? candidate : current;
    }

    if (candidate.used) {
        return (candidate.usedAt || 0) > (current.usedAt || 0) ? candidate : current;
    }

    return (candidate.timestamp || 0) < (current.timestamp || 0) ? candidate : current;
}

function dedupeCodeRecords(records) {
    const byCode = new Map();

    for (const raw of records) {
        const item = normalizeCodeRecord(raw);
        if (!isInviteCode(item.number)) {
            continue;
        }

        byCode.set(item.number, pickCanonicalRecord(byCode.get(item.number), item));
    }

    return Array.from(byCode.values());
}

function mapDbRecord(item) {
    return normalizeCodeRecord(item);
}

async function cleanupExpiredCodes() {
    const today = getToday();

    if (supabase) {
        const { error } = await supabase
            .from('invite_codes')
            .delete()
            .lt('date', today);

        if (error) {
            throw new Error(`Supabase 清理过期邀请码失败: ${error.message}`);
        }
    } else if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const todayData = data.filter(item => item.date === today);

        if (todayData.length !== data.length) {
            fs.writeFileSync(DATA_FILE, JSON.stringify(todayData, null, 2));
        }
    }

    invalidateCache();
    lastCleanupDate = today;
}

async function ensureDailyCleanup() {
    const today = getToday();

    if (lastCleanupDate === today) {
        return;
    }

    if (!cleanupPromise) {
        cleanupPromise = (async () => {
            await cleanupExpiredCodes();
            console.log(`🧹 已完成 ${today} 的过期邀请码清理`);
        })().finally(() => {
            cleanupPromise = null;
        });
    }

    await cleanupPromise;
}

function scheduleNextCleanup() {
    if (cleanupTimer) {
        clearTimeout(cleanupTimer);
    }

    const delay = getMsUntilNextMidnight();
    console.log(`⏰ 已安排下次自动清理，时区 ${APP_TZ}，${Math.ceil(delay / 1000)} 秒后执行`);

    cleanupTimer = setTimeout(async () => {
        try {
            await cleanupExpiredCodes();
            console.log('🧹 零点自动清理完成');
        } catch (error) {
            console.error('❌ 零点自动清理失败:', error.message || error);
        } finally {
            scheduleNextCleanup();
        }
    }, delay);
}

// 加载数据（返回今天的所有数据，区分已使用和未使用）
async function loadData() {
    await ensureDailyCleanup();

    const now = Date.now();
    // 使用缓存（1秒内有效）
    if (dataCache && (now - dataCacheTime) < CACHE_TTL) {
        return dataCache;
    }
    
    const today = getToday();
    
    if (supabase) {
        // 使用分页查询获取所有数据（绕过 Supabase 默认 1000 条限制）
        const allData = [];
        let page = 0;
        const pageSize = 1000;
        
        while (true) {
            const { data, error } = await supabase
                .from('invite_codes')
                .select('*')
                .eq('date', today)
                .range(page * pageSize, (page + 1) * pageSize - 1);
            
            if (error) {
                console.error('Supabase 查询错误:', error);
                return [];
            }
            
            if (!data || data.length === 0) {
                break;
            }
            
            allData.push(...data);
            
            // 如果返回数据少于页大小，说明已经获取完所有数据
            if (data.length < pageSize) {
                break;
            }
            
            page++;
        }
        
        // 转换数据格式，并按邀请码去重
        const todayData = dedupeCodeRecords(allData.map(mapDbRecord));
        
        dataCache = todayData;
        dataCacheTime = now;
        console.log(`📊 已加载 ${todayData.length} 条今日邀请码`);
        return todayData;
    } else {
        // 本地文件存储
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            // 只保留今天的数据，并按邀请码去重
            const todayData = dedupeCodeRecords(data.filter(item => item.date === today));
            dataCache = todayData;
            dataCacheTime = now;
            return todayData;
        }
        dataCache = [];
        dataCacheTime = now;
        return [];
    }
}

function buildDashboardData(allCodes) {
    const unused = allCodes.filter(item => !item.used);
    const used = allCodes.filter(item => item.used);
    const counts = {
        unused: unused.length,
        used: used.length,
        total: allCodes.length
    };

    // 未使用：取最新的2条 + 最旧的3条
    const sortedByTime = [...unused].sort((a, b) => b.timestamp - a.timestamp);
    const newest = sortedByTime.slice(0, 2);
    const newestIds = new Set(newest.map(item => item.id));
    const oldest = sortedByTime
        .slice()
        .reverse()
        .filter(item => !newestIds.has(item.id))
        .slice(0, 3);

    const sortedUsed = [...used].sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));

    return {
        unused: [...newest, ...oldest],
        used: sortedUsed.slice(0, 5),
        counts
    };
}

function throwIfSupabaseError(result, label) {
    if (result.error) {
        throw new Error(`${label}: ${result.error.message}`);
    }
}

async function loadDashboardData() {
    await ensureDailyCleanup();

    if (!supabase) {
        return buildDashboardData(await loadData());
    }

    const today = getToday();
    const fields = 'id, code, date, used, used_at, created_at';
    const [
        unusedCountResult,
        usedCountResult,
        newestUnusedResult,
        oldestUnusedResult,
        usedResult
    ] = await Promise.all([
        supabase.from('invite_codes').select('id', { count: 'exact', head: true }).eq('date', today).eq('used', false),
        supabase.from('invite_codes').select('id', { count: 'exact', head: true }).eq('date', today).eq('used', true),
        supabase.from('invite_codes').select(fields).eq('date', today).eq('used', false).order('created_at', { ascending: false }).limit(2),
        supabase.from('invite_codes').select(fields).eq('date', today).eq('used', false).order('created_at', { ascending: true }).limit(5),
        supabase.from('invite_codes').select(fields).eq('date', today).eq('used', true).order('used_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(5)
    ]);

    throwIfSupabaseError(unusedCountResult, 'Supabase 查询可用数量失败');
    throwIfSupabaseError(usedCountResult, 'Supabase 查询已用数量失败');
    throwIfSupabaseError(newestUnusedResult, 'Supabase 查询最新可用邀请码失败');
    throwIfSupabaseError(oldestUnusedResult, 'Supabase 查询最旧可用邀请码失败');
    throwIfSupabaseError(usedResult, 'Supabase 查询已用邀请码失败');

    const newestUnused = dedupeCodeRecords(newestUnusedResult.data.map(mapDbRecord));
    const newestIds = new Set(newestUnused.map(item => item.id));
    const oldestUnused = dedupeCodeRecords(oldestUnusedResult.data.map(mapDbRecord))
        .filter(item => !newestIds.has(item.id))
        .slice(0, 3);
    const recentUsed = dedupeCodeRecords(usedResult.data.map(mapDbRecord));
    const unusedCount = unusedCountResult.count || 0;
    const usedCount = usedCountResult.count || 0;

    return {
        unused: [...newestUnused, ...oldestUnused],
        used: recentUsed,
        counts: {
            unused: unusedCount,
            used: usedCount,
            total: unusedCount + usedCount
        }
    };
}

// 清除缓存（数据变更时调用）
function invalidateCache() {
    dataCache = null;
    dataCacheTime = 0;
}

async function preloadSupabaseCache(maxRetries = 5, retryDelay = 3000) {
    if (!supabase) {
        return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            invalidateCache();
            const data = await loadData();
            console.log(`✅ 启动预拉取完成，已缓存 ${data.length} 条今日邀请码`);
            return;
        } catch (error) {
            console.error(`❌ 启动预拉取失败（第 ${attempt}/${maxRetries} 次）:`, error.message || error);

            if (attempt < maxRetries) {
                await sleep(retryDelay);
            }
        }
    }

    console.error('⚠️ 启动预拉取多次失败，后续将继续使用按需拉取');
}

// 保存数据
async function saveData(data) {
    await ensureDailyCleanup();

    const today = getToday();
    data = dedupeCodeRecords(data.filter(item => item.date === today));
    
    if (supabase) {
        // 清除今天的数据，然后重新插入
        const { error: deleteError } = await supabase
            .from('invite_codes')
            .delete()
            .eq('date', today);

        if (deleteError) {
            throw new Error(`Supabase 删除错误: ${deleteError.message}`);
        }
        
        // 批量插入数据
        if (data.length > 0) {
            const insertData = data.map(item => ({
                code: item.number,
                date: item.date,
                used: item.used,
                used_at: item.usedAt ? new Date(item.usedAt).toISOString() : null,
                created_at: new Date(item.timestamp).toISOString()
            }));
            
            const { error } = await supabase
                .from('invite_codes')
                .insert(insertData);
            
            if (error) {
                throw new Error(`Supabase 插入错误: ${error.message}`);
            }
        }
    } else {
        // 本地文件存储
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    }
    
    // 清除缓存
    invalidateCache();
}

async function findExistingCodeRecord(code) {
    if (!isInviteCode(code)) {
        return null;
    }

    const today = getToday();

    if (supabase) {
        const { data, error } = await supabase
            .from('invite_codes')
            .select('id, code, date, used, used_at, created_at')
            .eq('date', today)
            .eq('code', code)
            .order('used', { ascending: false })
            .order('used_at', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: true })
            .limit(1);

        if (error) {
            throw new Error(`Supabase 查询邀请码失败: ${error.message}`);
        }

        return data && data.length > 0 ? mapDbRecord(data[0]) : null;
    }

    const allCodes = await loadData();
    return allCodes.find(item => item.number === code) || null;
}

async function addCodeRecord(code) {
    await ensureDailyCleanup();

    const existing = await findExistingCodeRecord(code);
    if (existing) {
        return { ...existing, duplicate: true };
    }

    const now = Date.now();
    const record = {
        number: code,
        timestamp: now,
        date: getToday(),
        used: false
    };

    if (supabase) {
        const { data, error } = await supabase
            .from('invite_codes')
            .insert({
                code: record.number,
                date: record.date,
                used: false,
                used_at: null,
                created_at: new Date(record.timestamp).toISOString()
            })
            .select('id, code, date, used, used_at, created_at')
            .single();

        if (error) {
            if (error.code === '23505') {
                const duplicate = await findExistingCodeRecord(code);
                if (duplicate) {
                    return { ...duplicate, duplicate: true };
                }
            }

            throw new Error(`Supabase 上传同步失败: ${error.message}`);
        }

        invalidateCache();

        return {
            id: data.id,
            number: data.code,
            timestamp: new Date(data.created_at).getTime(),
            date: data.date,
            used: data.used,
            usedAt: data.used_at ? new Date(data.used_at).getTime() : undefined
        };
    }

    const allCodes = await loadData();
    const maxId = allCodes.length > 0 ? Math.max(...allCodes.map(item => item.id || 0)) : 0;
    const newRecord = {
        id: maxId + 1,
        ...record
    };

    allCodes.push(newRecord);
    await saveData(allCodes);
    return newRecord;
}

app.get('/healthz', (req, res) => {
    res.json({
        status: 'ok',
        ready: Boolean(workerPool && chineseWorkerPool),
        storage: supabase ? 'supabase' : 'local',
        activeOcrJobs,
        ocrMaxConcurrent: OCR_MAX_CONCURRENT
    });
});

// 首页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 获取列表（返回5个未使用和5个已使用的邀请码）
app.get('/api', async (req, res) => {
    if (req.query.action === 'get') {
        try {
            res.json(await loadDashboardData());
        } catch (error) {
            console.error('获取邀请码列表失败:', error.message || error);
            res.status(500).json({ success: false, message: '获取邀请码列表失败' });
        }
    } else {
        res.json({ success: false, message: '未知操作' });
    }
});

// 标记已使用（标记used=true，不删除）
app.post('/api/mark_used', async (req, res) => {
    const itemNumber = req.body.number;
    const itemId = req.body.id;
    const today = getToday();

    if (supabase) {
        if (!isInviteCode(itemNumber) && itemId === undefined) {
            return res.json({ success: false, message: '未找到该邀请码或已使用' });
        }

        let query = supabase
            .from('invite_codes')
            .update({ used: true, used_at: new Date().toISOString() })
            .eq('date', today)
            .eq('used', false)
            .select('id');

        if (itemId !== undefined) {
            query = query.eq('id', itemId);
        } else {
            query = query.eq('code', itemNumber);
        }

        const { data, error } = await query.maybeSingle();

        if (error) {
            return res.json({ success: false, message: error.message });
        }

        if (!data) {
            return res.json({ success: false, message: '未找到该邀请码或已使用' });
        }

        invalidateCache();
        return res.json({ success: true });
    }

    // 读取所有数据
    let allCodes = await loadData();
    let found = false;
    
    // 查找并标记
    for (let item of allCodes) {
        if (item.date === today && !item.used) {
            if ((itemNumber && item.number === itemNumber) || (itemId !== undefined && item.id === itemId)) {
                item.used = true;
                item.usedAt = Date.now();
                found = true;
                break;
            }
        }
    }
    
    if (found) {
        await saveData(allCodes);
        res.json({ success: true });
    } else {
        res.json({ success: false, message: '未找到该邀请码或已使用' });
    }
});

// OCR 识别并自动保存
app.post('/api/ocr', limitOcrRequests, handleImageUpload, async (req, res) => {
    const startTime = Date.now();
    let ocrSlotAcquired = false;
    
    try {
        if (!req.file) {
            return res.json({ success: false, message: '没有上传图片' });
        }
        
        // 等待 Worker 池初始化完成
        if (!workerPool || !chineseWorkerPool) {
            return res.json({ success: false, message: '系统正在初始化，请稍后再试' });
        }

        if (!acquireOcrSlot()) {
            return res.status(429).json({ success: false, message: '系统正在识别其他图片，请稍后再试' });
        }
        ocrSlotAcquired = true;

        // 获取图片尺寸
        const image = sharp(req.file.buffer);
        const metadata = await image.metadata();
        const { width, height } = metadata;

        if (!isAllowedImageSize(width, height)) {
            return res.json({
                success: false,
                message: '图片尺寸不符合要求，请上传接近 1200x1500 的截图'
            });
        }

        // 优化：只识别头部50%检测"福袋"（更快）
        const headHeight = Math.floor(height * 0.5);
        const headBuffer = await sharp(req.file.buffer)
            .extract({ left: 0, top: 0, width: width, height: headHeight })
            .resize(800)
            .grayscale()
            .toBuffer();
        const headResult = await chineseWorkerPool.recognize(headBuffer);
        const headText = headResult.data.text.replace(/\s/g, '');

        if (!headText.includes('福袋')) {
            console.log('❌ OCR 拒绝: 图片不包含"福袋"关键词');
            return res.json({ success: false, message: '请上传正确的拼多多邀请码助力图片' });
        }

        // 裁剪图片底部 35% 区域识别邀请码
        const cropTop = Math.floor(height * 0.65);
        const cropHeight = Math.min(Math.floor(height * 0.35), height - cropTop);
        
        // 裁剪并处理图片
        const rawCropBuffer = await sharp(req.file.buffer)
            .extract({ left: 0, top: cropTop, width: width, height: cropHeight })
            .resize(800, null, { withoutEnlargement: true })
            .toBuffer();
        
        // 图像增强处理：灰度+二值化(阈值200)
        const processedBuffer = await sharp(rawCropBuffer)
            .grayscale()
            .threshold(200)
            .toBuffer();
        
        // OCR识别
        const result = await workerPool.recognize(processedBuffer, 'eng');
        let text = result.data.text;
        
        // 提取数字：去空格后提取所有数字
        const allDigits = text.replace(/\s/g, '').replace(/\D/g, '');
        
        // 找出连续8位数字
        const codes = [];
        const seenCodes = new Set();
        if (allDigits.length >= 8) {
            for (let i = 0; i <= allDigits.length - 8; i++) {
                const candidate = allDigits.substring(i, i + 8);
                if (isInviteCode(candidate) && !seenCodes.has(candidate)) {
                    seenCodes.add(candidate);
                    codes.push(candidate);
                }
            }
        }
        
        // 只有识别到8位连续数字才保存
        if (codes.length > 0) {
            const code = codes[0];

            const saved = await addCodeRecord(code);
            if (saved.duplicate) {
                console.log(`ℹ️ OCR 检测到重复邀请码，跳过: ${code}`);
            } else {
                console.log(`✅ OCR 上传后已同步到数据库: ${code}`);
            }
        }
        
        console.log('识别结果:', codes, '耗时:', Date.now() - startTime, 'ms');
        
        res.json({
            success: true,
            codes: codes
        });
        
    } catch (err) {
        console.error('OCR 错误:', err);
        res.json({ success: false, message: err.message });
    } finally {
        if (ocrSlotAcquired) {
            releaseOcrSlot();
        }
    }
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`服务器运行在端口 ${PORT}`);
    // 启动时初始化 Worker 池
    await initWorkerPool();
    await ensureDailyCleanup();
    // 启动完成后预拉取一次当天邀请码到缓存
    await preloadSupabaseCache();
    scheduleNextCleanup();
});
