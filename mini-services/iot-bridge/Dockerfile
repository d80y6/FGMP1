FROM oven/bun:1-slim
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
CMD ["bun", "index.ts"]
