# EzIftar — Complete Testing Guide

This guide covers every implemented feature end-to-end, matching the project requirements.

---

## Prerequisites

- Docker Desktop running
- Ports free: 3000, 3002, 3003, 3004, 5173, 8080, 5433, 5434, 5435, 6379, 5672, 15672, 9090, 3005

---

## Step 1 — Start the Full Stack

```powershell
# Navigate to the project root (wherever you cloned it)
cd EzIftar

docker compose up --build -d
```

Wait ~30 seconds, then confirm all services are healthy:

```powershell
docker compose ps
```

**Expected:** Every service shows `running` or `healthy`. App services (identity-provider, order-gateway, stock-service, kitchen-service, notification-hub, frontend) should start only **after** their databases/brokers are healthy — this is enforced by `depends_on: condition: service_healthy`.

---

## Step 2 — Run Unit Tests (83 tests)

Run each service's test suite inside Docker to match the exact Bun runtime used in production.

```powershell
# Identity Provider — 11 tests
# Covers: JWT sign/verify/expiry, bcrypt, input validation, rate limit logic
docker compose exec identity-provider bun test

# Stock Service — 16 tests
# Covers: optimistic locking, concurrent modification, exponential backoff,
#         idempotency, stock validation, Redis cache key format
docker compose exec stock-service bun test

# Kitchen Service — 14 tests
# Covers: order lifecycle (IN_KITCHEN→READY/FAILED), cooking time bounds (3-7s),
#         queue message parsing, notification payloads
docker compose exec kitchen-service bun test

# Notification Hub — 9 tests
# Covers: payload validation, room routing, event emission, status tracking
docker compose exec notification-hub bun test

# Order Gateway — 33 tests
# Covers: JWT middleware, order validation, unique ID generation, Redis cache logic,
#         rolling window stats, circuit breaker state transitions,
#         idempotency key handling, cache hit/miss tracking
docker compose exec order-gateway bun test
```

**Expected:** All 83 tests pass with no failures.

---

## Step 3 — Run Integration Tests (16 tests)

These tests run against the **live running stack** and verify the full HTTP flow across all services.

Bun is not installed on the Windows host — it only exists inside the Docker containers. Run the integration tests inside a temporary Bun container attached to the compose network:

```powershell
# From the project root
docker run --rm `
  -v "${PWD}/tests/integration:/tests" `
  -e GATEWAY_URL=http://order-gateway:8080 `
  -e STOCK_SERVICE_URL=http://stock-service:3002 `
  --network eziftar_default `
  oven/bun sh -c "cd /tests && bun install && bun test --timeout 30000"
```

> **Note:** The network name `eziftar_default` is created automatically by Docker Compose using the folder name. If you get a network error, find the exact name with:
>
> ```powershell
> docker network ls | Select-String "eziftar"
> ```
>
> Then replace `eziftar_default` in the command above with the correct name.

**Alternative — install Bun on Windows and run natively:**

```powershell
# Install Bun (one-time)
winget install Oven-sh.Bun
# Restart your terminal, then:
cd tests/integration
bun install
bun test --timeout 30000
```

| #   | Test                        | What it verifies                                               |
| --- | --------------------------- | -------------------------------------------------------------- |
| 1   | Health check                | All services UP, all dependencies healthy                      |
| 2   | Register                    | Creates student, returns JWT                                   |
| 3   | Login                       | Authenticates, returns JWT                                     |
| 4   | Fetch Stock                 | 6 menu items with positive stock                               |
| 5   | Place Order                 | Full flow: JWT → cache → stock deduction → kitchen queue → 200 |
| 6   | Stock Deducted              | Stock decreased by ordered quantity after order                |
| 7   | Idempotency Key (same)      | Duplicate key returns cached response with same orderId        |
| 8   | Idempotency Key (different) | Different keys create separate orders                          |
| 9   | Unauthorized                | Rejects order without JWT (401)                                |
| 10  | Missing Fields              | Rejects order without itemId (400)                             |
| 11  | Rate Limiting               | Blocks after 3 failed logins (429)                             |
| 12  | Concurrent Orders           | 10 simultaneous orders succeed with optimistic locking         |
| 13  | Metrics                     | Gateway exposes all Prometheus metrics                         |
| 14  | Gateway Stats               | Rolling window latency endpoint works                          |
| 15  | Health + Circuit Breaker    | Circuit breaker state reported in health check                 |
| 16  | Kitchen Processing          | Orders appear in kitchen service after placing                 |

