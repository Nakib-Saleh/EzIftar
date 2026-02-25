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
  res.json({ message: "Notification hub shutting down..." });
  // Delay exit so health checks detect DOWN before Docker restarts us
  setTimeout(() => process.exit(1), 8000);
});

httpServer.listen(PORT, () => {
  console.log(`Notification Hub running on port ${PORT} (WebSocket enabled)`);
});
