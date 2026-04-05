# PDD 邀请码识别助手

自动识别拼多多福袋邀请码截图并管理邀请码。

## 功能

- OCR 自动识别邀请码
- 自动去重（重复上传会重置为未使用）
- 按使用时间排序显示已使用邀请码
- 支持 Supabase 云存储

## 部署到 Render

1. Fork 本仓库
2. 在 Render 创建新的 Web Service
3. 连接 GitHub 仓库
4. 设置环境变量：
   - `SUPABASE_URL`: Supabase 项目 URL
   - `SUPABASE_KEY`: Supabase API Key
   - `TZ`: `Asia/Shanghai`

## 本地运行

```bash
npm install
npm start
```

## 环境变量

| 变量 | 说明 |
|------|------|
| SUPABASE_URL | Supabase 项目 URL |
| SUPABASE_KEY | Supabase API Key |
| PORT | 端口号（默认 8080） |
| TZ | 时区（默认 Asia/Shanghai） |
