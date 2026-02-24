# order-gateway

Order Gateway (API Gateway) for EzIftar - handles JWT validation, Redis cache stock checks, and request routing.

## Install

```bash
bun install
```

## Run

```bash
bun run dev
```

## Endpoints

- `POST /api/orders` - Place an order (JWT required)
- `GET /api/orders` - Get user's orders (JWT required)
- `GET /api/stock/items` - Get all menu items
- `POST /api/auth/register` - Register (proxied to Identity Provider)
- `POST /api/auth/login` - Login (proxied to Identity Provider)
- `GET /api/health/{service}` - Health check per service
- `GET /api/metrics/{service}` - Prometheus metrics per service
- `GET /api/stats/gateway` - Rolling window latency stats
- `POST /api/admin/chaos/{service}` - Chaos toggle (kill a service)
