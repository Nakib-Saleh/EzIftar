# DevSprint 2026

## 1. The Scenario: The IUT Cafeteria Crisis

At the peak of Ramadan, the IUT Cafeteria faces a legendary digital rush. As 5:30 PM approaches, hundreds of fasting students stare at their phones, thumbs ready over the **“Order Now”** button. When ordering opens, the aging **“Spaghetti Monolith”** begins to choke. Database locks create bottlenecks, requests start timing out, and while the frontend shows a calm loading spinner, the backend struggles with deadlocked threads and failing services.

Last week, things escalated: the Ticketing Service crashed completely. The kitchen received no orders, and students were left confused as their orders seemed to disappear into the system. Long physical queues formed as the server froze under the heavy load.

It’s now clear that a single-server monolith cannot handle the surge of hundreds of hungry engineers. The university administration has called for a complete architectural overhaul. Your mission is to break this fragile monolith into a **distributed, fault-tolerant microservice system**; one where a failure in the Notification Service won’t leave a student’s Iftar stuck in digital limbo, and the system can survive the Ramadan rush reliably.

---

## 2. System Architecture

You are required to build and containerize the following services. Each must be isolated in its own environment and communicate over the network.

| Service           | Core Responsibility            | Key Functionality                                                                                                                                               |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity Provider | Authentication & Authorization | Single source of truth for student verification; issues secure JWT tokens.                                                                                      |
| Order Gateway     | Primary Entry Point            | API Gateway that performs mandatory Token Validation and a high-speed cache stock check before hitting the database.                                            |
| Stock Service     | Inventory Management           | Source of truth for inventory. Must use robust concurrency control (e.g., Optimistic Locking) to ensure transactional stock decrement and prevent over-selling. |
| Kitchen Queue     | Asynchronous Order Processing  | Immediately acknowledges successful orders (<2s). Decouples user feedback from the 3–7s cooking/preparation process.                                            |
| Notification Hub  | Real-Time Communication        | Pushes instantaneous order status updates (Confirmed, Ready) to student UI, eliminating client polling.                                                         |

> **Note:** Judges must be able to run the whole system using a single  
> `docker compose up` command.

---

## 3. Core Engineering Requirements

### A. Security & Authentication

- **Token Handshake:** Client must authenticate with Identity Provider to receive a secure token.
- **Protected Routes:** Order Gateway must reject any request missing a valid bearer token with `401 Unauthorized`.

### B. Resilience & Fault Tolerance

- **Idempotency Check:** Design for partial failures where stock may be deducted but response fails.
- **Asynchronous Processing:** Kitchen Service must decouple acknowledgment from execution.

### C. Performance & Caching

- **Efficient Caching:** Implement a caching layer in front of Stock Service.
  - If cache reports zero stock, Gateway must reject instantly to protect DB.

### D. Automated Validation (CI/CD)

- **Integrity Testing:** Unit tests for Order Validation and Stock Deduction logic.
- **Automated Pipeline:** Every push to `main` runs tests. Build must fail on test failure.

---

## 4. Observability & Monitoring

Every service must expose:

- **Health Endpoints**
  - `200 OK` if service + dependencies are reachable
  - `503 Service Unavailable` if a dependency is down

- **Metrics Endpoints**
  - Total orders processed
  - Failure counts (500-errors/timeouts)
  - Average response latency

---

## 5. Interface Requirements

### Student Journey UI (SPA)

1. **Authentication:** Secure login to obtain token
2. **Order Placement:** Authenticated trigger for Iftar flow
3. **Live Status:** Real-time tracker
   - Pending → Stock Verified → In Kitchen → Ready

### Admin Monitoring Dashboard

- **Health Grid:** Green/Red indicators per microservice
- **Live Metrics:** Real-time latency & throughput
- **Chaos Toggle:** Kill a service to observe system behavior under partial failure

---

## 6. Bonus Challenges

- **Cloud Frontier:** Deploy entire containerized ecosystem to a cloud provider
- **Visual Alerts:** Trigger visual alert if Gateway avg latency > 1s over 30s
- **Rate Limiting:** Identity Provider must limit to 3 login attempts/min per Student ID

---
