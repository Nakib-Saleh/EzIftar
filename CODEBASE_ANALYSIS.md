# EzIftar — Complete Codebase Analysis

---

## Architecture Overview

```
Browser (React SPA)
    │  port 5173
    ▼
Order Gateway (:8080)  ←──────── JWT validation + Redis cache + RabbitMQ producer
    │
    ├─► Identity Provider (:3000) ── identity-db (PostgreSQL :5433)
    ├─► Stock Service (:3002) ────── stock-db (PostgreSQL :5434) + Redis (:6379)
    ├─► Kitchen Service (:3003) ──── kitchen-db (PostgreSQL :5435) + RabbitMQ consumer
    └─► Notification Hub (:3004) ─── Socket.IO WebSocket server
                                      ▲
                            Kitchen pushes status updates
```

**Infra:** Redis :6379 | RabbitMQ :5672/:15672 | Prometheus :9090 | Grafana :3005

---

## Service-by-Service Breakdown

### 1. Identity Provider (`services/identity-provider/`)

| What's done           | Detail                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register` | Creates student, bcrypt(10) hashes password, returns JWT                                                                    |
| `POST /auth/login`    | Validates credentials, returns JWT, increments Prometheus counter                                                           |
| `POST /auth/verify`   | Token verification endpoint (used internally)                                                                               |
| `GET /health`         | Runs `SELECT 1` against DB, returns UP/DOWN                                                                                 |
| `GET /metrics`        | Prometheus endpoint — HTTP duration histogram + `login_attempts_total` counter                                              |
| Rate limiting         | `express-rate-limit`: 3 login attempts per minute per `studentId`                                                           |
| JWT                   | `jsonwebtoken` — `{ id, studentId, name }` payload, 24h expiry, shared secret                                               |
| DB Schema             | `Student` (uuid, studentId unique, name, password, timestamps) + `LoginAttempt` (for audit, indexed on studentId+timestamp) |
| Dockerfile            | `oven/bun:latest` → `bun install` → `prisma generate` → `bun build` → `bun dist/index.js`                                   |

---

### 2. Order Gateway (`services/order-gateway/`)

| What's done                      | Detail                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth` (proxy)         | Proxied to identity-provider via `http-proxy-middleware` v2. Fixed: `onProxyReq` re-serializes body after `express.json()` consumes it                                                    |
| `GET /api/stock/items`           | Passes through to stock-service                                                                                                                                                           |
| `POST /api/orders`               | Full core flow: emit PENDING via notification hub → Redis cache check → stock deduction → RabbitMQ `kitchen_queue` → respond <2s                                                          |
| `GET /api/orders`                | Fetches orders by studentId from kitchen-service                                                                                                                                          |
| `POST /api/admin/chaos/:service` | Sends `/admin/shutdown` to target service. Valid: stock-service, kitchen-service, notification-hub                                                                                        |
| `GET /api/health/:service`       | Polls health of gateway, identity, stock, kitchen, notification                                                                                                                           |
| `GET /api/metrics/:service`      | Fetches raw Prometheus data from each service — proxied to frontend                                                                                                                       |
| `GET /api/stats/gateway`         | Rolling 30s window avg latency in ms (`averageLatencyMs`) + request count                                                                                                                 |
| `GET /health` (aggregated)       | Deep health check — pings Redis, checks RabbitMQ channel, polls all 4 downstream services. Returns `200 UP` or `503 DEGRADED` with per-dependency status                                  |
| JWT Middleware                   | Verifies Bearer token locally (no round-trip to identity-provider)                                                                                                                        |
| Redis                            | Checks `stock:{itemId}` cache before calling stock-service. Short-circuits if `<= 0`. Tracks `cache_hits_total` and `cache_misses_total` metrics                                          |
| RabbitMQ                         | Produces to `kitchen_queue`                                                                                                                                                               |
| Circuit Breaker                  | Custom 3-state circuit breaker wraps stock-service calls. Opens after 5 failures, resets after 10s. State exposed via Prometheus gauge + `/health`                                        |
| Idempotency Key                  | Optional `Idempotency-Key` header on `POST /api/orders`. Cached in Redis (5min TTL) to prevent duplicate orders on client retry                                                           |
| Stock Broadcast                  | After placing an order, fetches latest stock from stock-service and broadcasts to all clients via `POST /broadcast/stock` on notification-hub (fire-and-forget)                           |
| Health Broadcast                 | Every 10s, checks all downstream services health and broadcasts result to all clients via `POST /broadcast/health` on notification-hub                                                    |
| Prometheus                       | `http_request_duration_seconds` histogram, `orders_total` counter, `orders_failed_total` counter, `cache_hits_total` counter, `cache_misses_total` counter, `circuit_breaker_state` gauge |

---

### 3. Stock Service (`services/stock-service/`)

