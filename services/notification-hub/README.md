# notification-hub

Notification Hub for EzIftar - pushes real-time order status updates to students via WebSocket (Socket.IO).

## Install

```bash
bun install
```

## Run

```bash
bun run dev
```

## Endpoints

- `POST /notify` - Push notification (called by Kitchen Service)
- `GET /health` - Health check (includes connected client count)
- `GET /metrics` - Prometheus metrics

## WebSocket Events

- `orderStatus` - Sent to specific student's room
- `orderUpdate` - Broadcast to all connected clients (admin)
- `join` - Client joins their student room for personal notifications
