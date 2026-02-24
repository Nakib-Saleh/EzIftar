import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";
import jwt from "jsonwebtoken";
import axios from "axios";
import Redis from "ioredis";
import client from "prom-client";

const app = express();
const PORT = process.env.PORT || 8080;

const IDENTITY_PROVIDER_URL =
  process.env.IDENTITY_PROVIDER_URL || "http://localhost:3000";
const STOCK_SERVICE_URL =
  process.env.STOCK_SERVICE_URL || "http://localhost:3002";
const KITCHEN_SERVICE_URL =
  process.env.KITCHEN_SERVICE_URL || "http://localhost:3003";
const NOTIFICATION_HUB_URL =
  process.env.NOTIFICATION_HUB_URL || "http://localhost:3004";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const JWT_SECRET = process.env.JWT_SECRET || "eziftar-super-secret-key-2026";
const RABBITMQ_URL =
  process.env.RABBITMQ_URL || "amqp://user:password@rabbitmq:5672";

// Redis Client
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

// RabbitMQ
let channel: any;
async function connectToRabbit() {
  const amqp = require("amqplib");
  while (true) {
    try {
      const connection = await amqp.connect(RABBITMQ_URL);
      channel = await connection.createChannel();
      await channel.assertQueue("kitchen_queue");
      await channel.assertQueue("order_status_queue");
      console.log("Connected to RabbitMQ (Gateway Producer)");
      break;
    } catch (e) {
      console.error("RabbitMQ Connection Failed, retrying in 5s...", e);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

app.use(cors());
app.use(express.json());

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

const ordersTotal = new client.Counter({
  name: "orders_total",
  help: "Total orders processed",
  labelNames: ["status"],
});
register.registerMetric(ordersTotal);

const ordersFailedTotal = new client.Counter({
  name: "orders_failed_total",
  help: "Total failed orders",
});
register.registerMetric(ordersFailedTotal);

app.use((req: Request, res: Response, next: NextFunction) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on("finish", () => {
    end({ method: req.method, route: req.path, code: res.statusCode });
  });
  next();
});

// ============================================
// Rolling Window Stats for Alerting
// ============================================
const WINDOW_SIZE_MS = 30000;
let requestDurations: { time: number; duration: number }[] = [];

setInterval(() => {
  const now = Date.now();
  requestDurations = requestDurations.filter(
    (r) => now - r.time <= WINDOW_SIZE_MS,
  );
}, 5000);

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000;
    requestDurations.push({ time: Date.now(), duration });
  });
  next();
});

// Stats Endpoint (for frontend latency alerts)
app.get("/api/stats/gateway", (req: Request, res: Response) => {
  const now = Date.now();
  const validDurations = requestDurations.filter(
    (r) => now - r.time <= WINDOW_SIZE_MS,
  );
  const count = validDurations.length;
  const totalDuration = validDurations.reduce((sum, r) => sum + r.duration, 0);
  const averageSec = count > 0 ? totalDuration / count : 0;
  // Convert to ms and clamp to 0 to avoid IEEE 754 floating-point drift producing negative values
  const averageMs = Math.max(0, averageSec * 1000);
  res.json({
    averageLatencyMs: parseFloat(averageMs.toFixed(3)),
    requestCount: count,
  });
});

// ============================================
// JWT Middleware (protects order routes)
// ============================================
const jwtMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res
      .status(401)
      .json({ error: "Unauthorized - No valid bearer token provided" });
    return;
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    (req as any).user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: "Unauthorized - Invalid or expired token" });
  }
};

// ============================================
// Health Check (Gateway + Dependencies)
// ============================================
app.get("/health", async (req: Request, res: Response) => {
  res.status(200).json({ status: "UP", service: "order-gateway" });
});

app.get("/api/health/gateway", (req: Request, res: Response) => {
  res.json({ status: "UP", service: "order-gateway" });
});

// Proxy health checks to downstream services
app.get("/api/health/identity", async (req: Request, res: Response) => {
  try {
    const r = await axios.get(`${IDENTITY_PROVIDER_URL}/health`, {
      timeout: 3000,
    });
    res.json(r.data);
  } catch {
    res.status(503).json({ status: "DOWN", service: "identity-provider" });
  }
});

app.get("/api/health/stock", async (req: Request, res: Response) => {
  try {
    const r = await axios.get(`${STOCK_SERVICE_URL}/health`, { timeout: 3000 });
    res.json(r.data);
  } catch {
    res.status(503).json({ status: "DOWN", service: "stock-service" });
  }
});

app.get("/api/health/kitchen", async (req: Request, res: Response) => {
  try {
    const r = await axios.get(`${KITCHEN_SERVICE_URL}/health`, {
      timeout: 3000,
    });
    res.json(r.data);
  } catch {
    res.status(503).json({ status: "DOWN", service: "kitchen-service" });
  }
});

app.get("/api/health/notification", async (req: Request, res: Response) => {
  try {
    const r = await axios.get(`${NOTIFICATION_HUB_URL}/health`, {
      timeout: 3000,
    });
    res.json(r.data);
  } catch {
    res.status(503).json({ status: "DOWN", service: "notification-hub" });
  }
});

// ============================================
// Metrics (Gateway + Proxy to services)
// ============================================
app.get("/metrics", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", register.contentType);
  res.send(await register.metrics());
});

app.get("/api/metrics/gateway", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", register.contentType);
  res.send(await register.metrics());
});

app.get("/api/metrics/identity", async (req: Request, res: Response) => {
  try {
    const r = await axios.get(`${IDENTITY_PROVIDER_URL}/metrics`, {
      timeout: 3000,
    });
    res.send(r.data);
  } catch {
    res.status(503).json({ error: "Metrics unavailable" });
  }
});

app.get("/api/metrics/stock", async (req: Request, res: Response) => {
  try {
    const r = await axios.get(`${STOCK_SERVICE_URL}/metrics`, {
      timeout: 3000,
    });
    res.send(r.data);
  } catch {
    res.status(503).json({ error: "Metrics unavailable" });
  }
});

app.get("/api/metrics/kitchen", async (req: Request, res: Response) => {
  try {
    const r = await axios.get(`${KITCHEN_SERVICE_URL}/metrics`, {
      timeout: 3000,
    });
    res.send(r.data);
  } catch {
    res.status(503).json({ error: "Metrics unavailable" });
  }
});

app.get("/api/metrics/notification", async (req: Request, res: Response) => {
  try {
    const r = await axios.get(`${NOTIFICATION_HUB_URL}/metrics`, {
      timeout: 3000,
    });
    res.send(r.data);
  } catch {
    res.status(503).json({ error: "Metrics unavailable" });
  }
});

// ============================================
// Auth Routes (proxied to Identity Provider, no JWT required)
// ============================================
app.use(
  "/api/auth",
  createProxyMiddleware({
    target: IDENTITY_PROVIDER_URL,
    changeOrigin: true,
    pathRewrite: { "^/api/auth": "/auth" },
    // v2 syntax: re-stream the body that express.json() already consumed
    onProxyReq: (proxyReq, req: any) => {
      if (req.body && Object.keys(req.body).length > 0) {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader("Content-Type", "application/json");
        proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
      }
    },
  }),
);

// ============================================
// Stock Routes (public read, protected write)
// ============================================
app.get("/api/stock/items", async (req: Request, res: Response) => {
  try {
    const r = await axios.get(`${STOCK_SERVICE_URL}/items`);
    res.json(r.data);
  } catch (error: any) {
    res.status(503).json({ error: "Stock service unavailable" });
  }
});

// ============================================
// ORDER PLACEMENT - Core Flow
// JWT validated → Redis cache check → Stock deduction → Kitchen queue
// ============================================
app.post("/api/orders", jwtMiddleware, async (req: Request, res: Response) => {
  const { itemId, quantity } = req.body;
  const user = (req as any).user;

  if (!itemId || !quantity) {
    res.status(400).json({ error: "Missing itemId or quantity" });
    return;
  }

  try {
    // Step 1: Check Redis cache for stock availability
    if (redis) {
      try {
        const cachedStock = await redis.get(`stock:${itemId}`);
        if (cachedStock !== null && parseInt(cachedStock) <= 0) {
          ordersFailedTotal.inc();
          res.status(400).json({ error: "Item out of stock (cached)", itemId });
          return;
        }
      } catch (e) {
        console.error("Redis cache check failed, proceeding to DB:", e);
      }
    }

    // Step 2: Call Stock Service to deduct inventory (with timeout)
    const orderId = `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const stockResponse = await axios.post(
      `${STOCK_SERVICE_URL}/stock/deduct`,
      {
        itemId,
        quantity,
        orderId,
      },
      { timeout: 2000 },
    );

    if (stockResponse.status !== 200) {
      throw new Error("Stock deduction failed");
    }

    // Step 3: Publish to Kitchen Queue for async processing
    if (channel) {
      const kitchenMsg = JSON.stringify({
        orderId,
        itemId,
        quantity,
        studentId: user.studentId,
        studentName: user.name,
        timestamp: new Date().toISOString(),
      });
      channel.sendToQueue("kitchen_queue", Buffer.from(kitchenMsg));
    }

    ordersTotal.inc({ status: "accepted" });

    // Step 4: Respond immediately (<2s requirement)
    res.status(200).json({
      message: "Order accepted! Stock verified. Sent to kitchen.",
      orderId,
      status: "STOCK_VERIFIED",
      itemId,
      quantity,
      studentId: user.studentId,
    });
  } catch (error: any) {
    console.error("Order placement failed:", error.message);
    ordersFailedTotal.inc();

    if (error.code === "ECONNABORTED" || error.message?.includes("timeout")) {
      res.status(503).json({
        error: "Stock service timeout. Please retry.",
        status: "TIMEOUT",
      });
    } else if (error.response?.status === 400) {
      res.status(400).json({
        error: error.response.data?.error || "Stock deduction failed",
      });
    } else {
      res
        .status(503)
        .json({ error: "Order failed due to service issue", status: "FAILED" });
    }
  }
});

// ============================================
// Get orders for current user
// ============================================
app.get("/api/orders", jwtMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const r = await axios.get(
      `${KITCHEN_SERVICE_URL}/orders?studentId=${user.studentId}`,
    );
    res.json(r.data);
  } catch (error: any) {
    res.status(503).json({ error: "Kitchen service unavailable" });
  }
});

// ============================================
// Admin: Chaos Toggle - Kill a service (for demo)
// ============================================
app.post(
  "/api/admin/chaos/:service",
  jwtMiddleware,
  async (req: Request, res: Response) => {
    const { service } = req.params;
    const validServices = [
      "stock-service",
      "kitchen-service",
      "notification-hub",
    ];

    if (!validServices.includes(service)) {
      res.status(400).json({ error: "Invalid service name" });
      return;
    }

    // Send shutdown signal to the service
    let targetUrl = "";
    switch (service) {
      case "stock-service":
        targetUrl = STOCK_SERVICE_URL;
        break;
      case "kitchen-service":
        targetUrl = KITCHEN_SERVICE_URL;
        break;
      case "notification-hub":
        targetUrl = NOTIFICATION_HUB_URL;
        break;
    }

    try {
      await axios.post(`${targetUrl}/admin/shutdown`, {}, { timeout: 2000 });
      res.json({ message: `Chaos triggered on ${service}` });
    } catch (error: any) {
      res.json({
        message: `Chaos signal sent to ${service} (may already be down)`,
      });
    }
  },
);

app.listen(PORT, async () => {
  console.log(`Order Gateway running on port ${PORT}`);
  await connectToRabbit();
});
