# MDT – Container-Image (keine npm-Abhängigkeiten, nur Node.js ≥ 22.13 mit eingebautem SQLite)
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3847 \
    MDT_DATA_DIR=/data

ARG GIT_SHA=unknown
ENV APP_COMMIT=$GIT_SHA

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Datenordner (Datenbank, Bilder, Backups) – als Volume einbinden, damit nichts beim Update verloren geht
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

EXPOSE 3847
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3847)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
