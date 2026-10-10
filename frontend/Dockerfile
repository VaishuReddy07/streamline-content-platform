FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
ARG VITE_PARTNER_EXPORT_MODE=mock
ENV VITE_PARTNER_EXPORT_MODE=$VITE_PARTNER_EXPORT_MODE
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
