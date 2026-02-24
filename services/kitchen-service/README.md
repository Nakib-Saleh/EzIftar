# kitchen-service

Kitchen Service for EzIftar - async order processing via RabbitMQ with 3-7s cooking simulation.

## Install

```bash
bun install
```

## Run

```bash
bun run dev
```

## Endpoints

- `GET /orders` - Get all orders (filter by ?studentId=)
- `GET /orders/:orderId` - Get single order status
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

## Queue

Consumes from `kitchen_queue` (RabbitMQ) and publishes status updates to Notification Hub.
