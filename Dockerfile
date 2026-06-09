FROM node:20-slim

# Install Chromium + fonts + curl (curl fetches template PNGs from GitHub at build time)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto \
    ca-certificates \
    curl \
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

# Download template PNGs from GitHub (too large for HF git — stored in GitHub repo)
RUN curl -sL "https://raw.githubusercontent.com/awolffrommars/multisys-myop/main/templates/Birthday%20Poster_Template.png" \
         -o "templates/Birthday Poster_Template.png" && \
    curl -sL "https://raw.githubusercontent.com/awolffrommars/multisys-myop/main/templates/New%20Employee%20Poster_Template.png" \
         -o "templates/New Employee Poster_Template.png" && \
    curl -sL "https://raw.githubusercontent.com/awolffrommars/multisys-myop/main/templates/Work%20Anniversary_Template.png" \
         -o "templates/Work Anniversary_Template.png"

EXPOSE 7860
CMD ["node", "server.js"]
