
EzIftar — Demo Video Script (3 Minutes)

IUT Cafeteria's old Ramadan ordering system was a single monolith — and it just couldn't handle the rush. We saw database locks, cascading failures, lost orders, and frustrated students. So, we broke it apart into six independent microservices, each running in its own container and connected through message queues, caches, and WebSockets. Now, the whole system spins up with a single `docker compose up` — thirteen containers, zero manual setup.


Student Registration & Login
-----------------------------------

A student registers with their ID, name, and password. On submit, the Identity Provider hashes the password with bcrypt, stores it in PostgreSQL, and immediately returns a JWT — the student lands on the Dashboard with no extra login step.

Security is built in — if you enter the wrong password three times within a minute, you'll see a 429 Too Many Requests error. That's our rate limiter at the Identity Provider, blocking brute-force attacks. After waiting for the time window to reset, we log in with the correct credentials, and we're taken straight to the EzIftar dashboard.


Dashboard Overview — What You're Looking At
------------------------------------------------

Let's walk through the Dashboard. At the top, you see the navigation bar — Dashboard, Metrics, Orders, Admin, and a direct link to Grafana. Below that is the Health Grid — five cards showing the real-time status of every microservice: Gateway, Identity, Stock, Kitchen, and Notification. Green means healthy. Next to those is the Average Latency card, which tracks the rolling thirty-second average — if it exceeds one second, a red alert badge appears.

Below the health grid is the Order Form — a dropdown listing available items with live stock counts and prices, a quantity selector, and the Place Order button. Underneath that there will be the Live Order Status panel, which will show real-time order progress via WebSocket once an order is placed. And at the bottom is the System Activity log. It is a live feed of everything happening under the hood: connections, status changes, circuit breaker events, etc.


Placing an Order — The Full Flow
-----------------------------------------------------

When the student places an order, it triggers a chain across four services. The Order Gateway first validates the JWT, then checks Redis cache — if stock is zero, it rejects instantly without touching the database. If stock is available, it calls the Stock Service, which uses optimistic locking with version checks to deduct safely — even under concurrent requests from hundreds of students.

If we look at the Live Order Status — it moves from Pending to Stock Verified to In Kitchen to Ready. Each update arrives via WebSocket in real time. You can see the item name, quantity badge, order ID, and timestamp — all pushed by the Notification Hub, no polling.

The stock dropdown also updates instantly — pushed via WebSocket, not a page refresh.


Order History & System Activity
---------------------------------------------------

The Order History shows every order with its status badge — green for Ready, yellow for In Kitchen, red for Failed. The summary bar at the bottom gives a quick count of total, ready, in-kitchen, and failed orders.


Fault Tolerance — The Kill Switch
-----------------------------------------------------

Now the Admin panel. This is where it gets interesting. The Admin panel has a Chaos Toggle — a kill switch for each service. Let's kill the Stock Service.

The health grid turns red within seconds. When we try to order, the circuit breaker kicks in — after five failures, it stops hitting the dead service entirely and rejects orders instantly. Failed orders show up in both Live Order Status with a red Failed badge, and in Order History for a full audit trail.

After restoring the service, the circuit breaker resets, health turns green, and orders flow again.

Now let's kill the Notification Hub. Watch the System Activity — it detects the WebSocket disconnect and automatically falls back to database polling every five seconds. Orders still process normally through RabbitMQ — we just lose real-time push. When we restore it, the WebSocket auto-reconnects within three seconds and switches back to real-time mode. No data is lost.


Monitoring & Observability
=======================================================

Every service exposes Prometheus metrics — orders processed, failures, average latency, cache hits, circuit breaker state. The frontend aggregates these into a live dashboard. If the gateway's average latency exceeds one second over a thirty-second window, a red visual alert appears.

For deeper monitoring, we have a Grafana dashboard with eight panels — service health, request rates, P95 latency, login attempts, order counts, kitchen processing, WebSocket client count, and stock deductions. All fed by Prometheus scraping every service.


Testing & CI/CD — Closing
========================================================
We have eighty-three unit tests across all five backend services and sixteen integration tests that run against the live stack. GitHub Actions runs the full suite on every push to main — build fails on any test failure.

EzIftar — six microservices, thirteen containers, one command. Fault-tolerant, real-time, and built to survive the Ramadan rush. Thank you.


T
