FROM oven/bun:latest AS builder

WORKDIR /app

COPY package.json ./

RUN bun install

COPY . .

RUN bun run build

# Run on Node.js for proper WebSocket upgrade event support
# (Bun's createServer doesn't emit 'upgrade' events needed by Socket.IO)
FROM node:18-alpine

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3004

CMD ["node", "dist/index.js"]
