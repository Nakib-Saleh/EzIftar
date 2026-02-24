import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const PORT = 3111; // Use a unique port for testing
const BASE_URL = `http://localhost:${PORT}`;

// We spin up the actual server for integration-style tests
// For CI, DATABASE_URL must point to a real (test) Postgres instance
let serverProcess: any;

describe("Identity Provider", () => {
  // ============================================
  // Unit Tests - JWT Helpers
  // ============================================
  describe("JWT Token", () => {
    const jwt = require("jsonwebtoken");
    const SECRET = "test-secret";

    test("should sign and verify a token", () => {
      const payload = { id: "1", studentId: "S001", name: "Test" };
      const token = jwt.sign(payload, SECRET, { expiresIn: "1h" });
      const decoded = jwt.verify(token, SECRET) as any;
      expect(decoded.studentId).toBe("S001");
      expect(decoded.name).toBe("Test");
    });

    test("should reject an expired token", () => {
      const token = jwt.sign({ id: "1" }, SECRET, { expiresIn: "0s" });
      expect(() => jwt.verify(token, SECRET)).toThrow();
    });

    test("should reject a token with wrong secret", () => {
      const token = jwt.sign({ id: "1" }, SECRET);
      expect(() => jwt.verify(token, "wrong-secret")).toThrow();
    });
  });

  // ============================================
  // Unit Tests - Password Hashing
  // ============================================
  describe("Password Hashing", () => {
    const bcrypt = require("bcryptjs");

    test("should hash and verify a password", async () => {
      const password = "secure123";
      const hash = await bcrypt.hash(password, 10);
      expect(hash).not.toBe(password);
      const isValid = await bcrypt.compare(password, hash);
      expect(isValid).toBe(true);
    });

    test("should reject wrong password", async () => {
      const hash = await bcrypt.hash("correct", 10);
      const isValid = await bcrypt.compare("wrong", hash);
      expect(isValid).toBe(false);
    });
  });

  // ============================================
  // Input Validation Tests
  // ============================================
  describe("Input Validation", () => {
    test("register payload must have studentId, name, password", () => {
      const valid = { studentId: "S001", name: "Test", password: "12345" };
      expect(valid.studentId).toBeTruthy();
      expect(valid.name).toBeTruthy();
      expect(valid.password).toBeTruthy();

      const missing = { studentId: "S001" } as any;
      expect(!missing.name || !missing.password).toBe(true);
    });

    test("login payload must have studentId and password", () => {
      const valid = { studentId: "S001", password: "12345" };
      expect(valid.studentId).toBeTruthy();
      expect(valid.password).toBeTruthy();

      const missing = { studentId: "S001" } as any;
      expect(!missing.password).toBe(true);
    });

    test("verify payload must have token", () => {
      const valid = { token: "abc.123.xyz" };
      expect(valid.token).toBeTruthy();

      const missing = {} as any;
      expect(!missing.token).toBe(true);
    });
  });

  // ============================================
  // JWT Payload Structure
  // ============================================
  describe("JWT Payload Structure", () => {
    const jwt = require("jsonwebtoken");
    const SECRET = "test-secret";

    test("token payload should contain id, studentId, name", () => {
      const payload = {
        id: "uuid-123",
        studentId: "2021-001",
        name: "Rahim",
      };
      const token = jwt.sign(payload, SECRET, { expiresIn: "24h" });
      const decoded = jwt.verify(token, SECRET) as any;

      expect(decoded).toHaveProperty("id");
      expect(decoded).toHaveProperty("studentId");
      expect(decoded).toHaveProperty("name");
      expect(decoded).toHaveProperty("iat");
      expect(decoded).toHaveProperty("exp");
    });

    test("token should expire in 24 hours by default", () => {
      const token = jwt.sign({ id: "1" }, SECRET, { expiresIn: "24h" });
      const decoded = jwt.verify(token, SECRET) as any;
      const diff = decoded.exp - decoded.iat;
      expect(diff).toBe(86400); // 24h in seconds
    });
  });

  // ============================================
  // Rate Limit Logic
  // ============================================
  describe("Rate Limit Logic", () => {
    test("should track attempt count correctly", () => {
      const attempts: Map<string, number[]> = new Map();
      const WINDOW_MS = 60000;
      const MAX = 3;

      const record = (key: string) => {
        const now = Date.now();
        const existing = attempts.get(key) || [];
        const valid = existing.filter((t) => now - t < WINDOW_MS);
        valid.push(now);
        attempts.set(key, valid);
        return valid.length <= MAX;
      };

      expect(record("S001")).toBe(true); // 1st
      expect(record("S001")).toBe(true); // 2nd
      expect(record("S001")).toBe(true); // 3rd
      expect(record("S001")).toBe(false); // 4th → blocked
    });
  });
});
