FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @nekro-nxt/server... --filter @nekro-nxt/web... run build
RUN pnpm --filter @nekro-nxt/server deploy --prod --legacy /release/server

FROM node:22-bookworm-slim AS runtime

ARG NEKRO_RELEASE_ID=0.0.0+local

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 nekro \
  && useradd --system --uid 10001 --gid nekro --home-dir /data --shell /usr/sbin/nologin nekro \
  && mkdir -p /data /opt/nekro/web/dist \
  && chown nekro:nekro /data

COPY --from=build --chown=root:root /release/server /opt/nekro/server
COPY --from=build --chown=root:root /workspace/apps/web/dist /opt/nekro/web/dist
RUN chmod -R a=rX /opt/nekro

ENV NODE_ENV=production \
  NEKRO_DATA=/data \
  NEKRO_DIST_INDEX=/opt/nekro/web/dist/index.html \
  NEKRO_HOST=0.0.0.0 \
  NEKRO_PORT=4960 \
  NEKRO_RELEASE_ID=${NEKRO_RELEASE_ID}

WORKDIR /data
USER nekro
EXPOSE 4960
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('node:https').get({hostname:'127.0.0.1',port:4960,path:'/health/ready',rejectUnauthorized:false},r=>{const ok=r.statusCode===200;r.resume();r.on('end',()=>process.exit(ok?0:1))}).on('error',()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/nekro/server/dist/main.mjs"]