**Expected:** All 16 tests pass.

---

## Step 4 — Run the Load Test Script

```bash
cd /d/EzIftar
chmod +x scripts/load-test.sh
bash scripts/load-test.sh
```

| Step                  | What it tests                              | Expected result                                       |
| --------------------- | ------------------------------------------ | ----------------------------------------------------- |
| [1] Health check      | identity-provider + gateway `/health`      | Both return `UP`                                      |
| [2] Register          | Creates a unique test student              | Returns JWT                                           |
| [3] Seed + Reset      | `/seed` then `/reset`                      | Stock reset to full (Chicken Biryani=100, etc.)       |
| [4] Rate limit        | 5 login attempts with wrong password       | 401×3, then 429×2                                     |
| [5] Stock load        | 100 sequential `GET /api/stock/items`      | 100% success, avg latency <100ms                      |
| [6] Concurrent orders | 50 orders in batches of 10                 | All 50 succeed, optimistic locking handles contention |
| [7] Chaos             | Stop stock-service → place order → restart | 503 during outage, orders resume after restart        |
| [8] Metrics           | Print gateway rolling-window stats         | Shows `averageLatencyMs` and request count            |

---

## Step 5 — Manual Frontend Testing

Open **http://localhost:5173** in your browser.

---

### 5a — Registration Auto-Login

1. Click **Register**
2. Fill in Student ID (e.g. `STU001`), Name, Password
3. Click **Register**

**Expected:** You land directly on the **Dashboard** — no redirect to login. Your name appears in the header. No need to log in again.

---

### 5b — Login Rate Limiting

1. Log out (or use a private/incognito window)
2. Try logging in with a **wrong password 3 times** using the same Student ID
3. Attempt a **4th login**

**Expected:** The first 3 attempts return `401 Invalid credentials`. The 4th returns `429 Too Many Requests`. Wait 60 seconds and login works again.

---

### 5c — Quantity Selector + Full Order Lifecycle

1. On the Dashboard, select a menu item from the dropdown (e.g. `Chicken Biryani — 100 left — ৳80`)
2. Use the **−** / **+** buttons to set quantity to `3` (or type it in the input)
3. Click **Place Order**

**Expected — live order tracker shows this sequence (within ~10 seconds):**

```
PENDING → STOCK_VERIFIED → IN_KITCHEN → READY
```

- Each order card shows: **item name** (e.g. `Chicken Biryani`), **quantity badge** (e.g. `×3` in purple), order ID, status badge, and timestamp
- The stock count in the dropdown decreases by 3 immediately after ordering (WebSocket `stockUpdate` push)
- Latency badge shows green (<1000ms) or red (>1000ms)

---

### 5d — Order History Page

1. Click the **Orders** nav button
2. Check the order list

**Expected:**

- Each order shows: item name, quantity (e.g. `×3`), status badge (🟢 READY / 🟡 IN_KITCHEN / 🔴 FAILED), timestamp
- Summary bar at the bottom shows correct counts: **Total / Ready / In Kitchen / Failed**
- Place another order → the Orders view refreshes automatically when the new order status updates
- **Failed orders** (e.g. from a killed service or circuit breaker) also appear here with a 🔴 FAILED badge

---

### 5e — WebSocket-Driven Updates (Verify No Excessive Polling)

1. Open **Browser DevTools → Network tab → filter by `WS`**
2. Confirm there is **one persistent Socket.IO connection** to `localhost:3004`
3. Watch the XHR requests — health status should **not** be polled every 5s

**Expected:**

- Health panel updates automatically every ~10s without any XHR to `/api/health/:service` on a tight timer
- Stock dropdown updates instantly after placing an order (pushed via `stockUpdate` WebSocket event)
- Order history refreshes on `orderUpdate` events, not on a polling timer
- A 30-second fallback poll still fires if WebSocket events are missed — this is acceptable
- If the notification hub goes down and comes back, WebSocket **auto-reconnects** within ~3 seconds — system activity log shows `Reconnected — real-time updates active`

---

