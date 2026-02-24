# stock-service

Stock Service for EzIftar - manages Iftar menu inventory with optimistic locking and Redis cache sync.

## Install

```bash
bun install
```

## Run

```bash
bun run dev
```

## Endpoints

- `GET /items` - Get all menu items with stock
- `POST /stock/deduct` - Deduct stock (with idempotency + optimistic locking)
- `POST /seed` - Seed initial menu items
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics
