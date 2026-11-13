# mentor-back 生产镜像（多阶段：builder 负责编译，runtime 只带运行所需文件）
#
# 构建上下文是后端项目根（mentor-back/）：
#   docker build -f deploy/docker/backend.Dockerfile -t mentor-back:local .
# 一般由 docker compose 调用，见 deploy/docker/docker-compose.yml。

FROM node:22-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Prisma 引擎依赖 openssl；bookworm-slim 不自带
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10

WORKDIR /app

# 依赖层单独缓存：package / lock 没变就不重装
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=mentor-pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod=false

COPY prisma ./prisma
RUN pnpm exec prisma generate

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# 运行 + 迁移 + 首次 seed 都需要 node_modules：
# - prisma CLI 在 devDependencies，迁移服务直接调 node_modules/.bin/prisma
# - seed.ts 用 ts-node 跑，因此保留完整 node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
# ts-node 读 tsconfig
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# 上传目录：命名卷首次挂载时会继承这里的属主
RUN mkdir -p /data/uploads && chown -R node:node /app /data/uploads

USER node
EXPOSE 3000

# 容器内健康检查用 node 自带 fetch（镜像里不装 curl）
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]