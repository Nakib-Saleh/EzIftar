import express, { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import client from "prom-client";

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "eziftar-super-secret-key-2026";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";

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

const loginAttemptsTotal = new client.Counter({
  name: "login_attempts_total",
  help: "Total login attempts",
  labelNames: ["status"],
});
register.registerMetric(loginAttemptsTotal);

app.use((req: Request, res: Response, next: NextFunction) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on("finish", () => {
    end({ method: req.method, route: req.path, code: res.statusCode });
  });
  next();
});

// ============================================
// Rate Limiting: 3 login attempts per minute per studentId
// ============================================
const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3,
  keyGenerator: (req: Request) => req.body?.studentId || req.ip || "unknown",
  message: {
    error: "Too many login attempts. Please try again after 1 minute.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// Health Check
// ============================================
app.get("/health", async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res
      .status(200)
      .json({ status: "UP", db: "CONNECTED", service: "identity-provider" });
  } catch (error) {
    res
      .status(503)
      .json({
        status: "DOWN",
        db: "DISCONNECTED",
        service: "identity-provider",
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
// Register
// ============================================
app.post("/auth/register", async (req: Request, res: Response) => {
  const { studentId, name, password } = req.body;

  if (!studentId || !name || !password) {
    res.status(400).json({ error: "Missing studentId, name, or password" });
    return;
  }

  try {
    const existing = await prisma.student.findUnique({ where: { studentId } });
    if (existing) {
      res.status(409).json({ error: "Student ID already registered" });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const student = await prisma.student.create({
      data: { studentId, name, password: hashedPassword },
    });

    const token = jwt.sign(
      { id: student.id, studentId: student.studentId, name: student.name },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    );

    res.status(201).json({
      message: "Registration successful",
      token,
      student: {
        id: student.id,
        studentId: student.studentId,
        name: student.name,
      },
    });
  } catch (error: any) {
    console.error("Registration error:", error.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ============================================
// Login (with rate limiting)
// ============================================
app.post(
  "/auth/login",
  loginRateLimiter,
  async (req: Request, res: Response) => {
    const { studentId, password } = req.body;

    if (!studentId || !password) {
      res.status(400).json({ error: "Missing studentId or password" });
      return;
    }

    try {
      const student = await prisma.student.findUnique({ where: { studentId } });

      if (!student) {
        loginAttemptsTotal.inc({ status: "failed" });
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      const isValid = await bcrypt.compare(password, student.password);

      if (!isValid) {
        loginAttemptsTotal.inc({ status: "failed" });
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      loginAttemptsTotal.inc({ status: "success" });

      const token = jwt.sign(
        { id: student.id, studentId: student.studentId, name: student.name },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN },
      );

      res.status(200).json({
        message: "Login successful",
        token,
        student: {
          id: student.id,
          studentId: student.studentId,
          name: student.name,
        },
      });
    } catch (error: any) {
      console.error("Login error:", error.message);
      res.status(500).json({ error: "Login failed" });
    }
  },
);

// ============================================
// Verify Token (used by Gateway)
// ============================================
app.post("/auth/verify", async (req: Request, res: Response) => {
  const { token } = req.body;

  if (!token) {
    res.status(400).json({ error: "Token required" });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.status(200).json({ valid: true, user: decoded });
  } catch (error) {
    res.status(401).json({ valid: false, error: "Invalid or expired token" });
  }
});

// ============================================
// Get current user profile
// ============================================
app.get("/auth/me", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    res
      .status(200)
      .json({
        user: {
          id: decoded.id,
          studentId: decoded.studentId,
          name: decoded.name,
        },
      });
  } catch (error) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

app.listen(PORT, () => {
  console.log(`Identity Provider running on port ${PORT}`);
});
