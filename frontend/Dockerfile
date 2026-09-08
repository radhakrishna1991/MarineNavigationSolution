# syntax=docker/dockerfile:1
#
# Frontend image: build the SPA, then serve the static bundle from nginx.

# ---- Build -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --workspace @amnp/frontend --include-workspace-root

COPY frontend ./frontend
COPY tsconfig.base.json* ./

# The API and WebSocket are reached through the same origin in the container
# deployment, so the bundle carries relative URLs and nginx proxies them.
ENV VITE_API_BASE_URL=""
ENV VITE_WS_URL=""

WORKDIR /app/frontend
RUN npm run build

# ---- Runtime ---------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

RUN apk add --no-cache curl

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

# nginx's own unprivileged variant listens on 8080; running as root just to bind
# port 80 is not worth it for a static bundle.
RUN chown -R nginx:nginx /usr/share/nginx/html \
    && sed -i 's|/var/run/nginx.pid|/tmp/nginx.pid|' /etc/nginx/nginx.conf \
    && sed -i '/^user /d' /etc/nginx/nginx.conf \
    && mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp \
    && chown -R nginx:nginx /var/cache/nginx

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
