FROM node:trixie-slim AS builder

WORKDIR /usr/src/app

# 安装构建原生模块（如 better-sqlite3）所需的工具链
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*

# 仅拷贝依赖清单，利用缓存
COPY package*.json ./

# npm install 会触发 prepare -> build:css
# 先提供 Tailwind/PostCSS 构建所需的最小文件集，避免 "input.css does not exist" 直接失败
COPY tailwind.config.js postcss.config.js ./
COPY public/css/src/input.css ./public/css/src/input.css

# 安装所有依赖（包含构建 Tailwind CSS 所需的 devDependencies）
RUN npm install

# 拷贝项目源码（显式列举，避免把宿主机的 node_modules 带进镜像导致 native 模块 ELF 错误）
COPY src ./src
COPY public ./public
COPY bin ./bin
COPY tests ./tests
COPY docs ./docs
COPY images ./images
COPY README.md LICENSE CLAUDE.md config.example.json ./

# 明确执行一次 CSS 构建（prepare 钩子中也会执行，冗余但安全）
RUN npm run build:css

#
# 运行阶段镜像
#
FROM node:trixie-slim AS runner

ENV NODE_ENV=production
WORKDIR /usr/src/app

# 运行时仅需 SQLite 运行库
RUN apt-get update && apt-get install -y \
    libsqlite3-0 \
  && rm -rf /var/lib/apt/lists/*

# 从构建阶段拷贝整个应用目录（含 node_modules 与构建产物）
COPY --from=builder /usr/src/app /usr/src/app

# 创建默认配置文件（基于仓库内的 config.example.json）
# 注意：如果运行时把 /home/node/.config/antigravity-proxy 整个目录 volume 覆盖掉，
# 那么宿主机目录里仍需要自行提供 config.json（或不挂载该目录）。
RUN mkdir -p /home/node/.config/antigravity-proxy \
  && if [ ! -f /home/node/.config/antigravity-proxy/config.json ]; then \
       cp /usr/src/app/config.example.json /home/node/.config/antigravity-proxy/config.json; \
     fi \
  && chown -R node:node /home/node/.config/antigravity-proxy

# 删除 devDependencies，减小运行镜像体积
RUN npm prune --omit=dev

# 使用 node 用户运行，提升安全性
USER node

# 默认监听端口（代码中也会读取 PORT 环境变量）
EXPOSE 8080

# 启动服务
CMD ["npm", "start"]