| What's done            | Detail                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /items`           | Returns all menu items ordered by name                                                                                                                       |
| `POST /seed`           | Seeds 6 menu items if table is empty (idempotent no-op on subsequent calls)                                                                                  |
| `POST /reset`          | Resets all stock to original values, clears `IdempotencyLog`, re-syncs Redis cache. Used by load test script                                                 |
| `POST /stock/deduct`   | Full optimistic locking flow with MAX_RETRIES=15 + exponential backoff (10ms × attempt)                                                                      |
| `POST /admin/shutdown` | `process.exit(1)` after 500ms (for chaos tests)                                                                                                              |
| Optimistic Locking     | Read `version`, then `updateMany` with `WHERE version=N`. If `count=0` → concurrent modification → retry                                                     |
| Idempotency            | `IdempotencyLog` table prevents double-deduction on retry. Checked before every deduction                                                                    |
| Redis sync             | Updates `stock:{id}` with 24h TTL after each deduction (write-through). Full cache sync on seed/reset                                                        |
| DB Schema              | `MenuItem` (uuid, name, stock, version, price, timestamps) + `IdempotencyLog` (orderId PK)                                                                   |
| Menu items seeded      | Chicken Biryani (100/৳80), Beef Tehari (80/৳90), Khichuri & Beef (60/৳70), Fried Rice & Chicken (50/৳85), Naan & Curry (40/৳60), Dates & Milk Pack (200/৳30) |

---

### 4. Kitchen Service (`services/kitchen-service/`)

| What's done            | Detail                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| RabbitMQ consumer      | Listens on `kitchen_queue`, processes orders asynchronously                                                   |
| Order lifecycle        | Receives → saves to DB as `IN_KITCHEN` → notifies hub → simulates cooking 3–7s → marks `READY` → notifies hub |
| Error handling         | On exception: marks order `FAILED`, notifies hub, still ACKs message                                          |
| `GET /orders`          | Returns all orders, or filtered by `?studentId=`                                                              |
| `GET /health`          | DB health check                                                                                               |
| `GET /metrics`         | Prometheus — HTTP duration + `kitchen_orders_processed_total{status}`                                         |
| `POST /admin/shutdown` | Chaos toggle                                                                                                  |
| DB Schema              | `KitchenOrder` (uuid, orderId unique, itemId, quantity, studentId, studentName, status, timestamps)           |
| Notification           | Calls `POST /notify` on notification-hub at `IN_KITCHEN` and `READY` stages                                   |

---

### 5. Notification Hub (`services/notification-hub/`)

| What's done              | Detail                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Socket.IO server         | `socket.io` 4.7.4 on top of `http.createServer` with CORS `*`                                                                             |
| Room-based routing       | Client emits `join(studentId)` → joins room `student:{studentId}` → receives personal `orderStatus` events                                |
| Broadcast                | Every status change also emits `orderUpdate` to ALL clients (admin dashboard)                                                             |
| `POST /notify`           | Called by kitchen-service. Emits to student room + all clients                                                                            |
| `POST /broadcast/stock`  | Receives `{ items }` array, broadcasts `stockUpdate` event to all connected clients. Called by gateway after each order                   |
| `POST /broadcast/health` | Receives `{ dependencies }` object, broadcasts `healthUpdate` event to all connected clients. Called by gateway every 10s                 |
| `GET /health`            | Returns UP/DOWN based on `httpServer.listening` + `connectedClients` count + `websocket: ACTIVE/INACTIVE`                                 |
| `GET /metrics`           | Prometheus — `http_request_duration_seconds` histogram + `notifications_sent_total{status}` counter + `websocket_connected_clients` gauge |
| `POST /admin/shutdown`   | Chaos toggle — sets `shuttingDown` flag (health returns 503 immediately), then `process.exit(1)` after 3s                                 |

---

### 6. Frontend (`services/frontend/`)

| What's done        | Detail                                                                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth screen        | Toggle between Login and Register forms with proper state binding                                                                                                                                                                                                                              |
| JWT persistence    | Stored in `localStorage`, decoded on mount to restore user session                                                                                                                                                                                                                             |
| Dashboard          | Dropdown of live menu items with stock + price. One-click order placement                                                                                                                                                                                                                      |
| Live order tracker | Shows real-time status updates per order via WebSocket (`orderStatus` event)                                                                                                                                                                                                                   |
| Latency display    | Per-request `performance.now()` latency with colour coding (<1000ms=green, >1000ms=red)                                                                                                                                                                                                        |
| Avg latency alert  | Polls `/api/stats/gateway` every 2s (reads `averageLatencyMs`, converts to seconds), shows ⚠️ HIGH LATENCY badge if avg > 1s                                                                                                                                                                   |
| Health panel       | Polls `/api/health/:service` every 5s for all 5 services                                                                                                                                                                                                                                       |
| Metrics page       | **Business Metrics** section per service (orders accepted/failed, login success/failed, deductions, notifications sent, WS clients, avg latency, total requests) + **Process Metrics** (Memory/Heap/CPU/Handles/Event Loop Lag). Uses regex that sums across all Prometheus label combinations |
| Admin page         | Chaos Toggle buttons for all 3 killable services + chaos log                                                                                                                                                                                                                                   |
| Grafana link       | "Grafana ↗" nav button → `localhost:3005/dashboards`                                                                                                                                                                                                                                           |
| Prod Dockerfile    | `Dockerfile.prod` — multi-stage build: Node:18 builds with `VITE_*` build args → nginx:alpine serves `/dist` with SPA fallback                                                                                                                                                                 |
| Dev Dockerfile     | Bun-based dev server inside Docker (`vite --host`)                                                                                                                                                                                                                                             |

