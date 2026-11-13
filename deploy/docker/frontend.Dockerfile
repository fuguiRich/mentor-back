# 前端（mentor-web / mentor-mobile）生产镜像：Vite 构建 + nginx 托管。
#
# 构建上下文是各自的前端项目根，Dockerfile 指到本文件：
#   docker build -f ../mentor-back/deploy/docker/frontend.Dockerfile \
#     --build-arg API_ENV_VAR=VITE_API_BASE --build-arg API_BASE=/api .
# 一般由 docker compose 调用，见 deploy/docker/docker-compose.yml。
#
# 容器内 nginx 同时负责：
#   - SPA 静态资源与 history 回退
#   - /api/ 反代到同网络的 mentor-back:3000（剥掉 /api 前缀）
# 宿主机只需要把域名转发到本容器的 80 端口。

FROM node:22-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@10

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=mentor-frontend-pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod=false

COPY . .

ARG API_ENV_VAR=VITE_API_BASE
ARG API_BASE=/api
RUN env "$API_ENV_VAR=$API_BASE" pnpm build \
  && test -f dist/index.html \
  && ! grep -RIl --include='*.js' --include='*.html' --include='*.css' -E 'localhost:(3000|3001)' dist

FROM nginx:1.27-alpine AS runtime

# 用 printf 写配置而不是 heredoc：不依赖 docker/dockerfile 外部 frontend 镜像，
# 内网 / 无外网镜像源的服务器也能构建。
RUN printf '%s\n' \
  'server {' \
  '    listen 80;' \
  '    server_name _;' \
  '' \
  '    root /usr/share/nginx/html;' \
  '    index index.html;' \
  '    client_max_body_size 20m;' \
  '' \
  '    # 后端在同 compose 网络里，服务名即主机名' \
  '    location /api/ {' \
  '        proxy_pass http://mentor-back:3000/;' \
  '        proxy_http_version 1.1;' \
  '        proxy_set_header Connection "";' \
  '        proxy_set_header Host $host;' \
  '        proxy_set_header X-Real-IP $remote_addr;' \
  '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
  '        proxy_set_header X-Forwarded-Proto $scheme;' \
  '        proxy_connect_timeout 5s;' \
  '        proxy_read_timeout 60s;' \
  '    }' \
  '' \
  '    location / {' \
  '        try_files $uri $uri/ /index.html;' \
  '    }' \
  '' \
  '    location = /index.html {' \
  '        add_header Cache-Control "no-store, must-revalidate";' \
  '    }' \
  '' \
  '    location ~* \.(?:js|css|woff2?|ttf|png|jpe?g|gif|svg|ico)$ {' \
  '        expires 30d;' \
  '        add_header Cache-Control "public, max-age=2592000, immutable";' \
  '        try_files $uri =404;' \
  '    }' \
  '}' \
  > /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]