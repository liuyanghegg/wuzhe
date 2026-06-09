# PDD 邀请码识别助手

自动识别拼多多福袋邀请码截图并管理邀请码。

## 功能

- OCR 自动识别邀请码
- 自动去重（同一天同一邀请码只保留一次，重复上传不会重置已使用状态）
- 按使用时间排序显示已使用邀请码
- 支持 Supabase 云存储

## 部署到 Render

1. Fork 本仓库
2. 在 Render 创建新的 Web Service
3. 连接 GitHub 仓库
4. 设置环境变量：
   - `SUPABASE_URL`: Supabase 项目 URL
   - `SUPABASE_KEY`: Supabase service_role API Key
   - `TZ`: `Asia/Shanghai`
   - `OCR_MAX_CONCURRENT`: `1`（免费实例建议保持 1）
   - `OCR_RATE_LIMIT_PER_MINUTE`: `3`
   - `OCR_RATE_LIMIT_PER_DAY`: `20`

## 本地运行

```bash
npm install
npm start
```

## 环境变量

| 变量 | 说明 |
|------|------|
| SUPABASE_URL | Supabase 项目 URL |
| SUPABASE_KEY | Supabase service_role API Key |
| PORT | 端口号（默认 8080） |
| TZ | 时区（默认 Asia/Shanghai） |
| OCR_MAX_CONCURRENT | OCR 并发数（默认 1） |
| OCR_RATE_LIMIT_PER_MINUTE | 每 IP 每分钟 OCR 次数（默认 3） |
| OCR_RATE_LIMIT_PER_DAY | 每 IP 每天 OCR 次数（默认 20） |