---

## Infrastructure & DevOps

### Docker Compose (`docker-compose.yml`)

| Container         | Image                     | Port         |
| ----------------- | ------------------------- | ------------ |
| identity-provider | `oven/bun` built          | 3000         |
| order-gateway     | `oven/bun` built          | 8080         |
| stock-service     | `oven/bun` built          | 3002         |
| kitchen-service   | `oven/bun` built          | 3003         |
| notification-hub  | `oven/bun` built          | 3004         |
| frontend          | nginx:alpine (prod build) | 5173→80      |
| identity-db       | `postgres:14-alpine`      | 5433         |
| stock-db          | `postgres:14-alpine`      | 5434         |
| kitchen-db        | `postgres:14-alpine`      | 5435         |
| redis             | `redis:7-alpine`          | 6379         |
| rabbitmq          | `rabbitmq:3-management`   | 5672 / 15672 |
| prometheus        | `prom/prometheus`         | 9090         |
| grafana           | `grafana/grafana`         | 3005         |

All app services have `restart: always`. Databases use named volumes for persistence. Prisma migrations run on container start via `bunx prisma db push`. All infrastructure services (PostgreSQL, Redis, RabbitMQ) have Docker healthchecks. App services use `depends_on` with `condition: service_healthy` to ensure databases and message brokers are ready before starting.

---

### Monitoring (`monitoring/`)

- **Prometheus** scrapes all 5 services every 15s at `/metrics`
- **Grafana** auto-provisions dashboards from `monitoring/grafana/dashboards/` (1 JSON dashboard: `eziftar.json` — 8 panels covering service health, request rate, latency P95, login attempts, orders total, kitchen orders, WebSocket clients, stock deductions, avg latency)
- Grafana datasource auto-provisioned pointing to `http://prometheus:9090`
- Admin password: set via `GF_SECURITY_ADMIN_PASSWORD` env var (from `.env`)

---

### Kubernetes (`k8s/` — 13 YAML files)

| File                     | What it defines                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `identity-provider.yaml` | Deployment + ClusterIP Service + resource limits (100m/128Mi → 500m/512Mi)                                 |
| `order-gateway.yaml`     | Deployment (with readiness/liveness probes) + ClusterIP Service + resource limits (200m/256Mi → 1000m/1Gi) |
| `stock-service.yaml`     | Deployment + ClusterIP Service + resource limits (100m/128Mi → 500m/512Mi)                                 |
| `kitchen-service.yaml`   | Deployment + ClusterIP Service + resource limits (100m/128Mi → 500m/512Mi)                                 |
| `notification-hub.yaml`  | Deployment + ClusterIP Service + resource limits (100m/128Mi → 500m/512Mi)                                 |
| `frontend.yaml`          | Deployment + ClusterIP Service + resource limits (50m/64Mi → 200m/256Mi)                                   |
| `identity-db.yaml`       | StatefulSet + PVC + Service                                                                                |
| `stock-db.yaml`          | StatefulSet + PVC + Service                                                                                |
| `kitchen-db.yaml`        | StatefulSet + PVC + Service                                                                                |
| `redis.yaml`             | Deployment + Service                                                                                       |
| `rabbitmq.yaml`          | Deployment + Service                                                                                       |
| `ingress.yaml`           | NGINX Ingress — `eziftar.local` → gateway + frontend                                                       |
| `service-monitor.yaml`   | Prometheus Operator ServiceMonitor for auto-scraping                                                       |

---

### CI/CD (`.github/workflows/ci.yml`)

- Triggers on push/PR to `main`
- Spins up all 5 infrastructure services (3 Postgres, Redis, RabbitMQ) as GitHub Actions service containers with health checks
- Installs Bun, runs `bun install`, `prisma generate`, `prisma db push`, `bun build` for each of the 5 services
- Tests all services can build successfully

---

### Load Test Script (`scripts/load-test.sh`)

8-step suite:

| Step                  | What it does                                                                           |
| --------------------- | -------------------------------------------------------------------------------------- |
| [1] Health check      | Hits `/health` on identity-provider and order-gateway                                  |
| [2] Register          | Creates a unique test student, acquires JWT                                            |
| [3] Seed + Reset      | Calls `/seed` then `/reset` — guarantees full stock at start of every run              |
| [4] Rate limit        | Fires 5 failed logins, expects 401×3 then 429×2                                        |
| [5] Stock load        | 100 sequential GET `/api/stock/items`, reports success rate + avg latency              |
| [6] Concurrent orders | 50 orders in batches of 10 concurrent — tests optimistic locking                       |
| [7] Chaos             | `docker stop` stock-service, fires order (expects 503), then `docker start` to recover |
| [8] Metrics           | Dumps gateway rolling-window stats                                                     |

---

## What's Fully Working

