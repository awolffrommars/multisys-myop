FROM node:20-slim

# Install Chromium + fonts
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=7860
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm install

COPY . .

EXPOSE 7860
CMD ["node", "server.js"]
