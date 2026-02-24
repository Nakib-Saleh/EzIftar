# EzIftar - Resilient Microservices Cafeteria Ordering System

EzIftar is a distributed, fault-tolerant microservice system designed to handle the IUT Cafeteria's Ramadan Iftar ordering rush. The system breaks a fragile monolith into independent, containerized services that communicate over the network, ensuring reliability under heavy load.

## Architecture Overview

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────┐
│   Frontend   │────►│  Order Gateway   │────►│ Stock Service  │
│  (React+Vite)│     │  (JWT + Cache)   │     │ (Prisma + PG)  │
└─────────────┘     └──────┬───────────┘     └───────┬────────┘
                           │                         │
                    ┌──────▼───────┐          ┌──────▼────────┐
                    │   Identity    │          │     Redis      │
                    │   Provider    │          │   (Cache)      │
                    │  (JWT Auth)   │          └───────────────┘
                    └──────────────┘
                           │
                    ┌──────▼───────┐     ┌───────────────────┐
                    │   RabbitMQ    │────►│  Kitchen Service   │
                    │  (Msg Broker) │     │ (Async Processing) │
                    └──────────────┘     └───────┬───────────┘
                                                 │
                                          ┌──────▼────────┐
                                          │ Notification   │
                                          │    Hub         │
                                          │  (WebSocket)   │
                                          └───────────────┘
```

## Services

| Service               | Port | Description                                               |
| --------------------- | ---- | --------------------------------------------------------- |
| **Identity Provider** | 3000 | JWT authentication & authorization, rate limiting         |
| **Order Gateway**     | 8080 | API Gateway with JWT validation & Redis cache stock check |
| **Stock Service**     | 3002 | Inventory management with optimistic locking              |
| **Kitchen Service**   | 3003 | Async order processing (3-7s cooking simulation)          |
| **Notification Hub**  | 3004 | Real-time WebSocket (Socket.IO) status updates            |
| **Frontend**          | 5173 | React SPA - Student ordering & Admin dashboard            |

## Quick Start

### Prerequisites

- Docker and Docker Compose installed

### Run the System

```bash
docker compose up -d --build
```

### Access Points

| Service                 | URL                                    |
| ----------------------- | -------------------------------------- |
| **Frontend**            | http://localhost:5173                  |
| **API Gateway**         | http://localhost:8080                  |
| **Grafana**             | http://localhost:3005 (admin/admin)    |
| **Prometheus**          | http://localhost:9090                  |
| **RabbitMQ Management** | http://localhost:15672 (user/password) |

## Student Journey

1. **Register/Login** → Obtain JWT token
2. **Browse Menu** → View available Iftar items with stock
3. **Place Order** → Authenticated order triggers the full flow
4. **Live Tracking** → Real-time status: Pending → Stock Verified → In Kitchen → Ready

## API Endpoints

### Authentication

- `POST /api/auth/register` - Register new student
- `POST /api/auth/login` - Login & receive JWT

### Orders (Protected - requires Bearer token)

- `POST /api/orders` - Place an order
- `GET /api/orders` - Get order history

### Stock

- `GET /api/stock/items` - Get all menu items with stock

### Health & Metrics

- `GET /api/health/{service}` - Health check per service
- `GET /api/metrics/{service}` - Prometheus metrics per service

## Resilience Patterns

- **JWT Authentication**: All order routes protected with token validation
- **Redis Caching**: Zero-stock fast rejection without hitting DB
- **Optimistic Locking**: Prevents over-selling with version-based concurrency control
- **Async Processing**: Kitchen service decouples acknowledgment (<2s) from cooking (3-7s)
- **Idempotency**: Prevents duplicate stock deduction on retries
- **Real-time Updates**: WebSocket pushes eliminate client polling

## Monitoring

- **Health Grid**: Green/Red indicators per microservice
- **Live Metrics**: Real-time latency & throughput
- **Grafana Dashboard**: Comprehensive service monitoring
- **Visual Alert**: Red badge if avg latency > 1s over 30s window

## Testing

```bash
# Run unit tests
cd services/stock-service && bun test
cd services/order-gateway && bun test

# Run load test
chmod +x scripts/load-test.sh
./scripts/load-test.sh
```

## CI/CD

GitHub Actions pipeline runs on every push to `main`:

- Builds all services
- Runs unit tests
- Runs integration/load tests
- Fails on test failure