- ✅ Auth: register, login, JWT, rate limiting (3/min per studentId)
- ✅ Stock: 100% success rate at ~45ms avg under 100 sequential requests
- ✅ Concurrent orders: 50/50 success with optimistic locking + 15-retry exponential backoff
- ✅ Async kitchen pipeline: RabbitMQ → 3–7s cook → READY status
- ✅ Real-time WebSocket: `orderStatus` events delivered to browser per student room
- ✅ Chaos resilience: gateway returns 503 gracefully when stock-service is down
- ✅ Observability: Prometheus scraping all 5 services, Grafana dashboards live
- ✅ Secrets management: all secrets in `.env` / `k8s/secrets.yaml`, nothing hardcoded (Gap Fix 1)
- ✅ Test suite: 83 unit tests + 16 integration tests across all 5 services (Gap Fix 2)
- ✅ Production Docker build: frontend served via nginx:alpine via `Dockerfile.prod` (Gap Fix 8)
- ✅ Grafana metric name: WebSocket Connected Clients panel uses correct `websocket_connected_clients` (Gap Fix 9)
- ✅ Docker Compose healthchecks: all infra services have healthchecks; app services wait via `service_healthy` (Gap Fix 10)
- ✅ Registration auto-login: JWT returned on register is used directly, no second login needed (Gap Fix 11)
- ✅ Dead queue removed: `order_status_queue` assertion removed from both gateway and kitchen (Gap Fix 12)
- ✅ Redis cache metrics: `cache_hits_total` and `cache_misses_total` counters on gateway (Gap Fix 13)
- ✅ Cache TTL extended: stock cache TTL extended from 5 min to 24 h (Gap Fix 14)
- ✅ Circuit breaker: custom 3-state circuit breaker wraps all stock-service calls (Gap Fix 15)
- ✅ Idempotency key: optional `Idempotency-Key` header prevents duplicate orders on retry (Gap Fix 16)
- ✅ Integration tests: 16 end-to-end HTTP flow tests covering full order lifecycle (Gap Fix 17)
- ✅ Order history page: full "Orders" view with status badges, item names, quantities, and summary stats (Gap Fix 18)
- ✅ Quantity selector: users can select quantity 1–50 per order with +/− controls (Gap Fix 19)
- ✅ K8s resource limits: all 6 Deployments have CPU/memory `requests` and `limits` set (Gap Fix 20)
- ✅ WebSocket-driven updates: stock, health, and order updates pushed via Socket.IO — polling reduced to 30s fallback (Gap Fix 21)

---

## Recently Fixed Gaps

### Gap Fix 1: Secrets Management (was "Secrets in plaintext")

**Problem:** JWT secret, DB passwords, RabbitMQ credentials, and Grafana admin password were all hardcoded directly in `docker-compose.yml`, K8s manifests, and service source code.

**Solution implemented:**

| Change                                                                                               | Files                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Created `.env` file with all secret values, loaded by Docker Compose via `${VARIABLE}` interpolation | `.env`, `.env.example`                                                                                                                                                           |
| Added `.env` to `.gitignore` so secrets are never committed                                          | `.gitignore`                                                                                                                                                                     |
| Created `.env.example` as a template with placeholder values for new developers                      | `.env.example`                                                                                                                                                                   |
| Replaced all 9 hardcoded secret references in `docker-compose.yml` with `${VAR}` syntax              | `docker-compose.yml`                                                                                                                                                             |
| Created `k8s/secrets.yaml` (Kubernetes `Opaque` Secret) with base64-encoded values                   | `k8s/secrets.yaml`                                                                                                                                                               |
| Updated 7 K8s manifests to use `secretKeyRef` from `eziftar-secrets` instead of plaintext `value:`   | `k8s/identity-provider.yaml`, `k8s/order-gateway.yaml`, `k8s/stock-service.yaml`, `k8s/kitchen-service.yaml`, `k8s/identity-db.yaml`, `k8s/stock-db.yaml`, `k8s/kitchen-db.yaml` |
| Added RabbitMQ credentials to `k8s/rabbitmq.yaml` via `secretKeyRef`                                 | `k8s/rabbitmq.yaml`                                                                                                                                                              |

**Secrets managed:** `JWT_SECRET`, `IDENTITY_DB_USER/PASSWORD`, `STOCK_DB_USER/PASSWORD`, `KITCHEN_DB_USER/PASSWORD`, `RABBITMQ_USER/PASS`, `GF_SECURITY_ADMIN_PASSWORD`

---

### Gap Fix 2: Test Suite (was "No real test suite")

**Problem:** CI workflow (`ci.yml`) only checked that services build — no unit or integration tests existed for any service.

**Solution implemented:**

