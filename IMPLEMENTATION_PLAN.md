# EzIftar - Implementation Plan

## Overview

A distributed, fault-tolerant microservice system for the IUT Cafeteria Iftar ordering rush. Modeled after the Valerix project structure (Bun runtime, Express, Prisma, PostgreSQL, RabbitMQ, React+Vite frontend, Prometheus+Grafana monitoring).

---

## Architecture Mapping: Question.md → EzIftar Services

| Question.md Service | EzIftar Service     | Port | Valerix Equivalent        | Key Differences                                          |
| ------------------- | ------------------- | ---- | ------------------------- | -------------------------------------------------------- |
| Identity Provider   | `identity-provider` | 3000 | **NEW** (not in Valerix)  | JWT auth, bcrypt passwords, rate limiting (3/min)        |
| Order Gateway       | `order-gateway`     | 8080 | `api-gateway`             | Adds JWT validation middleware + Redis cache stock check |
| Stock Service       | `stock-service`     | 3002 | `inventory-service`       | Optimistic locking (version field), Redis cache sync     |
| Kitchen Queue       | `kitchen-service`   | 3003 | `order-service` (partial) | Separate async processor, 3-7s cooking simulation        |
| Notification Hub    | `notification-hub`  | 3004 | **NEW** (not in Valerix)  | WebSocket (Socket.IO) for real-time push updates         |
| —                   | `frontend`          | 5173 | `frontend`                | Login page, order flow, live tracker, admin dashboard    |

### Infrastructure Services

| Service       | Image                 | Port(s)     | Purpose                      |
| ------------- | --------------------- | ----------- | ---------------------------- |
| `identity-db` | postgres:14-alpine    | 5433:5432   | Identity Provider database   |
| `stock-db`    | postgres:14-alpine    | 5434:5432   | Stock Service database       |
| `kitchen-db`  | postgres:14-alpine    | 5435:5432   | Kitchen Service database     |
| `redis`       | redis:7-alpine        | 6379:6379   | Caching layer for stock data |
| `rabbitmq`    | rabbitmq:3-management | 5672, 15672 | Async message broker         |
| `prometheus`  | prom/prometheus       | 9090        | Metrics collection           |
| `grafana`     | grafana/grafana       | 3005:3000   | Metrics visualization        |

---

## Requirement-to-Implementation Mapping

### A. Security & Authentication

| Requirement           | Implementation                                                                |
| --------------------- | ----------------------------------------------------------------------------- |
| Token Handshake       | `identity-provider`: POST `/auth/register` + POST `/auth/login` → returns JWT |
| Protected Routes      | `order-gateway`: JWT middleware on all `/api/*` routes (except `/api/auth/*`) |
| 401 Unauthorized      | Gateway rejects missing/invalid Bearer token with `401`                       |
| Rate Limiting (Bonus) | `identity-provider`: express-rate-limit, 3 login attempts/min per studentId   |

### B. Resilience & Fault Tolerance

| Requirement       | Implementation                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Idempotency Check | `stock-service`: IdempotencyLog table (same as Valerix), prevents double deduction                          |
| Async Processing  | `kitchen-service`: Consumes from `kitchen_queue`, simulates 3-7s cooking, publishes to `order_status_queue` |
| Timeout Handling  | `order-gateway`: 2s timeout on stock deduction call → fallback to RabbitMQ queue                            |
| Retry Logic       | All services: Retry RabbitMQ connection with exponential backoff                                            |

### C. Performance & Caching

| Requirement            | Implementation                                                             |
| ---------------------- | -------------------------------------------------------------------------- |
| Redis Cache            | `order-gateway`: Before calling stock-service, check Redis for stock count |
| Zero-stock fast reject | If Redis reports 0 stock → instant 400 rejection, never hits DB            |
| Cache Invalidation     | `stock-service`: On stock update → update Redis key `stock:<itemId>`       |

### D. CI/CD Pipeline

