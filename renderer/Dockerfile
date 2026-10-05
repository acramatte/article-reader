FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
RUN apt-get update -qq && apt-get install -y --no-install-recommends iptables=1.8.10-3ubuntu2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts && npm cache clean --force && node -e "if(require('@playwright/test/package.json').version !== '1.63.0')process.exit(1)"
COPY article.mjs ./
COPY renderer/proxy.mjs renderer/service.mjs ./renderer/
COPY --chmod=755 renderer/entrypoint.sh ./renderer/
USER pwuser
ENV NODE_ENV=production
CMD ["node", "renderer/service.mjs"]
