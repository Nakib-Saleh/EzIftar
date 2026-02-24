import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import cors from "cors";
import axios from "axios";
import client from "prom-client";

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3003;
const RABBITMQ_URL =
  process.env.RABBITMQ_URL || "amqp://user:password@rabbitmq:5672";
const NOTIFICATION_HUB_URL =
  process.env.NOTIFICATION_HUB_URL || "http://notification-hub:3004";

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

const ordersProcessedTotal = new client.Counter({
  name: "kitchen_orders_processed_total",
  help: "Total orders processed by kitchen",
  labelNames: ["status"],
});
register.registerMetric(ordersProcessedTotal);

app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on("finish", () => {
    end({ method: req.method, route: req.path, code: res.statusCode });
  });
  next();
});

// ============================================
// RabbitMQ Connection + Kitchen Queue Consumer
// ============================================
let channel: any;

async function connectToRabbit() {
  const amqp = require("amqplib");
  while (true) {
    try {
      const connection = await amqp.connect(RABBITMQ_URL);
      channel = await connection.createChannel();
      await channel.assertQueue("kitchen_queue");
      await channel.assertQueue("order_status_queue");

      console.log("Connected to RabbitMQ & listening on kitchen_queue");

      // Consume orders from kitchen_queue
      channel.consume("kitchen_queue", async (msg: any) => {
        if (msg !== null) {
          const data = JSON.parse(msg.content.toString());
          console.log("Received order in Kitchen:", data);

          try {
            // 1. Save order to kitchen DB
            const kitchenOrder = await prisma.kitchenOrder.upsert({
              where: { orderId: data.orderId },
              create: {
                orderId: data.orderId,
                itemId: data.itemId,
                quantity: data.quantity,
                studentId: data.studentId,
                studentName: data.studentName,
                status: "IN_KITCHEN",
              },
              update: {
                status: "IN_KITCHEN",
              },
            });

            // 2. Notify: Status = IN_KITCHEN
            await notifyStatusChange(
              data.orderId,
              "IN_KITCHEN",
              data.studentId,
            );

            // 3. Simulate cooking (3-7 seconds)
            const cookingTime = Math.floor(Math.random() * 4000) + 3000; // 3-7s
            console.log(
              `Cooking order ${data.orderId} for ${cookingTime}ms...`,
            );

            await new Promise((resolve) => setTimeout(resolve, cookingTime));

            // 4. Mark as READY
            await prisma.kitchenOrder.update({
              where: { orderId: data.orderId },
              data: { status: "READY" },
            });

            // 5. Notify: Status = READY
            await notifyStatusChange(data.orderId, "READY", data.studentId);

            ordersProcessedTotal.inc({ status: "completed" });
            console.log(`Order ${data.orderId} is READY!`);

            channel.ack(msg);
          } catch (e: any) {
            console.error("Kitchen processing failed:", e.message);
            ordersProcessedTotal.inc({ status: "failed" });

            // Mark as FAILED
            try {
              await prisma.kitchenOrder.update({
                where: { orderId: data.orderId },
                data: { status: "FAILED" },
              });
              await notifyStatusChange(data.orderId, "FAILED", data.studentId);
            } catch (updateErr) {
              console.error("Failed to update order status:", updateErr);
            }

            channel.ack(msg);
          }
        }
      });

      break; // Connection successful
    } catch (e) {
      console.error("RabbitMQ Connection Failed, retrying in 5s...", e);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// ============================================
// Notify Notification Hub of status change
// ============================================
async function notifyStatusChange(
  orderId: string,
  status: string,
  studentId: string,
) {
  try {
    await axios.post(
      `${NOTIFICATION_HUB_URL}/notify`,
      {
        orderId,
        status,
        studentId,
        timestamp: new Date().toISOString(),
      },
      { timeout: 2000 },
    );
  } catch (e: any) {
    console.error(`Failed to notify hub for order ${orderId}:`, e.message);
  }
}

// ============================================
// Health Check
// ============================================
app.get("/health", async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res
      .status(200)
      .json({ status: "UP", db: "CONNECTED", service: "kitchen-service" });
  } catch (error) {
    res
      .status(503)
      .json({ status: "DOWN", db: "DISCONNECTED", service: "kitchen-service" });
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
// Get orders (by studentId or all)
// ============================================
app.get("/orders", async (req: Request, res: Response) => {
  const { studentId } = req.query;

  try {
    const where = studentId ? { studentId: studentId as string } : {};
    const orders = await prisma.kitchenOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// ============================================
// Get single order status
// ============================================
app.get("/orders/:orderId", async (req: Request, res: Response) => {
  try {
    const order = await prisma.kitchenOrder.findUnique({
      where: { orderId: req.params.orderId },
    });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    res.json(order);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

// ============================================
// Admin: Shutdown (for Chaos Toggle)
// ============================================
app.post("/admin/shutdown", (req: Request, res: Response) => {
  res.json({ message: "Kitchen service shutting down..." });
  setTimeout(() => process.exit(1), 500);
});

app.listen(PORT, async () => {
  console.log(`Kitchen Service running on port ${PORT}`);
  await connectToRabbit();
});