| Requirement        | Implementation                                                  |
| ------------------ | --------------------------------------------------------------- |
| Unit Tests         | Jest/Bun test for order validation + stock deduction logic      |
| Automated Pipeline | GitHub Actions: on push to `main` → run tests → fail on failure |
| Load Test          | Adapted from Valerix `load-test.sh` script                      |

### E. Observability & Monitoring

| Requirement          | Implementation                                                    |
| -------------------- | ----------------------------------------------------------------- |
| Health Endpoints     | Every service: `GET /health` → 200 if deps OK, 503 if dep down    |
| Metrics Endpoints    | Every service: `GET /metrics` via prom-client (Prometheus format) |
| Total orders         | Custom Prometheus counter `orders_total`                          |
| Failure counts       | Custom Prometheus counter `orders_failed_total`                   |
| Avg response latency | Custom Prometheus histogram `http_request_duration_seconds`       |

### F. Interface Requirements

| Requirement          | Implementation                                                             |
| -------------------- | -------------------------------------------------------------------------- |
| Auth Login           | Frontend: Login page → POST `/api/auth/login` → store JWT in localStorage  |
| Order Placement      | Frontend: Select Iftar item → POST `/api/orders` with Bearer token         |
| Live Status Tracker  | Frontend: Socket.IO connection to `notification-hub` for real-time updates |
| Status Flow          | Pending → Stock Verified → In Kitchen → Ready                              |
| Admin Health Grid    | Frontend: Admin page with green/red health indicators per service          |
| Admin Live Metrics   | Frontend: Real-time latency & throughput from `/api/metrics/*`             |
| Chaos Toggle (Admin) | Frontend: Button to kill/restart a service container via gateway endpoint  |
| Visual Alert (Bonus) | Frontend: Red alert badge if Gateway avg latency > 1s over 30s window      |

---

## Order Flow (End-to-End)

```
Student                Frontend              Gateway            Identity         Stock          Kitchen         Notification
  │                       │                    │                  │                │               │                │
  ├─ Login ──────────────►│                    │                  │                │               │                │
  │                       ├─ POST /auth/login─►├─ proxy ─────────►│                │               │                │
  │                       │                    │                  ├─ verify ──────►│                │                │
  │                       │◄─── JWT token ─────┤◄─── JWT ─────────┤                │               │                │
  │◄── Store token ───────┤                    │                  │                │               │                │
  │                        │                    │                  │                │               │                │
  ├─ Place Order ─────────►│                    │                  │                │               │                │
  │                       ├─ POST /api/orders──►│                  │                │               │                │
  │                       │  (Bearer JWT)      ├─ Validate JWT ──►│                │               │                │
  │                       │                    ├─ Check Redis ────┼────────────────►│               │                │
  │                       │                    │  (stock > 0?)    │                │               │                │
  │                       │                    ├─ POST /stock/deduct ──────────────►│               │                │
  │                       │                    │                  │                ├─ Deduct ─────►│                │
  │                       │                    │                  │                │  (optimistic) │                │
  │                       │                    │                  │                │◄── OK ────────┤                │
  │                       │                    ├─ Publish to kitchen_queue ────────┼───────────────►│                │
  │                       │◄── 200 Acknowledged┤                  │                │               │                │
  │◄── "Order Placed" ────┤                    │                  │                │               │                │
  │                       │                    │                  │                │               │                │
  │                       │                    │                  │                │               ├─ Cook (3-7s)   │
  │                       │                    │                  │                │               ├─ Publish status►│
  │                       │                    │                  │                │               │                ├─ WS Push
  │◄── "Ready!" ──────────┤◄─────── WebSocket notification ──────┼────────────────┼───────────────┼────────────────┤
```

---

## Project Structure

