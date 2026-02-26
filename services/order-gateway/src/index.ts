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

const cacheHitsTotal = new client.Counter({
  name: "cache_hits_total",
  help: "Total Redis cache hits for stock lookups",
});
register.registerMetric(cacheHitsTotal);

const cacheMissesTotal = new client.Counter({
  name: "cache_misses_total",
  help: "Total Redis cache misses for stock lookups",
});
register.registerMetric(cacheMissesTotal);

const circuitBreakerStateGauge = new client.Gauge({
  name: "circuit_breaker_state",
  help: "Circuit breaker state: 0=CLOSED, 1=HALF_OPEN, 2=OPEN",
  labelNames: ["target"],
});
register.registerMetric(circuitBreakerStateGauge);

// ============================================
// Circuit Breaker (protects stock-service calls)
// ============================================
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";

  constructor(
    private readonly threshold: number = 5,
    private readonly resetTimeout: number = 10000,
  ) {}

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = "HALF_OPEN";
        this.updateMetric();
      } else {
        throw new Error("Circuit breaker is OPEN");
      }
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = "CLOSED";
    this.updateMetric();
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "OPEN";
      console.warn(`Circuit breaker OPENED after ${this.failures} failures`);
    }
    this.updateMetric();
  }

  private updateMetric() {
    const val =
      this.state === "CLOSED" ? 0 : this.state === "HALF_OPEN" ? 1 : 2;
    circuitBreakerStateGauge.set({ target: "stock-service" }, val);

    // Broadcast circuit breaker state change via WebSocket (fire-and-forget)
    axios
      .post(
        `${NOTIFICATION_HUB_URL}/broadcast/circuit-breaker`,
        { state: this.state, stateValue: val, target: "stock-service" },
        { timeout: 1000 },
      )
      .catch(() => {});
  }

  getState() {
    return this.state;
  }

  reset() {
    this.failures = 0;
    this.state = "CLOSED";
    this.updateMetric();
  }
}

