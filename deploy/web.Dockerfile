# Prod web image: build the Vite SPA, then serve it (+ reverse-proxy /api) with
# Caddy (automatic HTTPS). Build context = repo root. Built in CI (GHCR).
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Sign-in is live: SES delivers the one-time codes (see docs/DEPLOY.md §6) and
# /auth/request is rate-limited. Set to false to hide the sign-in UI again.
ARG VITE_AUTH_ENABLED=true
ENV VITE_AUTH_ENABLED=$VITE_AUTH_ENABLED
# tsc + vite build + prerender (dist/ includes the /t/{slug} + /templates SEO pages).
RUN npm run build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
