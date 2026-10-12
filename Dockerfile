FROM node:22-alpine
WORKDIR /app
RUN mkdir -p /app/data && chown node:node /app /app/data
COPY --chown=node:node package.json server.mjs daily-feed.mjs daily-archive.mjs daily-history.mjs news-feed.mjs ./
COPY --chown=node:node public/ ./public/
USER node
ENV HOST=0.0.0.0 PORT=4319 DATA_DIR=/app/data
EXPOSE 4319
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4319/daily').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.mjs"]