// Open after 5 consecutive failures, retry after 10s
const stockBreaker = new CircuitBreaker(5, 10000);

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
// Health Check (Gateway + Dependencies) — Aggregated
// ============================================
app.get("/health", async (req: Request, res: Response) => {
  const checks: Record<string, string> = {};
  let allUp = true;

  // Check Redis
  try {
    if (redis) {
      await redis.ping();
      checks.redis = "UP";
    } else {
      checks.redis = "DOWN";
      allUp = false;
    }
  } catch {
    checks.redis = "DOWN";
    allUp = false;
  }

  // Check RabbitMQ channel
  checks.rabbitmq = channel ? "UP" : "DOWN";
  if (!channel) allUp = false;

  // Circuit breaker state
  checks["stock-circuit-breaker"] = stockBreaker.getState();

  // Check downstream services
  const downstreamServices: [string, string][] = [
    ["identity-provider", IDENTITY_PROVIDER_URL],
    ["stock-service", STOCK_SERVICE_URL],
    ["kitchen-service", KITCHEN_SERVICE_URL],
    ["notification-hub", NOTIFICATION_HUB_URL],
  ];

  await Promise.all(
    downstreamServices.map(async ([name, url]) => {
      try {
        await axios.get(`${url}/health`, { timeout: 2000 });
        checks[name] = "UP";
      } catch {
        checks[name] = "DOWN";
        allUp = false;
      }
    }),
  );

  const status = allUp ? 200 : 503;
  res.status(status).json({
    status: allUp ? "UP" : "DEGRADED",
    service: "order-gateway",
    dependencies: checks,
  });
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

  // Gateway-level Idempotency Key: prevents duplicate orders on client retry
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  if (idempotencyKey && redis) {
    try {
      const cached = await redis.get(`idempotency:${idempotencyKey}`);
      if (cached) {
        res.status(200).json(JSON.parse(cached));
        return;
      }
    } catch (e) {
      console.error("Idempotency check failed:", e);
    }
  }

  try {
    // Generate orderId early so we can emit PENDING status
    const orderId = `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Emit PENDING status via Notification Hub (fire-and-forget)
    axios
      .post(
        `${NOTIFICATION_HUB_URL}/notify`,
        {
          orderId,
          status: "PENDING",
          studentId: user.studentId,
          timestamp: new Date().toISOString(),
        },
        { timeout: 1000 },
      )
      .catch(() => {});

    // Step 1: Check Redis cache for stock availability (with hit/miss metrics)
    if (redis) {
      try {
        const cachedStock = await redis.get(`stock:${itemId}`);
        if (cachedStock !== null) {
          cacheHitsTotal.inc();
          if (parseInt(cachedStock) <= 0) {
            ordersFailedTotal.inc();
            res
              .status(400)
              .json({ error: "Item out of stock (cached)", itemId });
            return;
          }
        } else {
          cacheMissesTotal.inc();
        }
      } catch (e) {
        console.error("Redis cache check failed, proceeding to DB:", e);
        cacheMissesTotal.inc();
      }
    }

    // Step 2: Call Stock Service via Circuit Breaker (with timeout)
    const stockResponse = await stockBreaker.exec(() =>
      axios.post(
        `${STOCK_SERVICE_URL}/stock/deduct`,
        { itemId, quantity, orderId },
        { timeout: 2000 },
      ),
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
    // Broadcast updated stock via WebSocket (fire-and-forget)
    axios
      .get(`${STOCK_SERVICE_URL}/items`)
      .then((stockRes) => {
        axios
          .post(
            `${NOTIFICATION_HUB_URL}/broadcast/stock`,
            { items: stockRes.data },
            { timeout: 1000 },
          )
          .catch(() => {});
      })
      .catch(() => {});
    // Step 4: Respond immediately (<2s requirement)
    const responseBody = {
      message: "Order accepted! Stock verified. Sent to kitchen.",
      orderId,
      status: "STOCK_VERIFIED",
      itemId,
      quantity,
      studentId: user.studentId,
    };

    // Cache response for idempotency (TTL 5 minutes)
    if (idempotencyKey && redis) {
      redis
        .set(
          `idempotency:${idempotencyKey}`,
          JSON.stringify(responseBody),
          "EX",
          300,
        )
        .catch(() => {});
    }

    res.status(200).json(responseBody);
  } catch (error: any) {
    console.error("Order placement failed:", error.message);
    ordersFailedTotal.inc();

    if (error.message === "Circuit breaker is OPEN") {
      res.status(503).json({
        error:
          "Stock service temporarily unavailable (circuit breaker open). Retrying in a few seconds.",
        status: "CIRCUIT_OPEN",
      });
    } else if (
      error.code === "ECONNABORTED" ||
      error.message?.includes("timeout")
    ) {
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

// ============================================
// Admin: Restart a service (restore from chaos)
// ============================================
app.post(
  "/api/admin/restart/:service",
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
      await axios.post(`${targetUrl}/admin/restore`, {}, { timeout: 2000 });
      res.json({ message: `${service} restored` });
    } catch (error: any) {
      res.status(500).json({
        error: `Failed to restore ${service}: ${error.message}`,
      });
    }
  },
);

app.listen(PORT, async () => {
  console.log(`Order Gateway running on port ${PORT}`);

  await connectToRabbit();

  // Periodic health broadcast via WebSocket (every 10s)
  setInterval(async () => {
    try {
      const healthData: Record<string, string> = {};
      healthData.gateway = "UP";

      // Check downstream services
      const services: [string, string][] = [
        ["identity", IDENTITY_PROVIDER_URL],
        ["stock", STOCK_SERVICE_URL],
        ["kitchen", KITCHEN_SERVICE_URL],
        ["notification", NOTIFICATION_HUB_URL],
      ];

      await Promise.all(
        services.map(async ([name, url]) => {
          try {
            await axios.get(`${url}/health`, { timeout: 2000 });
            healthData[name] = "UP";
          } catch {
            healthData[name] = "DOWN";
          }
        }),
      );

      // Broadcast health to all frontend clients via notification hub
      axios
        .post(`${NOTIFICATION_HUB_URL}/broadcast/health`, healthData, {
          timeout: 1000,
        })
        .catch(() => {});
    } catch {
      // Silent failure — health broadcast is best-effort
    }
  }, 10000);

  // Periodic stats broadcast via WebSocket (every 10s)
  setInterval(() => {
    const now = Date.now();
    const validDurations = requestDurations.filter(
      (r) => now - r.time <= WINDOW_SIZE_MS,
    );
    const count = validDurations.length;
    const totalDuration = validDurations.reduce(
      (sum, r) => sum + r.duration,
      0,
    );
    const averageSec = count > 0 ? totalDuration / count : 0;
    const averageMs = Math.max(0, averageSec * 1000);

    const statsData = {
      averageLatencyMs: parseFloat(averageMs.toFixed(3)),
      requestCount: count,
      circuitBreaker: stockBreaker.getState(),
    };

    axios
      .post(`${NOTIFICATION_HUB_URL}/broadcast/stats`, statsData, {
        timeout: 1000,
      })
      .catch(() => {});
  }, 10000);
});
