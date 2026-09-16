FROM node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059 AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html tsconfig.app.json tsconfig.json tsconfig.node.json vite.config.ts ./
COPY public ./public
COPY src ./src

ARG CANVINK_COMMIT=self-hosted
ENV GITHUB_SHA=${CANVINK_COMMIT}

RUN pnpm build


FROM nginxinc/nginx-unprivileged:1.31.3-alpine3.24@sha256:59ccf0943b0b8e8d9e6ea9039a39555730f544701a655c596f7df7d096c593f5 AS runtime

COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=101:101 /app/dist/ /usr/share/nginx/html/

USER 101:101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
