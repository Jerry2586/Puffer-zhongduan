FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/reset-admin.mjs ./scripts/reset-admin.mjs
ENV NODE_ENV=production HETUN_TERMINAL_STATE=/data HETUN_TERMINAL_HOST=0.0.0.0 HETUN_TERMINAL_PORT=8792
USER node
EXPOSE 8792
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8792/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