| Service           | Test File                              | Tests        | What's Covered                                                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity-provider | `src/index.test.ts`                    | 11           | JWT sign/verify/expiry, bcrypt hash/compare, input validation, payload structure, rate limit logic                                                                                                                                                                                                    |
| stock-service     | `src/index.test.ts`                    | 16           | Optimistic locking logic, concurrent modification detection, exponential backoff, idempotency, stock validation, seed data integrity, Redis cache key format and short-circuit logic                                                                                                                  |
| kitchen-service   | `src/index.test.ts`                    | 14           | Order status lifecycle (IN_KITCHEN→READY/FAILED), cooking time bounds (3-7s), queue message parsing, notification payloads, query filters, reconnect config                                                                                                                                           |
| notification-hub  | `src/index.test.ts`                    | 9            | Payload validation, room routing format, event emission logic (personal + broadcast), status tracking, health response structure                                                                                                                                                                      |
| order-gateway     | `src/index.test.ts`                    | 33           | JWT middleware (reject/extract/expire), order payload validation, unique ID generation, kitchen message format, Redis cache check logic, rolling window stats, chaos toggle validation, auth proxy path rewrite, circuit breaker state transitions, idempotency key handling, cache hit/miss tracking |
| **Unit Total**    | **5 files**                            | **83 tests** | All pass (verified in Docker with `oven/bun:latest`)                                                                                                                                                                                                                                                  |
| **Integration**   | `tests/integration/order-flow.test.ts` | **16 tests** | Full HTTP flow: register → login → stock → order → idempotency → rate limit → concurrency → metrics → circuit breaker → kitchen processing                                                                                                                                                            |

**CI/CD updated:** Added `bun test` step after each service's build step in `.github/workflows/ci.yml`. Tests run as part of the `build-and-test` job and will fail the pipeline if any test breaks.

---

### Gap Fix 3: Observability & Metrics UI (was "Metrics page only shows process stats")

**Problem:** The frontend Metrics page only displayed process-level metrics (Memory, Heap, CPU, Event Loop Lag). Business-critical metrics like orders processed, failure counts, and avg latency were missing — even though every service exposed them via Prometheus.

**Solution implemented:**

| Change                                                                                                                                                                                                                                                                                                        | Files                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Added `getLabeledValue()` helper to parse Prometheus metrics with labels (e.g. `orders_total{status="accepted"}`)                                                                                                                                                                                             | `services/frontend/src/App.tsx` |
| Enhanced `getValue()` to sum across all labeled instances of a metric (needed for histogram `_sum`/`_count` which have per-route labels)                                                                                                                                                                      | `services/frontend/src/App.tsx` |
| Added **Business Metrics** section to `ServiceMetricsViewer` component, rendered above Process Metrics with color-coded left borders                                                                                                                                                                          | `services/frontend/src/App.tsx` |
| Business metrics shown per service: Gateway (Orders Accepted, Orders Failed), Identity (Login Success, Login Failed), Stock (Deductions OK, Deductions Failed), Kitchen (Orders Completed, Orders Failed), Notification (Notifications Sent, WS Clients). All services also show Avg Latency + Total Requests | `services/frontend/src/App.tsx` |

---

### Gap Fix 4: Frontend Latency Alert Bug (was "avgLatency always undefined")

**Problem:** `fetchStats` read `res.data.averageLatency` but the gateway endpoint returns `averageLatencyMs`. Result: `avgLatency` was always `undefined`, the HIGH LATENCY alert never triggered.

**Solution:** Changed to `res.data.averageLatencyMs / 1000` so the value is correctly in seconds and the `> 1` threshold works.

**File:** `services/frontend/src/App.tsx`

---

### Gap Fix 5: PENDING Status in Order Lifecycle

**Problem:** The requirement specifies a 4-step lifecycle: `Pending → Stock Verified → In Kitchen → Ready`. But `PENDING` was never emitted — the first status the user saw was `STOCK_VERIFIED`.

**Solution:** In the gateway's `POST /api/orders` handler, the `orderId` is now generated early (before cache check), and a fire-and-forget `POST /notify` is sent to the Notification Hub with status `PENDING` before any stock logic runs. This means the WebSocket delivers `PENDING` to the frontend while the gateway is still processing.

**File:** `services/order-gateway/src/index.ts`

---

### Gap Fix 6: Gateway `/health` Aggregated Dependency Check

**Problem:** `GET /health` always returned `200 UP` regardless of whether Redis, RabbitMQ, or downstream services were reachable. The requirement says return `503` if a dependency is down.

**Solution:** Replaced the static response with an aggregated check that:

- Pings Redis (`PING`)
- Checks RabbitMQ channel existence
- Polls `/health` on all 4 downstream services (identity-provider, stock-service, kitchen-service, notification-hub) with 2s timeout
- Returns `200 {"status": "UP"}` if all pass, or `503 {"status": "DEGRADED", "dependencies": {...}}` with per-dep UP/DOWN

**File:** `services/order-gateway/src/index.ts`

---

### Gap Fix 7: Notification Hub Health + Metrics

**Problem:** (a) The `/health` endpoint always returned `200 UP` without checking if the WebSocket server was actually listening. (b) The service was missing the `http_request_duration_seconds` histogram that all other services had, so Avg Latency and Total Requests showed `0` on the Metrics page.

**Solution:**

- `/health` now checks `httpServer.listening` — returns `503 DOWN` with `websocket: "INACTIVE"` if the server isn't ready
- Added `http_request_duration_seconds` Histogram + timing middleware (matching the pattern used by all other services)
- Added `shuttingDown` flag to `/admin/shutdown` — health returns `503` immediately while the process delays exit by 3s, giving the frontend time to detect DOWN state

**File:** `services/notification-hub/src/index.ts`

---

### Gap Fix 8: Frontend Production Docker Build

