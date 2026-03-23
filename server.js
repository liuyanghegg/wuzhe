const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '.';
const DATA_FILE = path.join(DATA_DIR, 'codes.json');
const DATABASE_URL = process.env.DATABASE_URL;

// 静态文件
app.use(express.static('.'));
app.use(express.json());

// 创建 Tesseract Worker 池，复用语言包
let workerPool = null;
let dbPool = null;

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

async function initDatabase() {
    if (!DATABASE_URL) {
        console.log('未配置 DATABASE_URL，继续使用本地文件存储');
        return;
    }

    dbPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS invite_codes (
            id BIGSERIAL PRIMARY KEY,
            number VARCHAR(9) NOT NULL,
            timestamp BIGINT NOT NULL,
            date VARCHAR(10) NOT NULL,
            used BOOLEAN NOT NULL DEFAULT FALSE,
            used_at BIGINT,
            UNIQUE (date, number)
        )
    `);

    await dbPool.query('DELETE FROM invite_codes WHERE date <> $1', [getToday()]);
    console.log('✅ PostgreSQL 初始化完成');
}

// 文件上传（使用内存存储，不保存到磁盘）
const upload = multer({ storage: multer.memoryStorage() });

// 获取今天日期
function getToday() {
    return new Date().toISOString().split('T')[0];
}

// 数据缓存
let dataCache = null;
let dataCacheTime = 0;
const CACHE_TTL = 1000; // 缓存1秒

// 加载数据（返回今天的所有数据，区分已使用和未使用）
async function loadData() {
    const now = Date.now();
    // 使用缓存（1秒内有效）
    if (dataCache && (now - dataCacheTime) < CACHE_TTL) {
        return dataCache;
    }

    const today = getToday();

    if (dbPool) {
        await dbPool.query('DELETE FROM invite_codes WHERE date <> $1', [today]);
        const result = await dbPool.query(
            'SELECT id, number, timestamp, date, used, used_at AS "usedAt" FROM invite_codes WHERE date = $1 ORDER BY timestamp ASC',
            [today]
        );
        dataCache = result.rows;
        dataCacheTime = now;
        return result.rows;
    }
    
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

// 清除缓存（数据变更时调用）
function invalidateCache() {
    dataCache = null;
    dataCacheTime = 0;
}

// 保存数据
function saveData(data) {
    const today = getToday();
    data = data.filter(item => item.date === today);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    // 清除缓存
    invalidateCache();
}

// 首页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 获取列表（返回5个未使用和5个已使用的邀请码）
app.get('/api', (req, res) => {
    if (req.query.action === 'get') {
        loadData().then(allCodes => {
            // 分离未使用和已使用
            const unused = allCodes.filter(item => !item.used);
            const used = allCodes.filter(item => item.used);

            // 未使用：按时间正序（最早提交的在前），取前5个
            const sortedUnused = unused.sort((a, b) => a.timestamp - b.timestamp);
            const resultUnused = sortedUnused.slice(0, 5);

            // 已使用：按时间倒序，取最近5个
            const sortedUsed = used.sort((a, b) => b.timestamp - a.timestamp);
            const resultUsed = sortedUsed.slice(0, 5);

            res.json({ unused: resultUnused, used: resultUsed });
        }).catch(err => {
            console.error('读取数据失败:', err);
            res.json({ success: false, message: '读取数据失败' });
        });
    } else {
        res.json({ success: false, message: '未知操作' });
    }
});

// 标记已使用（标记used=true，不删除）
app.post('/api/mark_used', (req, res) => {
    const itemNumber = req.body.number;
    const itemId = req.body.id;
    const today = getToday();
    
    // 读取所有数据
    loadData().then(async allCodes => {
        if (dbPool) {
            const params = [today, Date.now()];
            let query = 'UPDATE invite_codes SET used = TRUE, used_at = $2 WHERE date = $1 AND used = FALSE';

            if (itemNumber) {
                params.push(itemNumber);
                query += ' AND number = $3';
            } else if (itemId !== undefined) {
                params.push(itemId);
                query += ' AND id = $3';
            }

            const result = await dbPool.query(query, params);
            invalidateCache();

            if (result.rowCount > 0) {
                res.json({ success: true });
            } else {
                res.json({ success: false, message: '未找到该邀请码或已使用' });
            }
            return;
        }

        let found = false;

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
            saveData(allCodes);
            res.json({ success: true });
        } else {
            res.json({ success: false, message: '未找到该邀请码或已使用' });
        }
    }).catch(err => {
        console.error('标记已使用失败:', err);
        res.json({ success: false, message: '操作失败' });
    });
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

        // 只处理目标截图分辨率，避免误识别其它类型图片
        if (width !== 1200 || height !== 1500) {
            return res.json({
                success: false,
                message: '请不要上传无关内容'
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

            if (dbPool) {
                if (!unusedCodes.some(item => item.number === code)) {
                    await dbPool.query(
                        'INSERT INTO invite_codes (number, timestamp, date, used) VALUES ($1, $2, $3, FALSE) ON CONFLICT (date, number) DO NOTHING',
                        [code, Date.now(), getToday()]
                    );
                    invalidateCache();
                }
            } else {
                // 检查是否已存在
                if (!unusedCodes.some(item => item.number === code)) {
                    const maxId = allCodes.length > 0 ? Math.max(...allCodes.map(item => item.id || 0)) : 0;
                    allCodes.push({
                        id: maxId + 1,
                        number: code,
                        timestamp: Date.now(),
                        date: getToday(),
                        used: false
                    });
                    saveData(allCodes);
                }
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
    await initDatabase();
    // 启动时初始化 Worker 池
    await initWorkerPool();
});
