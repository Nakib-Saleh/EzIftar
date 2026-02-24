FROM oven/bun:latest

WORKDIR /app

COPY package.json ./

RUN bun install

COPY prisma ./prisma
RUN bunx prisma generate

COPY tsconfig.json ./
COPY src ./src

RUN bun run build

EXPOSE 3000

CMD ["bun", "dist/index.js"]
