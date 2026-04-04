# 邀请码小助手 - 项目结构说明

## 📁 项目目录结构

```
邀请码小助手/
├── src/                          # 源代码
│   ├── server.js                # Express 服务器主文件
│   └── index.html               # 前端页面
│
├── config/                       # 配置文件
│   ├── .env                     # 环境变量（敏感信息）
│   └── .env.example             # 环境变量示例
│
├── data/                         # 数据文件
│   ├── codes.json               # 邀请码数据
│   └── accounts_updated.txt     # 账户更新记录
│
├── docs/                         # 文档
│   ├── README.md                # 项目说明
│   └── supabase-schema.sql      # 数据库架构
│
├── logs/                         # 日志文件
│   └── local-run.log            # 运行日志
│
├── node_modules/                # Node 依赖（自动生成）
│
├── package.json                 # Node 项目配置
├── package-lock.json            # 依赖锁定文件
├── .gitignore                   # Git 忽略规则
└── PROJECT_STRUCTURE.md         # 本文件
```

## 📋 文件说明

### 核心文件
- **src/server.js** - Express 服务器，处理邀请码的上传、识别、查询
- **src/index.html** - 前端界面，用户交互入口

### 配置文件
- **config/.env** - 包含 Supabase 密钥等敏感信息（不要提交到 Git）
- **config/.env.example** - 环境变量模板

### 数据文件
- **data/codes.json** - 邀请码数据存储（JSON 格式）
- **data/accounts_updated.txt** - 账户更新记录

### 文档
- **docs/README.md** - 项目使用说明
- **docs/supabase-schema.sql** - 数据库表结构定义

### 日志
- **logs/local-run.log** - 服务运行日志

## 🚀 快速开始

1. **安装依赖**
   ```bash
   npm install
   ```

2. **配置环境**
   ```bash
   cp config/.env.example config/.env
   # 编辑 config/.env，填入 Supabase 密钥
   ```

3. **启动服务**
   ```bash
   npm start
   ```

4. **访问应用**
   打开浏览器访问 `http://localhost:8080`

## 📊 邀请码数据格式

```json
{
  "id": 1,
  "number": "775470416",
  "timestamp": 1772509306965,
  "date": "2026-03-03",
  "used": true,
  "usedAt": 1772509674302
}
```

- **id** - 唯一标识
- **number** - 9位邀请码（7/8/9开头）
- **timestamp** - 添加时间戳（毫秒）
- **date** - 添加日期（YYYY-MM-DD）
- **used** - 是否已使用
- **usedAt** - 使用时间戳（毫秒，仅已使用时有效）

## 🔒 安全提示

- ⚠️ 不要将 `config/.env` 文件提交到 Git
- ⚠️ 不要在代码中硬编码敏感信息
- ⚠️ 定期备份 `data/codes.json`

## 🛠️ 技术栈

- **Express** - Node.js Web 框架
- **Tesseract.js** - OCR 文字识别（识别图片中的邀请码）
- **Sharp** - 图片处理（裁剪、增强对比度）
- **Multer** - 文件上传处理
- **Supabase** - 云端数据库（可选，支持本地文件存储）
- **dotenv** - 环境变量管理

## 📝 整理日期

整理时间：2026-04-04 21:44 GMT+8

### 清理内容
- ✅ 删除 `qinglong-temp/` 目录（青龙面板 Render 方案，无关内容）
- ✅ 删除 `scripts/` 目录（Codex 代理启动脚本，无关内容）
- ✅ 删除 `src/check_db.py`（连接 codex-manager 数据库，无关内容）
- ✅ 删除 `build/` 目录（青龙面板 Docker 配置，无关内容）
- ✅ 删除 `__pycache__/` 目录（Python 缓存，由 check_db.py 产生）