### 5f — Metrics Page

1. Click **Metrics** in the nav
2. Click on each service name to expand its metrics

**Expected per service:**

| Service           | Business metrics shown                                                             |
| ----------------- | ---------------------------------------------------------------------------------- |
| order-gateway     | Orders Accepted, Orders Failed, Avg Latency, Total Requests, Circuit Breaker State |
| identity-provider | Login Success, Login Failed, Avg Latency                                           |
| stock-service     | Deductions OK, Deductions Failed, Avg Latency                                      |
| kitchen-service   | Orders Completed, Orders Failed, Avg Latency                                       |
| notification-hub  | Notifications Sent, WebSocket Clients, Avg Latency                                 |

---

### 5g — Admin Panel — Chaos Toggle

1. Click **Admin** in the nav
2. Click **Kill stock-service**

**Expected:**

- Health panel turns red for `stock-service` within ~10s (pushed via `healthUpdate` WebSocket event)
- Trying to place an order returns an error (circuit breaker: `CIRCUIT_OPEN` after 5 failures)
- **Failed orders** appear in Live Order Status with a 🔴 FAILED badge and are recorded in Order History
- Chaos log entry appears in the Admin panel

3. Click **Restart stock-service** (or use `docker compose start stock-service`)

**Expected:**

- Health panel turns green within ~15s
- Orders succeed again
- Circuit breaker resets to CLOSED

4. Click **Kill notification-hub**

**Expected:**

- System activity log shows `WebSocket disconnected` and `Falling back to database polling`
- Orders still process normally (stock deduction + kitchen cooking via RabbitMQ)
- Live Order Status updates every 5s via DB polling instead of real-time WebSocket

5. Click **Restart notification-hub**

**Expected:**

- WebSocket **auto-reconnects** within ~3 seconds
- System activity log shows `Reconnected — fetching from DB` followed by `real-time updates active`
- Live Order Status switches back to real-time WebSocket updates

Repeat kill/restore for **kitchen-service** to verify orders resume after the kitchen comes back online.

---

## Step 6 — Test Circuit Breaker via curl

```powershell
# 1. Get a JWT — try register first, fall back to login if student exists
$STUDENT_ID = "CB_TEST_$(Get-Random -Maximum 9999)"
try {
  $res = Invoke-WebRequest -Uri "http://localhost:8080/api/auth/register" `
    -Method POST -ContentType "application/json" `
    -Body "{`"studentId`":`"$STUDENT_ID`",`"name`":`"CB User`",`"password`":`"test123`"}"
  $TOKEN = ($res.Content | ConvertFrom-Json).token
  Write-Host "Registered new student: $STUDENT_ID"
} catch {
  # Student already exists — login instead
  $res = Invoke-WebRequest -Uri "http://localhost:8080/api/auth/login" `
    -Method POST -ContentType "application/json" `
    -Body "{`"studentId`":`"$STUDENT_ID`",`"password`":`"test123`"}"
  $TOKEN = ($res.Content | ConvertFrom-Json).token
  Write-Host "Logged in as: $STUDENT_ID"
}
Write-Host "JWT acquired: $($TOKEN.Substring(0,20))..."

# Get a real itemId from stock
$ITEMS = (Invoke-WebRequest -Uri "http://localhost:8080/api/stock/items").Content | ConvertFrom-Json
$ITEM_ID = $ITEMS[0].id
Write-Host "Using itemId: $ITEM_ID"

# 2. Kill stock-service
docker compose stop stock-service

# 3. Fire 6 orders to trip the circuit breaker (threshold = 5 failures)
1..6 | ForEach-Object {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:8080/api/orders" `
      -Method POST -ContentType "application/json" `
      -Headers @{Authorization="Bearer $TOKEN"} `
      -Body "{`"itemId`":`"$ITEM_ID`",`"quantity`":1}"
    Write-Host "Attempt $($_): $($r.StatusCode) - $($r.Content)"
  } catch {
    $errBody = $_.ErrorDetails.Message
    $statusCode = $_.Exception.Response.StatusCode.value__
    Write-Host "Attempt $($_): $statusCode - $errBody"
  }
}

