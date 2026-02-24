import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import cors from "cors";
import Redis from "ioredis";
import client from "prom-client";

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3002;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

app.use(cors());
app.use(express.json());

// Redis Client for cache sync
let redis: Redis | null = null;
try {
  redis = new Redis(REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    maxRetriesPerRequest: 3,
  });
  redis.on("error", (err) => console.error("Redis error:", err.message));
  redis.on("connect", () => console.log("Connected to Redis"));
} catch (e) {
  console.error("Redis connection failed:", e);
}

// ============================================
// Prometheus Metrics
// ============================================
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDurationMicroseconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "code"],
  buckets: [0.1, 0.5, 1, 1.5, 2, 5],
});
register.registerMetric(httpRequestDurationMicroseconds);

const stockDeductionsTotal = new client.Counter({
  name: "stock_deductions_total",
  help: "Total stock deductions",
  labelNames: ["status"],
});
register.registerMetric(stockDeductionsTotal);

app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on("finish", () => {
    end({ method: req.method, route: req.path, code: res.statusCode });
  });
  next();
});

// ============================================
// Health Check
// ============================================
app.get("/health", async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res
      .status(200)
      .json({ status: "UP", db: "CONNECTED", service: "stock-service" });
  } catch (error) {
    res
      .status(503)
      .json({ status: "DOWN", db: "DISCONNECTED", service: "stock-service" });
  }
});

// ============================================
// Metrics Endpoint
// ============================================
app.get("/metrics", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", register.contentType);
  res.send(await register.metrics());
});

// ============================================
// Seed Menu Items
// ============================================
const seedItems = async () => {
  try {
    const count = await prisma.menuItem.count();
    if (count === 0) {
      console.log("Seeding menu items...");
      const items = await prisma.menuItem.createMany({
        data: [
          { name: "Chicken Biryani", stock: 100, price: 80 },
          { name: "Beef Tehari", stock: 80, price: 90 },
          { name: "Khichuri & Beef", stock: 60, price: 70 },
          { name: "Fried Rice & Chicken", stock: 50, price: 85 },
          { name: "Naan & Curry", stock: 40, price: 60 },
          { name: "Dates & Milk Pack", stock: 200, price: 30 },
        ],
      });
      console.log("Seeding complete.");

      // Sync to Redis cache
      await syncAllStockToCache();
    }
  } catch (e) {
    console.error("Seeding failed:", e);
  }
};

// Sync all stock to Redis
async function syncAllStockToCache() {
  if (!redis) return;
  try {
    const items = await prisma.menuItem.findMany();
    for (const item of items) {
      await redis.set(`stock:${item.id}`, item.stock.toString(), "EX", 300); // 5min TTL
    }
    console.log("Stock synced to Redis cache");
  } catch (e) {
    console.error("Redis sync failed:", e);
  }
}

app.post("/seed", async (req: Request, res: Response) => {
  await seedItems();
  res.json({ message: "Seeding check complete" });
});

// Reset stock to initial values (for testing)
app.post("/reset", async (req: Request, res: Response) => {
  try {
    await prisma.menuItem.updateMany({
      where: { name: "Chicken Biryani" },
      data: { stock: 100, version: 0 },
    });
    await prisma.menuItem.updateMany({
      where: { name: "Beef Tehari" },
      data: { stock: 80, version: 0 },
    });
    await prisma.menuItem.updateMany({
      where: { name: "Khichuri & Beef" },
      data: { stock: 60, version: 0 },
    });
    await prisma.menuItem.updateMany({
      where: { name: "Fried Rice & Chicken" },
      data: { stock: 50, version: 0 },
    });
    await prisma.menuItem.updateMany({
      where: { name: "Naan & Curry" },
      data: { stock: 40, version: 0 },
    });
    await prisma.menuItem.updateMany({
      where: { name: "Dates & Milk Pack" },
      data: { stock: 200, version: 0 },
    });
    await prisma.idempotencyLog.deleteMany({});
    await syncAllStockToCache();
    res.json({
      message: "Stock reset to initial levels. Idempotency log cleared.",
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// Get all menu items
// ============================================
app.get("/items", async (req: Request, res: Response) => {
  const items = await prisma.menuItem.findMany({ orderBy: { name: "asc" } });
  res.json(items);
});

// ============================================
// Deduct Stock (Optimistic Locking + Idempotency)
// ============================================
async function deductStock(itemId: string, quantity: number, orderId: string) {
  // Idempotency check
  const existingLog = await prisma.idempotencyLog.findUnique({
    where: { orderId },
  });

  if (existingLog) {
    console.log(`Idempotency check: Order ${orderId} already processed.`);
    return { message: "Stock already deducted (Idempotent)", success: true };
  }

  // Optimistic locking: read current version, then update only if version matches
  const item = await prisma.menuItem.findUnique({ where: { id: itemId } });
  if (!item) {
    throw new Error("Menu item not found");
  }
  if (item.stock < quantity) {
    throw new Error("Insufficient stock");
  }

  // Optimistic lock: only update if version hasn't changed
  const updated = await prisma.menuItem.updateMany({
    where: {
      id: itemId,
      version: item.version, // Optimistic lock condition
    },
    data: {
      stock: item.stock - quantity,
      version: item.version + 1,
    },
  });

  if (updated.count === 0) {
    throw new Error("Concurrent modification detected. Please retry.");
  }

  // Log for idempotency
  await prisma.idempotencyLog.create({
    data: { orderId },
  });

  // Update Redis cache
  if (redis) {
    try {
      await redis.set(
        `stock:${itemId}`,
        (item.stock - quantity).toString(),
        "EX",
        300,
      );
    } catch (e) {
      console.error("Redis cache update failed:", e);
    }
  }

  return {
    message: "Stock deducted",
    success: true,
    remainingStock: item.stock - quantity,
  };
}

app.post("/stock/deduct", async (req: Request, res: Response) => {
  const { itemId, quantity, orderId } = req.body;

  if (!itemId || !quantity || !orderId) {
    res.status(400).json({ error: "Missing itemId, quantity, or orderId" });
    return;
  }

  const MAX_RETRIES = 15; // needs to be >= CONCURRENT to handle all contention rounds
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const result = await deductStock(itemId, quantity, orderId);
      stockDeductionsTotal.inc({ status: "success" });
      res.status(200).json(result);
      return;
    } catch (error: any) {
      if (
        error.message === "Concurrent modification detected. Please retry." &&
        attempt < MAX_RETRIES - 1
      ) {
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, 10 * attempt)); // 10ms, 20ms, 30ms... back-off
        continue;
      }
      console.error("Stock deduction error:", error.message);
      stockDeductionsTotal.inc({ status: "failed" });
      res.status(400).json({ error: error.message });
      return;
    }
  }
});

// ============================================
// Admin: Shutdown (for Chaos Toggle)
// ============================================
app.post("/admin/shutdown", (req: Request, res: Response) => {
  res.json({ message: "Stock service shutting down..." });
  setTimeout(() => process.exit(1), 500);
});

app.listen(PORT, async () => {
  console.log(`Stock Service running on port ${PORT}`);
  await seedItems();
});
