FROM node:20-slim

WORKDIR /app

# 安装依赖
COPY package.json package-lock.json ./
RUN npm install --production

# 复制必要文件
COPY index.html server.js ./

# 环境变量
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

# 启动
CMD ["node", "server.js"]
