FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

ENV CI=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    awscli \
    ffmpeg \
    unzip \
    libxml2-utils \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN chmod +x /app/deploy/azure-watcher-worker/entrypoint.sh

ENTRYPOINT ["/app/deploy/azure-watcher-worker/entrypoint.sh"]
