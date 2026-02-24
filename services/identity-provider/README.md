# identity-provider

Identity Provider service for EzIftar - handles student authentication, JWT token issuance, and rate limiting.

## Install

```bash
bun install
```

## Run

```bash
bun run dev
```

## Endpoints

- `POST /auth/register` - Register a new student
- `POST /auth/login` - Login and get JWT token (rate limited: 3/min per studentId)
- `POST /auth/verify` - Verify a JWT token
- `GET /auth/me` - Get current user profile
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics
