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

| What's done                      | Detail                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth` (proxy)         | Proxied to identity-provider via `http-proxy-middleware` v2. Fixed: `onProxyReq` re-serializes body after `express.json()` consumes it |
| `GET /api/stock/items`           | Passes through to stock-service                                                                                                        |
| `POST /api/orders`               | Full core flow: Redis cache check → stock deduction → RabbitMQ `kitchen_queue` → respond <2s                                           |
| `GET /api/orders`                | Fetches orders by studentId from kitchen-service                                                                                       |
| `POST /api/admin/chaos/:service` | Sends `/admin/shutdown` to target service. Valid: stock-service, kitchen-service, notification-hub                                     |
| `GET /api/health/:service`       | Polls health of gateway, identity, stock, kitchen, notification                                                                        |
| `GET /api/metrics/:service`      | Fetches raw Prometheus data from each service — proxied to frontend                                                                    |
| `GET /api/stats/gateway`         | Rolling 30s window avg latency in ms + request count                                                                                   |
| JWT Middleware                   | Verifies Bearer token locally (no round-trip to identity-provider)                                                                     |
| Redis                            | Checks `stock:{itemId}` cache before calling stock-service. Short-circuits if `<= 0`                                                   |
| RabbitMQ                         | Produces to `kitchen_queue` and `order_status_queue`                                                                                   |
| Prometheus                       | `http_request_duration_seconds` histogram, `orders_total` counter, `orders_failed_total` counter                                       |

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
| Redis sync             | Updates `stock:{id}` with 5-min TTL after each deduction. Full cache sync on seed/reset                                                                      |
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

| What's done            | Detail                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| Socket.IO server       | `socket.io` 4.7.4 on top of `http.createServer` with CORS `*`                                              |
| Room-based routing     | Client emits `join(studentId)` → joins room `student:{studentId}` → receives personal `orderStatus` events |
| Broadcast              | Every status change also emits `orderUpdate` to ALL clients (admin dashboard)                              |
| `POST /notify`         | Called by kitchen-service. Emits to student room + all clients                                             |
| `GET /health`          | Returns UP + current `connectedClients` count                                                              |
| `GET /metrics`         | Prometheus — `notifications_sent_total{status}` counter + `websocket_connected_clients` gauge              |
| `POST /admin/shutdown` | Chaos toggle                                                                                               |

---

### 6. Frontend (`services/frontend/`)

| What's done        | Detail                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Auth screen        | Toggle between Login and Register forms with proper state binding                                           |
| JWT persistence    | Stored in `localStorage`, decoded on mount to restore user session                                          |
| Dashboard          | Dropdown of live menu items with stock + price. One-click order placement                                   |
| Live order tracker | Shows real-time status updates per order via WebSocket (`orderStatus` event)                                |
| Latency display    | Per-request `performance.now()` latency with colour coding (<1000ms=green, >1000ms=red)                     |
| Avg latency alert  | Polls `/api/stats/gateway` every 2s, shows ⚠️ HIGH LATENCY badge if avg > 1s                                |
| Health panel       | Polls `/api/health/:service` every 5s for all 5 services                                                    |
| Metrics page       | Fetches raw Prometheus data from all 5 services, parses and displays Memory/Heap/CPU/Handles/Event Loop Lag |
| Admin page         | Chaos Toggle buttons for all 3 killable services + chaos log                                                |
| Grafana link       | "Grafana ↗" nav button → `localhost:3005/dashboards`                                                        |
| Prod Dockerfile    | Separate `Dockerfile.prod` with multi-stage build: Node:18 builds → nginx:alpine serves `/dist`             |
| Dev Dockerfile     | Bun-based dev server inside Docker (`vite --host`)                                                          |

---

## Infrastructure & DevOps

### Docker Compose (`docker-compose.yml`)

| Container         | Image                   | Port         |
| ----------------- | ----------------------- | ------------ |
| identity-provider | `oven/bun` built        | 3000         |
| order-gateway     | `oven/bun` built        | 8080         |
| stock-service     | `oven/bun` built        | 3002         |
| kitchen-service   | `oven/bun` built        | 3003         |
| notification-hub  | `oven/bun` built        | 3004         |
| frontend          | `oven/bun` built dev    | 5173         |
| identity-db       | `postgres:14-alpine`    | 5433         |
| stock-db          | `postgres:14-alpine`    | 5434         |
| kitchen-db        | `postgres:14-alpine`    | 5435         |
| redis             | `redis:7-alpine`        | 6379         |
| rabbitmq          | `rabbitmq:3-management` | 5672 / 15672 |
| prometheus        | `prom/prometheus`       | 9090         |
| grafana           | `grafana/grafana`       | 3005         |

All app services have `restart: always`. Databases use named volumes for persistence. Prisma migrations run on container start via `bunx prisma db push`.

---

### Monitoring (`monitoring/`)

- **Prometheus** scrapes all 5 services every 15s at `/metrics`
- **Grafana** auto-provisions dashboards from `monitoring/grafana/dashboards/` (2 JSON dashboards: `services.json`, `valerix.json`)
- Grafana datasource auto-provisioned pointing to `http://prometheus:9090`
- Admin password: `admin`

