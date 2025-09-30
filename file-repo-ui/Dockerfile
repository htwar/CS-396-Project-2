# --- Build stage ---
FROM node:20 AS build
WORKDIR /ui
COPY package*.json ./
RUN npm ci
COPY . .
# If your API is on a different host/path, set it at build time:
#   docker build ... --build-arg VITE_API_BASE=https://your-host:8443
ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

# --- Serve stage ---
FROM nginx:alpine
# SPA fallback so client routes work:
RUN sed -i 's|try_files .*;|try_files $uri $uri/ /index.html;|' /etc/nginx/conf.d/default.conf
COPY --from=build /ui/dist /usr/share/nginx/html
