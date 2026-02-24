FROM oven/bun:latest

WORKDIR /app

COPY package.json ./

RUN bun install

COPY . .

RUN bun run build

EXPOSE 3004

CMD ["bun", "dist/index.js"]
