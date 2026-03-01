import express, { Request, Response } from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import client from "prom-client";

const app = express();
const PORT = process.env.PORT || 3004;

app.use(cors());
app.use(express.json());

// Create HTTP server and Socket.IO
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ============================================
// Prometheus Metrics
// ============================================
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const notificationsSent = new client.Counter({
  name: "notifications_sent_total",
  help: "Total notifications pushed via WebSocket",
  labelNames: ["status"],
});
register.registerMetric(notificationsSent);

const connectedClients = new client.Gauge({
  name: "websocket_connected_clients",
  help: "Current number of connected WebSocket clients",
});
register.registerMetric(connectedClients);

const httpRequestDurationMicroseconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "code"],
  buckets: [0.1, 0.5, 1, 1.5, 2, 5],
});
register.registerMetric(httpRequestDurationMicroseconds);

app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on("finish", () => {
    end({ method: req.method, route: req.path, code: res.statusCode });
  });
  next();
});

// ============================================
// WebSocket Connection Handling
// ============================================
// Reject new connections while in chaos/shutdown mode
// Without this, Socket.IO clients auto-reconnect after disconnectSockets(),
// wsConnected becomes true, polling stops, but /notify returns 503 = silent data loss
io.use((socket, next) => {
  if (shuttingDown) {
    next(new Error("Service is shutting down"));
  } else {
    next();
  }
});

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);
  connectedClients.inc();

  // Client can join a room for their studentId to receive personal notifications
  socket.on("join", (studentId: string) => {
    socket.join(`student:${studentId}`);
    console.log(`Socket ${socket.id} joined room student:${studentId}`);
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    connectedClients.dec();
  });
});

// ============================================
// Notification Endpoint (called by Kitchen Service)
// ============================================
app.post("/notify", (req: Request, res: Response) => {
  if (shuttingDown) {
    res.status(503).json({ error: "Service is down (chaos mode)" });
    return;
  }
  const { orderId, status, studentId, timestamp } = req.body;

  if (!orderId || !status) {
    res.status(400).json({ error: "Missing orderId or status" });
    return;
  }

  const notification = {
    orderId,
    status,
    studentId,
    timestamp: timestamp || new Date().toISOString(),
  };

  // Broadcast to specific student's room
  if (studentId) {
    io.to(`student:${studentId}`).emit("orderStatus", notification);
  }

  // Also broadcast to all connected clients (for admin dashboard)
  io.emit("orderUpdate", notification);

  notificationsSent.inc({ status });
  console.log(`Notification sent: Order ${orderId} → ${status}`);

  res.status(200).json({ message: "Notification sent", notification });
});

// ============================================
// Stock Update Broadcast (called by gateway after order)
// ============================================
app.post("/broadcast/stock", (req: Request, res: Response) => {
  if (shuttingDown) {
    res.status(503).json({ error: "Service is down (chaos mode)" });
    return;
  }
  const { items } = req.body;
  if (items) {
    io.emit("stockUpdate", items);
  }
  res.status(200).json({ message: "Stock update broadcast sent" });
});

// ============================================
// Health Update Broadcast (called by gateway periodically)
// ============================================
app.post("/broadcast/health", (req: Request, res: Response) => {
  if (shuttingDown) {
    res.status(503).json({ error: "Service is down (chaos mode)" });
    return;
  }
  const healthData = req.body;
  if (healthData) {
    io.emit("healthUpdate", healthData);
  }
  res.status(200).json({ message: "Health update broadcast sent" });
});

// ============================================
// Stats Update Broadcast (called by gateway periodically)
// ============================================
app.post("/broadcast/stats", (req: Request, res: Response) => {
  if (shuttingDown) {
    res.status(503).json({ error: "Service is down (chaos mode)" });
    return;
  }
  const statsData = req.body;
  if (statsData) {
    io.emit("statsUpdate", statsData);
  }
  res.status(200).json({ message: "Stats update broadcast sent" });
});

// ============================================
// Circuit Breaker State Broadcast (called by gateway on state change)
// ============================================
app.post("/broadcast/circuit-breaker", (req: Request, res: Response) => {
  if (shuttingDown) {
    res.status(503).json({ error: "Service is down (chaos mode)" });
    return;
  }
  const cbData = req.body;
  if (cbData) {
    io.emit("circuitBreakerUpdate", cbData);
  }
  res.status(200).json({ message: "Circuit breaker update broadcast sent" });
});

// ============================================
// Health Check
// ============================================
app.get("/health", (req: Request, res: Response) => {
  const listening = httpServer.listening;
  if (listening && !shuttingDown) {
    res.status(200).json({
      status: "UP",
      service: "notification-hub",
      connectedClients: io.engine.clientsCount,
      websocket: "ACTIVE",
    });
  } else {
    res.status(503).json({
      status: "DOWN",
      service: "notification-hub",
      websocket: shuttingDown ? "SHUTTING_DOWN" : "INACTIVE",
    });
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
// Admin: Shutdown (for Chaos Toggle)
// ============================================
let shuttingDown = false;

app.post("/admin/shutdown", (req: Request, res: Response) => {
  shuttingDown = true;
  // Disconnect all WebSocket clients so frontends detect the outage
  // and switch to polling mode (instead of silently losing events)
  io.disconnectSockets(true);
  res.json({ message: "Notification hub entering degraded mode (chaos)" });
});

app.post("/admin/restore", (req: Request, res: Response) => {
  shuttingDown = false;
  res.json({ message: "Notification hub restored" });
});

httpServer.listen(PORT, () => {
  console.log(`Notification Hub running on port ${PORT} (WebSocket enabled)`);
});
