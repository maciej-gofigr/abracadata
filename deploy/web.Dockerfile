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
# Analytics (GA4 + Google Ads). Baked in at build time; empty = analytics off,
# which is what local/dev builds get. The GA measurement ID is not a secret (it
# ships in the page source of every site that uses it), so it defaults here
# rather than coming from CI — one less thing to configure, and no silent
# "analytics quietly off because a variable was unset".
ARG VITE_GA_MEASUREMENT_ID="G-424CLHS8GK"
# Google Ads base tag. Like the GA id, not a secret — it ships in the page
# source of every site that uses it.
ARG VITE_ADS_CONVERSION_ID="AW-18399245345"
ARG VITE_ADS_LABEL_SAVE_RECIPE=""
ARG VITE_ADS_LABEL_SIGN_UP=""
ENV VITE_GA_MEASUREMENT_ID=$VITE_GA_MEASUREMENT_ID \
    VITE_ADS_CONVERSION_ID=$VITE_ADS_CONVERSION_ID \
    VITE_ADS_LABEL_SAVE_RECIPE=$VITE_ADS_LABEL_SAVE_RECIPE \
    VITE_ADS_LABEL_SIGN_UP=$VITE_ADS_LABEL_SIGN_UP
# tsc + vite build + prerender (dist/ includes the /t/{slug} + /templates SEO pages).
RUN npm run build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
