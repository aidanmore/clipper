FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY index.html app.js styles.css pcrp.ico ./
COPY legacy ./legacy
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 3000
CMD ["node", "server/index.js"]
