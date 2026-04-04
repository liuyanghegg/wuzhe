require('dotenv').config({ path: __dirname + '/../config/.env' });

const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '.';
const DATA_FILE = path.join(DATA_DIR, 'codes.json');
const APP_TZ = process.env.TZ || 'Asia/Shanghai';
const TARGET_IMAGE_WIDTH = 1200;
const TARGET_IMAGE_HEIGHT = 1500;
const IMAGE_TOLERANCE = 100;

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

// 静态文件
app.use(express.static('.'));
app.use(express.json());

// 创建 Tesseract Worker 池，复用语言包
let workerPool = null;

async function initWorkerPool() {
    console.log('正在初始化 Tesseract Worker 池...');
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
    console.log('✅ Tesseract Worker 池初始化完成');
}

// 文件上传（使用内存存储，不保存到磁盘）
const upload = multer({ storage: multer.memoryStorage() });

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
        // 从 Supabase 查询今天的数据
        const { data, error } = await supabase
            .from('invite_codes')
            .select('*')
            .eq('date', today);
        
        if (error) {
            console.error('Supabase 查询错误:', error);
            return [];
        }
        
        // 转换数据格式
        const todayData = data.map(item => ({
            id: item.id,
            number: item.code,
            timestamp: new Date(item.created_at).getTime(),
            date: item.date,
            used: item.used,
            usedAt: item.used_at ? new Date(item.used_at).getTime() : undefined
        }));
        
        dataCache = todayData;
        dataCacheTime = now;
        return todayData;
    } else {
        // 本地文件存储
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            // 只保留今天的数据
            const todayData = data.filter(item => item.date === today);
            dataCache = todayData;
            dataCacheTime = now;
            return todayData;
        }
        dataCache = [];
        dataCacheTime = now;
        return [];
    }
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
    data = data.filter(item => item.date === today);
    
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

async function addCodeRecord(code) {
    await ensureDailyCleanup();

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

// 首页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 获取列表（返回5个未使用和5个已使用的邀请码）
app.get('/api', async (req, res) => {
    if (req.query.action === 'get') {
        const allCodes = await loadData();
        const today = getToday();
        
        // 分离未使用和已使用
        const unused = allCodes.filter(item => !item.used);
        const used = allCodes.filter(item => item.used);
        const counts = {
            unused: unused.length,
            used: used.length,
            total: allCodes.length
        };
        
        // 未使用：取最新的2条 + 最旧的3条
        const sortedByTime = unused.sort((a, b) => b.timestamp - a.timestamp);
        const newest = sortedByTime.slice(0, 2);
        const oldest = sortedByTime.slice(-3);
        const resultUnused = [...newest, ...oldest];

        // 已使用：按时间倒序，取前5个
        const sortedUsed = used.sort((a, b) => b.timestamp - a.timestamp);
        const resultUsed = sortedUsed.slice(0, 5);
        
        res.json({ unused: resultUnused, used: resultUsed, counts });
    } else {
        res.json({ success: false, message: '未知操作' });
    }
});

// 标记已使用（标记used=true，不删除）
app.post('/api/mark_used', async (req, res) => {
    const itemNumber = req.body.number;
    const itemId = req.body.id;
    const today = getToday();
    
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
app.post('/api/ocr', upload.single('image'), async (req, res) => {
    const startTime = Date.now();
    
    try {
        if (!req.file) {
            return res.json({ success: false, message: '没有上传图片' });
        }
        
        // 等待 Worker 池初始化完成
        if (!workerPool) {
            return res.json({ success: false, message: '系统正在初始化，请稍后再试' });
        }
        
        // 使用 sharp 处理图片：裁剪底部 35% 区域
        const image = sharp(req.file.buffer);
        const metadata = await image.metadata();
        const { width, height } = metadata;

        // 放宽目标截图分辨率范围，减少因轻微裁剪或缩放导致的误判
        if (!isAllowedImageSize(width, height)) {
            return res.json({
                success: false,
                message: '图片尺寸不符合要求，请上传接近 1200x1500 的截图'
            });
        }
        
        // 裁剪图片底部 35% 区域
        const cropTop = Math.floor(height * 0.65);
        const cropHeight = Math.floor(height * 0.35);
        
        // 裁剪并处理图片
        const rawCropBuffer = await image
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
        
        // 找出以7、8、9开头的9位数字
        const codes = [];
        if (allDigits.length >= 9) {
            for (let i = 0; i <= allDigits.length - 9; i++) {
                const candidate = allDigits.substring(i, i + 9);
                if (/^[789]/.test(candidate)) {
                    codes.push(candidate);
                }
            }
        }
        
        // 只有识别到以7、8、9开头的9位数字才保存
        if (codes.length > 0) {
            const code = codes[0];
            const allCodes = await loadData();
            const unusedCodes = allCodes.filter(item => !item.used);
            
            // 检查是否已存在
            if (!unusedCodes.some(item => item.number === code)) {
                await addCodeRecord(code);
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