---

### Kubernetes (`k8s/` — 13 YAML files)

| File                     | What it defines                                                 |
| ------------------------ | --------------------------------------------------------------- |
| `identity-provider.yaml` | Deployment + ClusterIP Service                                  |
| `order-gateway.yaml`     | Deployment (with readiness/liveness probes) + ClusterIP Service |
| `stock-service.yaml`     | Deployment + ClusterIP Service                                  |
| `kitchen-service.yaml`   | Deployment + ClusterIP Service                                  |
| `notification-hub.yaml`  | Deployment + ClusterIP Service                                  |
| `frontend.yaml`          | Deployment + ClusterIP Service                                  |
| `identity-db.yaml`       | StatefulSet + PVC + Service                                     |
| `stock-db.yaml`          | StatefulSet + PVC + Service                                     |
| `kitchen-db.yaml`        | StatefulSet + PVC + Service                                     |
| `redis.yaml`             | Deployment + Service                                            |
| `rabbitmq.yaml`          | Deployment + Service                                            |
| `ingress.yaml`           | NGINX Ingress — `eziftar.local` → gateway + frontend            |
| `service-monitor.yaml`   | Prometheus Operator ServiceMonitor for auto-scraping            |

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

## What's Fully Working (Verified by Load Test)

- ✅ Auth: register, login, JWT, rate limiting (3/min per studentId)
- ✅ Stock: 100% success rate at ~45ms avg under 100 sequential requests
- ✅ Concurrent orders: 50/50 success with optimistic locking + 15-retry exponential backoff
- ✅ Async kitchen pipeline: RabbitMQ → 3–7s cook → READY status
- ✅ Real-time WebSocket: `orderStatus` events delivered to browser per student room
- ✅ Chaos resilience: gateway returns 503 gracefully when stock-service is down
- ✅ Observability: Prometheus scraping all 5 services, Grafana dashboards live

---

## What's Missing / Can Be Improved Next

| Gap                                                                                                                                              | Severity                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| ~~**Secrets in plaintext** — JWT secret and DB passwords hardcoded in `docker-compose.yml` and k8s YAML~~                                        | ✅ **FIXED** — see details below                |
| ~~**No real test suite** — CI only checks build, no unit or integration tests~~                                                                  | ✅ **FIXED** — see details below                |
| **Frontend runs in dev mode in Docker** — `Dockerfile` runs Vite dev server; `Dockerfile.prod` exists but is not wired into `docker-compose.yml` | Should swap to `Dockerfile.prod` for production |
| **No order history page** — `GET /api/orders` endpoint exists but frontend has no view listing past orders                                       |                                                 |
| **Quantity always 1** — frontend hardcodes `quantity: 1` in order payload                                                                        |                                                 |
| **Stock endpoint is unauthenticated** — `GET /api/stock/items` requires no JWT                                                                   | Depends on requirements                         |
| **No K8s resource limits** — CPU/memory `requests`/`limits` not set in any Deployment                                                            | Would fail real cluster scheduling              |
| ~~**RabbitMQ credentials hardcoded** — `amqp://user:password@rabbitmq:5672` in all services~~                                                    | ✅ **FIXED** — part of secrets fix              |
| **`/reset` endpoint is unauthenticated** — anyone can reset all stock to initial values                                                          | Should require admin JWT                        |
| **Frontend polls every 5s** — health + items re-fetched on a fixed timer even with no changes                                                    | Could use WebSocket for health events too       |

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

| Service           | Test File           | Tests        | What's Covered                                                                                                                                                                                                  |
| ----------------- | ------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity-provider | `src/index.test.ts` | 11           | JWT sign/verify/expiry, bcrypt hash/compare, input validation, payload structure, rate limit logic                                                                                                              |
| stock-service     | `src/index.test.ts` | 16           | Optimistic locking logic, concurrent modification detection, exponential backoff, idempotency, stock validation, seed data integrity, Redis cache key format and short-circuit logic                            |
| kitchen-service   | `src/index.test.ts` | 14           | Order status lifecycle (IN_KITCHEN→READY/FAILED), cooking time bounds (3-7s), queue message parsing, notification payloads, query filters, reconnect config                                                     |
| notification-hub  | `src/index.test.ts` | 9            | Payload validation, room routing format, event emission logic (personal + broadcast), status tracking, health response structure                                                                                |
| order-gateway     | `src/index.test.ts` | 20           | JWT middleware (reject/extract/expire), order payload validation, unique ID generation, kitchen message format, Redis cache check logic, rolling window stats, chaos toggle validation, auth proxy path rewrite |
| **Total**         | **5 files**         | **70 tests** | All pass (verified in Docker with `oven/bun:latest`)                                                                                                                                                            |

**CI/CD updated:** Added `bun test` step after each service's build step in `.github/workflows/ci.yml`. Tests run as part of the `build-and-test` job and will fail the pipeline if any test breaks.