# 4. Check Prometheus metric — should be OPEN (2)
(Invoke-WebRequest http://localhost:8080/metrics).Content -split "`n" |
  Where-Object { $_ -match "circuit_breaker_state" }
# Expected: circuit_breaker_state{target="stock-service"} 2   (2 = OPEN)

# 6. Restart and verify recovery
docker compose start stock-service
Start-Sleep 15
(Invoke-WebRequest http://localhost:8080/metrics).Content -split "`n" |
  Where-Object { $_ -match "circuit_breaker_state" }
# Expected: circuit_breaker_state{target="stock-service"} 0   (0 = CLOSED)
```

---

## Step 7 — Test Idempotency Key

```powershell
# Get a JWT (use the same approach as Step 6, or reuse $TOKEN if still set)
$STUDENT_ID = "IDEM_TEST_$(Get-Random -Maximum 9999)"
try {
  $res = Invoke-WebRequest -Uri "http://localhost:8080/api/auth/register" `
    -Method POST -ContentType "application/json" `
    -Body "{`"studentId`":`"$STUDENT_ID`",`"name`":`"Idem User`",`"password`":`"test123`"}"
  $TOKEN = ($res.Content | ConvertFrom-Json).token
} catch {
  $res = Invoke-WebRequest -Uri "http://localhost:8080/api/auth/login" `
    -Method POST -ContentType "application/json" `
    -Body "{`"studentId`":`"$STUDENT_ID`",`"password`":`"test123`"}"
  $TOKEN = ($res.Content | ConvertFrom-Json).token
}

# Get a real itemId
$ITEMS = (Invoke-WebRequest -Uri "http://localhost:8080/api/stock/items").Content | ConvertFrom-Json
$ITEM_ID = $ITEMS[0].id

# First request with idempotency key
$KEY = "idem-key-$(Get-Random)"
$BODY = "{`"itemId`":`"$ITEM_ID`",`"quantity`":1}"

$R1 = (Invoke-WebRequest -Uri "http://localhost:8080/api/orders" `
  -Method POST -ContentType "application/json" `
  -Headers @{Authorization="Bearer $TOKEN"; "Idempotency-Key"=$KEY} `
  -Body $BODY).Content | ConvertFrom-Json

Write-Host "First orderId: $($R1.orderId)"

# Repeat with SAME key — should return cached response
$R2 = (Invoke-WebRequest -Uri "http://localhost:8080/api/orders" `
  -Method POST -ContentType "application/json" `
  -Headers @{Authorization="Bearer $TOKEN"; "Idempotency-Key"=$KEY} `
  -Body $BODY).Content | ConvertFrom-Json

Write-Host "Second orderId: $($R2.orderId)"
Write-Host "Same order? $($R1.orderId -eq $R2.orderId)"

# Expected: both orderIds are identical — stock only deducted once
```

---

## Step 8 — Verify Redis Cache Hit/Miss Metrics

```powershell
# Before any orders — check counters (should be 0 or very low)
(Invoke-WebRequest http://localhost:8080/metrics).Content -split "`n" |
  Where-Object { $_ -match "^cache_hits_total|^cache_misses_total" }

# Place a few orders...

# After orders — cache_hits_total should be rising as Redis serves stock checks
(Invoke-WebRequest http://localhost:8080/metrics).Content -split "`n" |
  Where-Object { $_ -match "^cache_hits_total|^cache_misses_total" }
```

**Expected:** `cache_hits_total` increments on stock checks hitting the Redis cache. `cache_misses_total` increments only on cold-start or after cache is explicitly cleared.

---

## Step 9 — Verify Docker Compose Healthchecks & Startup Order

```powershell
# Check all infra containers are healthy
docker compose ps --format "table {{.Name}}\t{{.Status}}"
```

**Expected:** `identity-db`, `stock-db`, `kitchen-db`, `redis`, `rabbitmq` all show `(healthy)`.

To verify startup ordering works correctly from a cold start:

```powershell
docker compose down -v
docker compose up --build
# Watch logs — app services should NOT start before their databases are healthy
docker compose logs --follow identity-provider
# Expected: no "Can't reach database" Prisma errors; migrations succeed on first boot
```

---

## Step 10 — Verify Observability

### Prometheus — http://localhost:9090

Run these queries in the Prometheus UI to verify all metrics are present:

| Query                                           | Expected result                                    |
| ----------------------------------------------- | -------------------------------------------------- |
| `orders_total`                                  | Labeled by `status="accepted"` / `status="failed"` |
| `cache_hits_total`                              | Rising counter after orders                        |
| `cache_misses_total`                            | Non-zero counter                                   |
| `circuit_breaker_state{target="stock-service"}` | `0` (CLOSED) when healthy                          |
| `websocket_connected_clients`                   | Number of open browser connections                 |
| `http_request_duration_seconds_count`           | Non-zero on all 5 services                         |
| `kitchen_orders_processed_total`                | Labeled by `status`                                |
| `notifications_sent_total`                      | Non-zero after orders                              |

### Grafana — http://localhost:3005

- Login: `admin` / (password from your `.env`)
- Open **Dashboards → EzIftar**

**Expected — all 8 panels show data:**

| Panel             | What to verify                   |
| ----------------- | -------------------------------- |
| Service Health    | All 5 services show UP           |
| Request Rate      | Non-zero req/s during load       |
| Latency P95       | Below 2s under normal conditions |
| Login Attempts    | Shows success vs failure counts  |
| Orders Total      | Accepted and failed counts       |
| Kitchen Orders    | Processed orders by status       |
| WebSocket Clients | Shows connected browser count    |
| Stock Deductions  | Non-zero during ordering         |

---

## Step 11 — Verify K8s Manifests (Static Check)

If you have a Kubernetes cluster (e.g. Docker Desktop Kubernetes or minikube):

```powershell
# Validate all manifests have no syntax errors
kubectl apply --dry-run=client -f k8s/

# Verify resource limits are set on all deployments
kubectl get deployments -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].resources}{"\n"}{end}' 2>/dev/null
```

Or inspect the YAML files directly to confirm `resources.requests` and `resources.limits` are present on all 6 deployments:

```powershell
Select-String -Path "k8s\*.yaml" -Pattern "resources:" | Select-Object Filename, LineNumber
# Expected: 6 matches (one per app deployment)
```

---

## Step 12 — Verify Secrets Are Not Hardcoded

```powershell
# Confirm no plaintext secrets in docker-compose.yml
Select-String -Path "docker-compose.yml" -Pattern "password|secret|JWT" |
  Where-Object { $_.Line -notmatch "\$\{" }
# Expected: 0 matches (all sensitive values use ${VAR} interpolation)

# Confirm .env is not committed to git
git ls-files .env
# Expected: no output (file is gitignored)

# Confirm .env is not in the repo
Test-Path .env
# Expected: only exists locally, never committed
```

---

## Summary Checklist

| #   | Feature                                     | Test Location                               |
| --- | ------------------------------------------- | ------------------------------------------- |
| 1   | Services start healthy                      | Step 1 — `docker compose ps`                |
| 2   | 83 unit tests pass                          | Step 2 — `docker compose exec ... bun test` |
| 3   | 16 integration tests pass                   | Step 3 — `bun test` in `tests/integration/` |
| 4   | Load test 8-step suite passes               | Step 4 — `bash scripts/load-test.sh`        |
| 5   | Registration auto-login                     | Step 5a                                     |
| 6   | Rate limiting (429 after 3 attempts)        | Step 5b                                     |
| 7   | Quantity selector + PENDING→READY lifecycle | Step 5c                                     |
| 8   | Order history page                          | Step 5d                                     |
| 9   | WebSocket-driven updates (no tight polling) | Step 5e                                     |
| 10  | Business + process metrics in UI            | Step 5f                                     |
| 11  | Chaos toggle kills and recovers services    | Step 5g                                     |
| 12  | Failed order tracking in history            | Step 5d, 5g                                 |
| 13  | WebSocket auto-reconnect after service kill | Step 5e, 5g                                 |
| 14  | Circuit breaker opens/closes                | Step 6                                      |
| 15  | Idempotency key prevents duplicate orders   | Step 7                                      |
| 16  | Redis cache hit/miss metrics                | Step 8                                      |
| 17  | Docker healthchecks + startup ordering      | Step 9                                      |
| 18  | Prometheus queries + Grafana dashboard      | Step 10                                     |
| 19  | K8s resource limits on all deployments      | Step 11                                     |
| 20  | No hardcoded secrets                        | Step 12                                     |