**Problem:** `docker-compose.yml` used the dev `Dockerfile` which ran `bun run dev` (Vite HMR server). The production `Dockerfile.prod` existed but wasn't wired in.

**Solution:**

| Change                                                                                                                                                  | Files                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Updated `docker-compose.yml` frontend service to use `Dockerfile.prod` with build args for `VITE_API_GATEWAY_URL` and `VITE_NOTIFICATION_HUB_URL`       | `docker-compose.yml`                |
| Port mapping changed from `5173:5173` to `5173:80` (nginx serves on port 80)                                                                            | `docker-compose.yml`                |
| Enhanced `Dockerfile.prod` to accept `ARG` for Vite env vars (baked in at build time) and added nginx SPA fallback (`try_files $uri $uri/ /index.html`) | `services/frontend/Dockerfile.prod` |

Frontend now served as static files via nginx:alpine instead of a Vite dev server.

---

### Gap Fix 9: Grafana Dashboard Wrong Metric Name

**Problem:** The WebSocket Connected Clients panel in the Grafana dashboard (`monitoring/grafana/dashboards/eziftar.json`) queried `connected_clients`, but the actual Prometheus metric exposed by notification-hub is `websocket_connected_clients`. The panel displayed no data.

**Solution:** Changed the PromQL expression from `connected_clients` to `websocket_connected_clients` in the dashboard JSON.

**File:** `monitoring/grafana/dashboards/eziftar.json`

---

### Gap Fix 10: Docker Compose Healthchecks & Dependency Ordering

**Problem:** The `docker-compose.yml` had no healthchecks on infrastructure services (PostgreSQL, Redis, RabbitMQ). App services used simple `depends_on: - db` which only waits for the container to start, not for the service inside to be ready. This caused race conditions on `docker compose up` where Prisma migrations would fail because the database wasn't accepting connections yet.

**Solution:**

| Change                                            | Detail                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Added `healthcheck` to all 3 PostgreSQL databases | `pg_isready -U $USER -d $DB` every 10s, 5 retries                                                                         |
| Added `healthcheck` to Redis                      | `redis-cli ping` every 10s, 5 retries                                                                                     |
| Added `healthcheck` to RabbitMQ                   | `rabbitmq-diagnostics check_port_connectivity` every 10s, 5 retries                                                       |
| Updated `identity-provider` depends_on            | `identity-db: condition: service_healthy`                                                                                 |
| Updated `stock-service` depends_on                | `stock-db: condition: service_healthy`, `redis: condition: service_healthy`                                               |
| Updated `kitchen-service` depends_on              | `kitchen-db: condition: service_healthy`, `rabbitmq: condition: service_healthy`                                          |
| Updated `notification-hub` depends_on             | `rabbitmq: condition: service_healthy`                                                                                    |
| Updated `order-gateway` depends_on                | `redis: condition: service_healthy`, `rabbitmq: condition: service_healthy`, other services: `condition: service_started` |

**File:** `docker-compose.yml`

---

### Gap Fix 11: Registration Auto-Login

**Problem:** The Identity Provider returns a JWT token on successful registration, but the frontend's `handleRegister()` discarded it and redirected back to the login form, forcing the user to enter credentials again.

**Solution:** Changed `handleRegister()` to capture the returned token and student data from the registration response, store the JWT in `localStorage`, set user state, and navigate directly to the dashboard — matching the `handleLogin()` flow.

**File:** `services/frontend/src/App.tsx`

---

### Gap Fix 12: Dead `order_status_queue` Removed

**Problem:** Both Order Gateway and Kitchen Service called `channel.assertQueue("order_status_queue")` during RabbitMQ connection, but no service ever consumed from this queue. It was a leftover from the architecture design that ended up using HTTP `POST /notify` to the Notification Hub instead.

**Solution:** Removed the `assertQueue("order_status_queue")` call from both services. The `kitchen_queue` remains as the sole actively used queue, and the notification flow continues via HTTP as designed.

**Files:** `services/order-gateway/src/index.ts`, `services/kitchen-service/src/index.ts`

---

### Gap Fix 13: Redis Cache Hit/Miss Metrics

**Problem:** The Order Gateway checks Redis cache for stock availability before calling the Stock Service, but there was no observability into cache effectiveness. Without `cache_hits_total` and `cache_misses_total` counters, there was no way to measure or visualize the cache hit rate in Grafana.

**Solution:**

| Change                                          | Detail                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Added `cache_hits_total` Prometheus Counter     | Incremented when Redis returns a cached value for `stock:{itemId}`                                         |
| Added `cache_misses_total` Prometheus Counter   | Incremented when Redis returns `null` (cache miss) or on Redis error (fallthrough to DB)                   |
| Updated cache check logic in `POST /api/orders` | Split the existing `if (cachedStock !== null && ...)` into separate hit/miss branches with metric tracking |

**File:** `services/order-gateway/src/index.ts`

---

### Gap Fix 14: Cache TTL Extended (5min → 24h)

**Problem:** Redis cache keys for stock levels (`stock:{itemId}`) had a 5-minute TTL (`"EX", 300`). Since the Stock Service uses write-through cache invalidation (updates Redis on every deduction, seed, and reset), the short TTL caused unnecessary cache misses during quiet periods without improving data freshness.

