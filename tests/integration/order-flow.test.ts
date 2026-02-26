/**
 * EzIftar Integration Tests
 *
 * These tests run against the live Docker Compose stack.
 * Prerequisites: `docker compose up -d` must be running.
 *
 * Run: cd tests/integration && bun install && bun test
 */
import { describe, test, expect, beforeAll } from "bun:test";

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:8080";
const STOCK_URL = process.env.STOCK_SERVICE_URL || "http://localhost:3002";

const uniqueId = () => Math.random().toString(36).substr(2, 9);

describe("Integration: Full Order Flow", () => {
  let jwt: string;
  let studentId: string;
  let menuItems: any[];

  // ============================================
  // Setup: Register & Login
  // ============================================
  beforeAll(async () => {
    studentId = `INT-${uniqueId()}`;

    // Seed stock (idempotent)
    await fetch(`${STOCK_URL}/seed`, { method: "POST" });

    // Reset stock to full levels
    await fetch(`${STOCK_URL}/reset`, { method: "POST" });
  });

  test("[1] Health check — all services should be UP", async () => {
    const res = await fetch(`${GATEWAY_URL}/health`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe("UP");
    expect(data.dependencies["identity-provider"]).toBe("UP");
    expect(data.dependencies["stock-service"]).toBe("UP");
    expect(data.dependencies["kitchen-service"]).toBe("UP");
    expect(data.dependencies["notification-hub"]).toBe("UP");
    expect(data.dependencies.redis).toBe("UP");
    expect(data.dependencies.rabbitmq).toBe("UP");
  });

  test("[2] Register — should create student and return JWT", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId,
        name: "Integration Tester",
        password: "test-password-123",
      }),
    });

    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.token).toBeDefined();
    expect(typeof data.token).toBe("string");

    jwt = data.token;
  });

  test("[3] Login — should return JWT for registered student", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId,
        password: "test-password-123",
      }),
    });

    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.token).toBeDefined();

    // Use fresh token
    jwt = data.token;
  });

  test("[4] Fetch Stock — should return 6 menu items", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/stock/items`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(6);

    // All items should have stock > 0 (freshly reset)
    for (const item of data) {
      expect(item.id).toBeDefined();
      expect(item.name).toBeDefined();
      expect(item.stock).toBeGreaterThan(0);
      expect(item.price).toBeGreaterThan(0);
    }

    menuItems = data;
  });

  test("[5] Place Order — should accept and return STOCK_VERIFIED", async () => {
    const item = menuItems[0];

    const res = await fetch(`${GATEWAY_URL}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ itemId: item.id, quantity: 1 }),
    });

    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe("STOCK_VERIFIED");
    expect(data.orderId).toBeDefined();
    expect(data.orderId).toMatch(/^order-/);
    expect(data.itemId).toBe(item.id);
    expect(data.quantity).toBe(1);
  });

  test("[6] Stock Deducted — stock should decrease after order", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/stock/items`);
    const data = await res.json();

    const item = data.find((i: any) => i.id === menuItems[0].id);
    expect(item.stock).toBe(menuItems[0].stock - 1);
  });

  test("[7] Idempotency Key — duplicate key returns cached response", async () => {
    const item = menuItems[1];
    const idempotencyKey = `idem-${uniqueId()}`;

    // First request — should succeed
    const res1 = await fetch(`${GATEWAY_URL}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ itemId: item.id, quantity: 1 }),
    });
    const data1 = await res1.json();
    expect(res1.status).toBe(200);
    expect(data1.orderId).toBeDefined();

    // Second request with SAME key — should return cached response
    const res2 = await fetch(`${GATEWAY_URL}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ itemId: item.id, quantity: 1 }),
    });
    const data2 = await res2.json();
    expect(res2.status).toBe(200);

    // Should be the SAME order (idempotent)
    expect(data2.orderId).toBe(data1.orderId);
  });

  test("[8] Idempotency Key — different keys create separate orders", async () => {
    const item = menuItems[2];

    const res1 = await fetch(`${GATEWAY_URL}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        "Idempotency-Key": `idem-a-${uniqueId()}`,
      },
      body: JSON.stringify({ itemId: item.id, quantity: 1 }),
    });
    const data1 = await res1.json();

    const res2 = await fetch(`${GATEWAY_URL}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        "Idempotency-Key": `idem-b-${uniqueId()}`,
      },
      body: JSON.stringify({ itemId: item.id, quantity: 1 }),
    });
    const data2 = await res2.json();

    // Different keys → different orders
    expect(data1.orderId).not.toBe(data2.orderId);
  });

  test("[9] Unauthorized — should reject order without JWT", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: menuItems[0].id, quantity: 1 }),
    });

    expect(res.status).toBe(401);
  });

  test("[10] Missing Fields — should reject order without itemId", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ quantity: 1 }),
    });

    expect(res.status).toBe(400);
  });

  test("[11] Rate Limiting — should block after 3 failed logins", async () => {
    const rlStudentId = `RL-${uniqueId()}`;

    // Register first
    await fetch(`${GATEWAY_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: rlStudentId,
        name: "Rate Limit Tester",
        password: "correct-password",
      }),
    });

    // Fire 3 failed logins (wrong password)
    for (let i = 0; i < 3; i++) {
      await fetch(`${GATEWAY_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: rlStudentId,
          password: "wrong-password",
        }),
      });
    }

    // 4th attempt should be rate-limited (429)
    const res = await fetch(`${GATEWAY_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: rlStudentId,
        password: "wrong-password",
      }),
    });

    expect(res.status).toBe(429);
  });

  test("[12] Concurrent Orders — optimistic locking handles contention", async () => {
    const item = menuItems[3]; // Fried Rice & Chicken (stock: 50)

    // Fire 10 concurrent orders
    const promises = Array.from({ length: 10 }, () =>
      fetch(`${GATEWAY_URL}/api/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ itemId: item.id, quantity: 1 }),
      }),
    );

    const results = await Promise.all(promises);
    const statuses = results.map((r) => r.status);

    // All should succeed (stock is sufficient, retries handle contention)
    const successes = statuses.filter((s) => s === 200).length;
    expect(successes).toBe(10);
  });

  test("[13] Metrics — gateway should expose Prometheus metrics", async () => {
    const res = await fetch(`${GATEWAY_URL}/metrics`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("http_request_duration_seconds");
    expect(text).toContain("orders_total");
    expect(text).toContain("orders_failed_total");
    expect(text).toContain("cache_hits_total");
    expect(text).toContain("cache_misses_total");
    expect(text).toContain("circuit_breaker_state");
  });

  test("[14] Gateway Stats — should return rolling window latency", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/stats/gateway`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(typeof data.averageLatencyMs).toBe("number");
    expect(data.averageLatencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof data.requestCount).toBe("number");
    expect(data.requestCount).toBeGreaterThan(0);
  });

  test("[15] Health — circuit breaker state should be reported", async () => {
    const res = await fetch(`${GATEWAY_URL}/health`);
    const data = await res.json();

    expect(data.dependencies["stock-circuit-breaker"]).toBeDefined();
    expect(data.dependencies["stock-circuit-breaker"]).toBe("CLOSED");
  });

  test("[16] Kitchen Processing — orders should appear in kitchen", async () => {
    // Wait briefly for kitchen to process
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(`${GATEWAY_URL}/api/orders`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);

    // At least one order should have a status
    const statuses = data.map((o: any) => o.status);
    expect(
      statuses.some(
        (s: string) =>
          s === "IN_KITCHEN" || s === "READY" || s === "STOCK_VERIFIED",
      ),
    ).toBe(true);
  });
});