```
EzIftar/
├── docker-compose.yml
├── README.md
├── .gitignore
├── .dockerignore
├── IMPLEMENTATION_PLAN.md
├── .github/
│   └── workflows/
│       └── ci.yml
├── k8s/
│   ├── identity-provider.yaml
│   ├── order-gateway.yaml
│   ├── stock-service.yaml
│   ├── kitchen-service.yaml
│   ├── notification-hub.yaml
│   ├── frontend.yaml
│   ├── identity-db.yaml
│   ├── stock-db.yaml
│   ├── kitchen-db.yaml
│   ├── redis.yaml
│   ├── rabbitmq.yaml
│   ├── ingress.yaml
│   └── service-monitor.yaml
├── monitoring/
│   ├── prometheus/
│   │   └── prometheus.yml
│   └── grafana/
│       ├── dashboards/
│       │   └── eziftar.json
│       └── provisioning/
│           ├── dashboards/
│           │   └── dashboard.yml
│           └── datasources/
│               └── datasource.yml
├── scripts/
│   └── load-test.sh
├── public/
└── services/
    ├── identity-provider/
    │   ├── Dockerfile
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── index.ts
    │   ├── README.md
    │   ├── .gitignore
    │   ├── .dockerignore
    │   ├── prisma.config.ts
    │   ├── prisma/
    │   │   └── schema.prisma
    │   └── src/
    │       ├── index.ts
    │       └── db.ts
    ├── order-gateway/
    │   ├── Dockerfile
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── index.ts
    │   ├── README.md
    │   ├── .gitignore
    │   └── src/
    │       └── index.ts
    ├── stock-service/
    │   ├── Dockerfile
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── index.ts
    │   ├── README.md
    │   ├── .gitignore
    │   ├── .dockerignore
    │   ├── prisma.config.ts
    │   ├── prisma/
    │   │   └── schema.prisma
    │   └── src/
    │       ├── index.ts
    │       └── db.ts
    ├── kitchen-service/
    │   ├── Dockerfile
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── index.ts
    │   ├── README.md
    │   ├── .gitignore
    │   ├── .dockerignore
    │   ├── prisma.config.ts
    │   ├── prisma/
    │   │   └── schema.prisma
    │   └── src/
    │       ├── index.ts
    │       └── db.ts
    ├── notification-hub/
    │   ├── Dockerfile
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── index.ts
    │   ├── README.md
    │   ├── .gitignore
    │   └── src/
    │       └── index.ts
    └── frontend/
        ├── Dockerfile
        ├── Dockerfile.prod
        ├── index.html
        ├── package.json
        ├── tsconfig.json
        ├── vite.config.ts
        ├── .gitignore
        ├── .dockerignore
        └── src/
            ├── App.tsx
            ├── main.tsx
            └── index.css
```

---

## Day-by-Day Sprint Plan (7 Days)

### Day 1-2: Foundation

- [ ] Set up project structure with all services scaffolded
- [ ] docker-compose.yml with all containers
- [ ] Identity Provider: register/login with JWT + bcrypt
- [ ] Order Gateway: proxy + JWT validation middleware
- [ ] Verify `docker compose up` boots all services

### Day 3-4: Core Logic

- [ ] Stock Service: CRUD + optimistic locking + idempotency
- [ ] Redis cache integration (Gateway ↔ Stock Service)
- [ ] Kitchen Service: RabbitMQ consumer, 3-7s cooking simulation
- [ ] Notification Hub: Socket.IO WebSocket server
- [ ] End-to-end order flow working

### Day 5: Frontend

- [ ] Login page (JWT auth)
- [ ] Order placement with live status tracker
- [ ] Admin dashboard: health grid, metrics, chaos toggle

### Day 6: Observability & CI/CD

- [ ] Health + Metrics endpoints on all services
- [ ] Prometheus + Grafana configuration
- [ ] Unit tests (order validation, stock deduction)
- [ ] GitHub Actions CI pipeline

### Day 7: Polish & Bonus

- [ ] Rate limiting on Identity Provider
- [ ] Visual alert for high latency
- [ ] Load test script
- [ ] README documentation
- [ ] Final testing with `docker compose up`