**Solution:** Extended TTL from 300 seconds (5 minutes) to 86400 seconds (24 hours). Write-through ensures cache is always up-to-date on writes; the TTL now serves only as a safety net for edge cases.

| Change                                                        | Files                                 |
| ------------------------------------------------------------- | ------------------------------------- |
| `syncAllStockToCache()` — changed `"EX", 300` → `"EX", 86400` | `services/stock-service/src/index.ts` |
| `deductStock()` — changed `"EX", 300` → `"EX", 86400`         | `services/stock-service/src/index.ts` |

---

### Gap Fix 15: Circuit Breaker on Stock Service Calls

**Problem:** The Order Gateway called the Stock Service directly via `axios.post()`. If the Stock Service went down or became slow, every order request would wait for the full timeout (2s) before failing. With high traffic, this cascading failure could exhaust gateway resources.

**Solution:** Implemented a custom `CircuitBreaker` class directly in the Order Gateway (no external dependency needed):

| Feature              | Detail                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **Pattern**          | Three-state circuit breaker: CLOSED → OPEN → HALF_OPEN → CLOSED                           |
| **Threshold**        | Opens after 5 consecutive failures                                                        |
| **Reset Timeout**    | Attempts reconnection after 10 seconds in OPEN state                                      |
| **Prometheus Gauge** | `circuit_breaker_state{target="stock-service"}` — 0=CLOSED, 1=HALF_OPEN, 2=OPEN           |
| **Health Check**     | Circuit breaker state reported in `GET /health` → `dependencies["stock-circuit-breaker"]` |
| **Fail-fast**        | When OPEN, immediately returns `503 CIRCUIT_OPEN` without waiting for timeout             |
| **Self-healing**     | Successful call in HALF_OPEN state resets to CLOSED                                       |

**File:** `services/order-gateway/src/index.ts`

---

### Gap Fix 16: Gateway-Level Idempotency Key

**Problem:** If a client retried a failed or timed-out order request, the gateway would process it as a new order — potentially deducting stock twice. The Stock Service had idempotency at the `orderId` level, but `orderId` was generated server-side, so each retry got a new `orderId`.

**Solution:** Added `Idempotency-Key` header support to `POST /api/orders`:

| Feature             | Detail                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| **Header**          | Client sends `Idempotency-Key: <unique-string>` with the order request                          |
| **Storage**         | Key → response JSON stored in Redis as `idempotency:{key}` with 5-minute TTL                    |
| **Duplicate Check** | Before processing, checks if key exists in Redis. If found, returns cached response immediately |
| **Optional**        | Header is optional — orders without it work exactly as before                                   |
| **TTL**             | Cached response expires after 5 minutes (reasonable retry window)                               |

**File:** `services/order-gateway/src/index.ts`

---

### Gap Fix 17: Integration Tests

**Problem:** The project had 70 unit tests across all 5 services, but no integration tests that verify the full HTTP request flow across services. Unit tests test logic in isolation; integration tests verify services work together.

**Solution:**

| Change                                                              | Detail                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Created `tests/integration/order-flow.test.ts`                      | 16 integration tests covering the full order lifecycle     |
| Created `tests/integration/package.json`                            | Bun test runner config with 30s timeout for long flows     |
| Updated `.github/workflows/ci.yml`                                  | Added integration test step to CI pipeline                 |
| Added circuit breaker, idempotency key, and cache metric unit tests | 13 new tests in `services/order-gateway/src/index.test.ts` |

**Integration tests cover:**

| #   | Test                        | What it verifies                                               |
| --- | --------------------------- | -------------------------------------------------------------- |
| 1   | Health check                | All services UP, all dependencies healthy                      |
| 2   | Register                    | Creates student, returns JWT                                   |
| 3   | Login                       | Authenticates, returns JWT                                     |
| 4   | Fetch Stock                 | 6 menu items with positive stock                               |
| 5   | Place Order                 | Full flow: JWT → cache → stock deduction → kitchen queue → 200 |
| 6   | Stock Deducted              | Verifies stock decreased by 1 after order                      |
| 7   | Idempotency Key (same)      | Duplicate key returns cached response with same orderId        |
| 8   | Idempotency Key (different) | Different keys create separate orders                          |
| 9   | Unauthorized                | Rejects order without JWT (401)                                |
| 10  | Missing Fields              | Rejects order without itemId (400)                             |
| 11  | Rate Limiting               | Blocks after 3 failed logins (429)                             |
| 12  | Concurrent Orders           | 10 simultaneous orders succeed with optimistic locking         |
| 13  | Metrics                     | Gateway exposes all Prometheus metrics including new ones      |
| 14  | Gateway Stats               | Rolling window latency endpoint works                          |
| 15  | Health + CB                 | Circuit breaker state reported in health check                 |
| 16  | Kitchen Processing          | Orders appear in kitchen service after processing              |

## **Files:** `tests/integration/order-flow.test.ts`, `tests/integration/package.json`, `services/order-gateway/src/index.test.ts`, `.github/workflows/ci.yml`

### Gap Fix 18: Order History Page

**Problem:** The Order Gateway already exposed `GET /api/orders` (proxied to kitchen-service's `GET /orders?studentId=`), but the frontend had no UI to display past orders. Users could place orders but never review their order history.

**Solution:** Added a full "Orders" view to the frontend SPA:

| Change                         | Detail                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Added `orderHistory` state     | `useState<any[]>([])` to store fetched orders                                                                |
| Added `fetchOrders()` function | Calls `GET /api/orders` with JWT, populates `orderHistory` state                                             |
| Added "Orders" nav button      | New navigation button in the header bar alongside Dashboard, Metrics, Admin, Grafana                         |
| Order list with item lookup    | Each order shows the item name (looked up from `items` array by `itemId`), quantity, and formatted timestamp |
| Status badges (color-coded)    | `READY` = green, `IN_KITCHEN` = yellow, `FAILED` = red, other = blue                                         |
| Summary stats bar              | Shows Total orders, Ready count, In Kitchen count, and Failed count at the bottom of the view                |
| Auto-refresh on order events   | `fetchOrders()` called on WebSocket `orderUpdate` event and after placing a new order                        |

**File:** `services/frontend/src/App.tsx`

---

### Gap Fix 19: Quantity Selector

**Problem:** The frontend hardcoded `quantity: 1` in the order payload sent to `POST /api/orders`. Users could not order multiple units of the same item.

**Solution:**

| Change                     | Detail                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Added `quantity` state     | `useState<number>(1)` — tracks selected quantity                                            |
| Added quantity selector UI | `−` button, number input (range 1–50), `+` button — displayed below stock dropdown          |
| Wired into `placeOrder()`  | Order payload now sends `quantity` variable instead of hardcoded `1`                        |
| Input validation           | `Math.max(1, Math.min(50, value))` — prevents invalid quantities; buttons disable at bounds |

**File:** `services/frontend/src/App.tsx`

---

### Gap Fix 20: K8s Resource Limits

**Problem:** None of the 6 Kubernetes Deployments (identity-provider, order-gateway, stock-service, kitchen-service, notification-hub, frontend) had CPU/memory `requests` or `limits` set. In a real cluster, the scheduler cannot make informed placement decisions without resource requests, and pods without limits can consume unbounded resources.

**Solution:** Added `resources.requests` and `resources.limits` to all 6 Deployment containers, sized proportionally by workload:

| Deployment          | CPU Request | Memory Request | CPU Limit | Memory Limit | Rationale                            |
| ------------------- | ----------- | -------------- | --------- | ------------ | ------------------------------------ |
| `order-gateway`     | 200m        | 256Mi          | 1000m     | 1Gi          | Handles all traffic — needs headroom |
| `identity-provider` | 100m        | 128Mi          | 500m      | 512Mi        | Standard service workload            |
| `stock-service`     | 100m        | 128Mi          | 500m      | 512Mi        | Standard service workload            |
| `kitchen-service`   | 100m        | 128Mi          | 500m      | 512Mi        | Standard service workload            |
| `notification-hub`  | 100m        | 128Mi          | 500m      | 512Mi        | Standard service workload            |
| `frontend`          | 50m         | 64Mi           | 200m      | 256Mi        | Static nginx — minimal resources     |

**Files:** `k8s/identity-provider.yaml`, `k8s/order-gateway.yaml`, `k8s/stock-service.yaml`, `k8s/kitchen-service.yaml`, `k8s/notification-hub.yaml`, `k8s/frontend.yaml`

---

### Gap Fix 21: WebSocket-Driven Updates (Replace Polling)

**Problem:** The frontend polled `GET /api/health/:service` every 5 seconds and `GET /api/stock/items` on every render cycle. This created unnecessary HTTP traffic and latency, especially since Socket.IO was already connected for order status updates.

**Solution:** Extended the WebSocket infrastructure to push stock and health updates, reducing polling to a 30-second fallback:

| Change                                       | Detail                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /broadcast/stock` on notification-hub  | New endpoint: receives `{ items }` array, emits `stockUpdate` to all connected Socket.IO clients                                               |
| `POST /broadcast/health` on notification-hub | New endpoint: receives `{ dependencies }` object, emits `healthUpdate` to all connected Socket.IO clients                                      |
| Gateway stock broadcast after order          | After `ordersTotal.inc()`, gateway fetches latest stock via `GET /items` and POSTs to `/broadcast/stock` on notification-hub (fire-and-forget) |
| Gateway periodic health broadcast            | `setInterval` every 10s: checks all downstream services health, broadcasts via `POST /broadcast/health` to notification-hub                    |
| Frontend `stockUpdate` listener              | WebSocket event handler updates `items` state directly from pushed data — no HTTP request needed                                               |
| Frontend `healthUpdate` listener             | WebSocket event handler updates `serviceHealth` state directly from pushed data — no HTTP request needed                                       |
| Frontend `orderUpdate` listener              | WebSocket event handler triggers `fetchOrders()` to refresh order history                                                                      |
| Polling reduced to 30s fallback              | `setInterval` changed from 5000ms to 30000ms — only fires if WebSocket events are missed                                                       |

**Files:** `services/notification-hub/src/index.ts`, `services/order-gateway/src/index.ts`, `services/frontend/src/App.tsx`
