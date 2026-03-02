import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { io, Socket } from "socket.io-client";
import "./index.css";

const API_GATEWAY_URL =
  import.meta.env.VITE_API_GATEWAY_URL || "http://localhost:8080/api";
// WebSocket connects through nginx (same origin) which reverse-proxies to notification-hub
// nginx handles the HTTP 101 WebSocket upgrade natively — true WebSocket, not polling
const WS_URL = window.location.origin;

interface MenuItem {
  id: string;
  name: string;
  stock: number;
  price: number;
}

interface OrderStatus {
  orderId: string;
  status: string;
  timestamp: string;
  itemName?: string;
  quantity?: number;
}

function App() {
  // View: 'login' | 'dashboard' | 'metrics' | 'admin'
  const [view, setView] = useState<string>("login");
  const [token, setToken] = useState<string | null>(
    localStorage.getItem("eziftar_token"),
  );
  const [user, setUser] = useState<any>(null);

  // Login/Register State
  const [loginStudentId, setLoginStudentId] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [registerName, setRegisterName] = useState("");
  const [registerStudentId, setRegisterStudentId] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);

  // Dashboard State
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<string>("");
  const [quantity, setQuantity] = useState<number>(1);
  const [logs, setLogs] = useState<string[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [avgLatency, setAvgLatency] = useState<number>(0);
  const [orderStatuses, setOrderStatuses] = useState<OrderStatus[]>([]);
  const [orderHistory, setOrderHistory] = useState<any[]>([]);

  // Health State
  const [health, setHealth] = useState<Record<string, string>>({
    gateway: "CHECKING",
    identity: "CHECKING",
    stock: "CHECKING",
    kitchen: "CHECKING",
    notification: "CHECKING",
  });

  // WebSocket
  const [socket, setSocket] = useState<Socket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const addLog = (msg: string) =>
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

  // ============================================
  // AUTH
  // ============================================
  const handleLogin = async () => {
    setAuthError("");
    try {
      const res = await axios.post(`${API_GATEWAY_URL}/auth/login`, {
        studentId: loginStudentId,
        password: loginPassword,
      });
      const { token: jwt, student: userData } = res.data;
      localStorage.setItem("eziftar_token", jwt);
      setToken(jwt);
      setUser(userData);
      setView("dashboard");
    } catch (error: any) {
      setAuthError(error.response?.data?.error || "Login failed");
    }
  };

  const handleRegister = async () => {
    setAuthError("");
    try {
      const res = await axios.post(`${API_GATEWAY_URL}/auth/register`, {
        studentId: registerStudentId,
        name: registerName,
        password: registerPassword,
      });
      const { token: jwt, student: userData } = res.data;
      localStorage.setItem("eziftar_token", jwt);
      setToken(jwt);
      setUser(userData);
      setView("dashboard");
      addLog("Registration successful! Logged in automatically.");
    } catch (error: any) {
      setAuthError(error.response?.data?.error || "Registration failed");
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("eziftar_token");
    setToken(null);
    setUser(null);
    setView("login");
    socket?.disconnect();
  };

  // Token check on mount
  useEffect(() => {
    if (token) {
      setView("dashboard");
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        setUser(payload);
      } catch {
        handleLogout();
      }
    }
  }, []);

  // ============================================
  // WebSocket Connection
  // ============================================
  useEffect(() => {
    if (!token || !user) return;

    let destroyed = false; // cleanup flag — prevents reconnect after unmount
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = (delayMs: number) => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (!destroyed && !newSocket.connected) {
          addLog("🔄 Attempting reconnection...");
          newSocket.connect();
        }
      }, delayMs);
    };

    const newSocket = io(WS_URL, {
      transports: ["websocket"],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });
    setSocket(newSocket);

    newSocket.on("connect", () => {
      console.log("WebSocket connected");
      // Clear any pending retry — we're connected now
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      newSocket.emit("join", user.studentId);
      setWsConnected(true);
      addLog("🟢 WebSocket connected — real-time updates active");
    });

    newSocket.on("disconnect", (reason) => {
      console.warn("WebSocket disconnected:", reason);
      setWsConnected(false);
      addLog(`🔴 WebSocket disconnected (${reason}) — switching to polling`);
      // Immediately re-check health so the UI reflects the change right away
      checkHealth();

      // "io server disconnect" means the server called socket.disconnect() or
      // disconnectSockets() — Socket.IO will NOT auto-reconnect in this case.
      // We must manually reconnect so that admin restore works.
      if (reason === "io server disconnect") {
        scheduleReconnect(3000);
      }
    });

    // Socket.IO auto-reconnects transport failures (server crash, network loss)
    // but does NOT retry after namespace middleware rejections (chaos mode).
    // We must retry manually so the client reconnects once the hub is restored.
    newSocket.on("connect_error", (err) => {
      console.warn("WebSocket connect_error:", err.message);
      setWsConnected(false);
      scheduleReconnect(3000);
    });

    newSocket.on("orderStatus", (data: OrderStatus) => {
      addLog(
        `📡 Real-time: Order ${data.orderId.substring(0, 12)}... → ${data.status}`,
      );
      setOrderStatuses((prev) => {
        const existing = prev.findIndex((o) => o.orderId === data.orderId);
        if (existing >= 0) {
          const updated = [...prev];
          // Preserve item info from the original entry
          updated[existing] = { ...data, itemName: updated[existing].itemName || data.itemName, quantity: updated[existing].quantity || data.quantity };
          return updated;
        }
        return [data, ...prev];
      });
    });

    // Listen for real-time stock & health updates from WebSocket
    newSocket.on("stockUpdate", (data: any) => {
      if (Array.isArray(data)) {
        setItems(data);
      }
    });

    newSocket.on("healthUpdate", (data: Record<string, string>) => {
      setHealth((prev) => ({ ...prev, ...data }));
    });

    // Real-time stats updates from gateway (avg latency, request count)
    newSocket.on("statsUpdate", (data: any) => {
      if (data.averageLatencyMs !== undefined) {
        setAvgLatency(data.averageLatencyMs / 1000);
      }
    });

    // Real-time circuit breaker state changes
    newSocket.on("circuitBreakerUpdate", (data: any) => {
      if (data.state) {
        addLog(`⚡ Circuit Breaker → ${data.state}`);
      }
    });

    // Broadcast order updates refresh order history automatically
    newSocket.on("orderUpdate", () => {
      fetchOrders();
    });

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      newSocket.disconnect();
    };
  }, [token, user]);

  // ============================================
  // Data Fetching
  // ============================================
  const authHeaders = { headers: { Authorization: `Bearer ${token}` } };

  const checkHealth = useCallback(async () => {
    const services = [
      "gateway",
      "identity",
      "stock",
      "kitchen",
      "notification",
    ];
    await Promise.all(
      services.map(async (svc) => {
        try {
          await axios.get(`${API_GATEWAY_URL}/health/${svc}`, { timeout: 3000 });
          setHealth((prev) => ({ ...prev, [svc]: "UP" }));
        } catch {
          setHealth((prev) => ({ ...prev, [svc]: "DOWN" }));
        }
      }),
    );
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await axios.get(`${API_GATEWAY_URL}/stats/gateway`);
      setAvgLatency(res.data.averageLatencyMs / 1000);
    } catch {
      console.error("Stats fetch failed");
    }
  }, []);

  const fetchItems = useCallback(
    async (initializeSelection = false) => {
      try {
        const res = await axios.get(`${API_GATEWAY_URL}/stock/items`);
        setItems(res.data);
        if (initializeSelection && res.data.length > 0 && !selectedItem) {
          setSelectedItem(res.data[0].id);
        }
      } catch (e) {
        addLog(`⚠️ Failed to fetch items: ${e}`);
      }
    },
    [selectedItem],
  );

  const fetchOrders = useCallback(async () => {
    if (!token) return;
    try {
      const res = await axios.get(`${API_GATEWAY_URL}/orders`, authHeaders);
      setOrderHistory(res.data);
    } catch {
      console.error("Failed to fetch order history");
    }
  }, [token]);

  // Reconcile live orderStatuses from orderHistory (DB ground truth)
  // If a WebSocket event was lost (e.g. notification-hub was down), this catches up
  useEffect(() => {
    if (orderHistory.length === 0) return;
    const statusOrder = [
      "PENDING",
      "STOCK_VERIFIED",
      "IN_KITCHEN",
      "READY",
      "FAILED",
    ];

    // Compare orderStatuses (live WS state) against orderHistory (DB ground truth)
    // and recover any missed status transitions.
    // NOTE: We compute the diff OUTSIDE setState to avoid React 18 async batching
    // issues — the updater function runs later, so any data collected inside it
    // would not be available synchronously after the setState call.
    setOrderStatuses((prev) => {
      let updated = [...prev];
      let changed = false;
      const recoveredLogs: string[] = [];

      for (const order of orderHistory) {
        const idx = updated.findIndex((o) => o.orderId === order.orderId);
        if (idx >= 0) {
          const currentLevel = statusOrder.indexOf(updated[idx].status);
          const historyLevel = statusOrder.indexOf(order.status);
          if (historyLevel > currentLevel) {
            // Find item name from current items list
            const matchedItem = items.find((it: MenuItem) => it.id === order.itemId);
            updated[idx] = {
              orderId: order.orderId,
              status: order.status,
              timestamp: order.updatedAt || order.createdAt,
              itemName: updated[idx].itemName || matchedItem?.name || order.itemId,
              quantity: updated[idx].quantity || order.quantity,
            };
            changed = true;
            recoveredLogs.push(
              `🔄 Recovered: Order ${order.orderId.substring(0, 12)}... → ${order.status} (from DB)`,
            );
          }
        }
      }

      // Log inside the updater — this runs during React's render phase
      // so we use queueMicrotask to defer the addLog calls safely
      if (recoveredLogs.length > 0) {
        queueMicrotask(() => {
          for (const msg of recoveredLogs) {
            addLog(msg);
          }
        });
      }

      return changed ? updated : prev;
    });
  }, [orderHistory]);

  // Initial data fetch on view change
  useEffect(() => {
    if (view === "login") return;
    const init = async () => {
      await checkHealth();
      await fetchItems(true);
      fetchStats();
      fetchOrders();
    };
    init();
  }, [view]);

  // Polling: full recovery mode when WebSocket is disconnected (5s)
  // When connected, all updates arrive via WebSocket — no polling needed
  useEffect(() => {
    if (view === "login" || wsConnected) return;

    const recoveryInterval = setInterval(() => {
      checkHealth();
      fetchItems(false);
      fetchStats();
      fetchOrders();
    }, 5000);

    return () => {
      clearInterval(recoveryInterval);
    };
  }, [view, wsConnected]);

  // Order reconciliation: always poll orders from DB as a safety net
  // Catches missed WebSocket events (e.g. notification-hub was briefly down)
  useEffect(() => {
    if (view === "login" || !token) return;
    // Skip if already polling everything above (WS disconnected)
    if (!wsConnected) return;

    const reconcileInterval = setInterval(() => {
      fetchOrders();
    }, 10000);

    return () => {
      clearInterval(reconcileInterval);
    };
  }, [view, token, wsConnected, fetchOrders]);

  // ============================================
  // Order Placement
  // ============================================
  const placeOrder = async () => {
    if (!selectedItem || !token) return;
    setLoading(true);
    const start = performance.now();
    addLog(`🍽️ Placing order...`);

    try {
      const res = await axios.post(
        `${API_GATEWAY_URL}/orders`,
        {
          itemId: selectedItem,
          quantity,
        },
        authHeaders,
      );

      const dur = Math.round(performance.now() - start);
      setLatency(dur);
      addLog(
        `✅ Order Accepted! Duration: ${dur}ms | Status: ${res.data.status}`,
      );

      // Find the item name from the items list
      const orderedItem = items.find((it) => it.id === selectedItem);
      setOrderStatuses((prev) => {
        const existing = prev.findIndex((o) => o.orderId === res.data.orderId);
        const entry: OrderStatus = {
          orderId: res.data.orderId,
          status: res.data.status,
          timestamp: new Date().toISOString(),
          itemName: orderedItem?.name || selectedItem,
          quantity,
        };
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = { ...entry, itemName: updated[existing].itemName || entry.itemName, quantity: updated[existing].quantity || entry.quantity };
          return updated;
        }
        return [entry, ...prev];
      });

      fetchItems();
      fetchOrders();
    } catch (error: any) {
      const dur = Math.round(performance.now() - start);
      setLatency(dur);
      addLog(`❌ Failed: ${error.response?.data?.error || error.message}`);

      // Mark any PENDING order that arrived via WebSocket (fire-and-forget notify)
      // as FAILED so the Live Order Status doesn't misleadingly show PENDING
      setOrderStatuses((prev) => {
        // Find the most recent PENDING entry — the gateway emitted it before
        // the stock call failed, so it's sitting in the list looking misleading
        const idx = prev.findIndex((o) => o.status === "PENDING");
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], status: "FAILED" };
          return updated;
        }
        return prev;
      });
    } finally {
      setLoading(false);
    }
  };

  // ============================================
  // Chaos Toggle
  // ============================================
  const triggerChaos = async (service: string) => {
    addLog(`💀 Triggering chaos on ${service}...`);
    try {
      await axios.post(
        `${API_GATEWAY_URL}/admin/chaos/${service}`,
        {},
        authHeaders,
      );
      addLog(`💀 Chaos triggered on ${service} — service killed`);
      setTimeout(checkHealth, 2000);
    } catch (error: any) {
      addLog(`💀 Chaos signal sent to ${service} (may already be down)`);
      setTimeout(checkHealth, 2000);
    }
  };

  const restartService = async (service: string) => {
    addLog(`🔄 Restarting ${service}...`);
    try {
      await axios.post(
        `${API_GATEWAY_URL}/admin/restart/${service}`,
        {},
        authHeaders,
      );
      addLog(`✅ Restart signal sent to ${service}`);
      setTimeout(checkHealth, 5000);
    } catch (error: any) {
      addLog(
        `⚠️ Restart failed for ${service}: ${error.response?.data?.error || error.message}`,
      );
    }
  };

  // ============================================
  // Status Badge Color
  // ============================================
  const getStatusColor = (status: string) => {
    switch (status) {
      case "PENDING":
        return "#a1a1aa";
      case "STOCK_VERIFIED":
        return "#3b82f6";
      case "IN_KITCHEN":
        return "#eab308";
      case "READY":
        return "#22c55e";
      case "FAILED":
        return "#ef4444";
      default:
        return "#a1a1aa";
    }
  };

  // ============================================
  // RENDER
  // ============================================

  // LOGIN VIEW
  if (view === "login") {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1>🌙 EzIftar</h1>
          <p className="subtitle">IUT Cafeteria Ordering System</p>

          {!isRegistering ? (
            <>
              <h2>Login</h2>
              <input
                type="text"
                placeholder="Student ID"
                value={loginStudentId}
                onChange={(e) => setLoginStudentId(e.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
              />
              {authError && <div className="error-msg">{authError}</div>}
              <button className="btn-primary" onClick={handleLogin}>
                Login
              </button>
              <p className="switch-auth" onClick={() => setIsRegistering(true)}>
                Don't have an account? Register
              </p>
            </>
          ) : (
            <>
              <h2>Register</h2>
              <input
                type="text"
                placeholder="Full Name"
                value={registerName}
                onChange={(e) => setRegisterName(e.target.value)}
              />
              <input
                type="text"
                placeholder="Student ID"
                value={registerStudentId}
                onChange={(e) => setRegisterStudentId(e.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                value={registerPassword}
                onChange={(e) => setRegisterPassword(e.target.value)}
              />
              {authError && <div className="error-msg">{authError}</div>}
              <button className="btn-primary" onClick={handleRegister}>
                Register
              </button>
              <p
                className="switch-auth"
                onClick={() => setIsRegistering(false)}
              >
                Already have an account? Login
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="header">
        <h1>🌙 EzIftar</h1>
        <div className="nav-buttons">
          <button
            className={`nav-btn ${view === "dashboard" ? "active" : ""}`}
            onClick={() => setView("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={`nav-btn ${view === "metrics" ? "active" : ""}`}
            onClick={() => setView("metrics")}
          >
            Metrics
          </button>
          <button
            className={`nav-btn ${view === "orders" ? "active" : ""}`}
            onClick={() => {
              setView("orders");
              fetchOrders();
            }}
          >
            Orders
          </button>
          <button
            className={`nav-btn ${view === "admin" ? "active" : ""}`}
            onClick={() => setView("admin")}
          >
            Admin
          </button>
          <a
            href="http://localhost:3005/dashboards"
            target="_blank"
            rel="noopener noreferrer"
          >
            <button className="nav-btn">Grafana ↗</button>
          </a>
          <button
            className="nav-btn"
            onClick={handleLogout}
            style={{ color: "var(--danger)" }}
          >
            Logout
          </button>
        </div>
      </div>

      {/* DASHBOARD VIEW */}
      {view === "dashboard" && (
        <>
          <div className="stats-grid">
            {Object.entries(health).map(([svc, status]) => (
              <div className="stat-card" key={svc}>
                <span className="stat-label">
                  {svc.charAt(0).toUpperCase() + svc.slice(1)} Service
                </span>
                <div className="status-indicator">
                  <span
                    className={`dot ${status === "UP" ? "green" : "red"}`}
                  ></span>
                  {status}
                </div>
              </div>
            ))}
            <div
              className="stat-card"
              style={{
                borderColor:
                  avgLatency > 1 ? "var(--danger)" : "var(--card-border)",
              }}
            >
              <span className="stat-label">Avg Latency (30s)</span>
              <span
                className="stat-value"
                style={{
                  color: avgLatency > 1 ? "var(--danger)" : "var(--success)",
                }}
              >
                {avgLatency.toFixed(3)}s
              </span>
              {avgLatency > 1 && (
                <span className="alert-badge">⚠️ HIGH LATENCY</span>
              )}
            </div>
          </div>

          <div className="main-card">
            <h2>🍽️ Place Your Iftar Order</h2>
            <div style={{ marginBottom: "2rem" }}>
              <label
                style={{
                  display: "block",
                  marginBottom: "0.8rem",
                  color: "#a1a1aa",
                  fontSize: "0.9rem",
                }}
              >
                Select Iftar Item
              </label>
              <select
                value={selectedItem}
                onChange={(e) => setSelectedItem(e.target.value)}
              >
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} — {item.stock} in stock — ৳{item.price}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: "2rem" }}>
              <label
                style={{
                  display: "block",
                  marginBottom: "0.8rem",
                  color: "#a1a1aa",
                  fontSize: "0.9rem",
                }}
              >
                Quantity
              </label>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  justifyContent: "center",
                }}
              >
                <button
                  className="btn-primary"
                  style={{
                    width: "40px",
                    height: "40px",
                    padding: 0,
                    fontSize: "1.2rem",
                  }}
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  disabled={quantity <= 1}
                >
                  −
                </button>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={quantity}
                  onChange={(e) =>
                    setQuantity(
                      Math.max(1, Math.min(50, parseInt(e.target.value) || 1)),
                    )
                  }
                  style={{
                    width: "60px",
                    textAlign: "center",
                    fontSize: "1.1rem",
                  }}
                />
                <button
                  className="btn-primary"
                  style={{
                    width: "40px",
                    height: "40px",
                    padding: 0,
                    fontSize: "1.2rem",
                  }}
                  onClick={() => setQuantity((q) => Math.min(50, q + 1))}
                >
                  +
                </button>
              </div>
            </div>

            <div className="latency-display">
              <div
                className="latency-value"
                style={{
                  color:
                    latency !== null
                      ? latency > 2000
                        ? "#eab308"
                        : latency > 1000
                          ? "#ef4444"
                          : "#22c55e"
                      : "#2f2f35",
                }}
              >
                {latency !== null ? `${latency}ms` : "---"}
              </div>
              <div className="latency-label">Request Latency</div>
            </div>

            <div
              style={{ display: "flex", justifyContent: "center", gap: "1rem" }}
            >
              <button
                className="btn-primary"
                onClick={placeOrder}
                disabled={loading || !selectedItem}
              >
                🚀 Place Order
              </button>
            </div>
          </div>

          {/* Live Order Status Tracker */}
          {orderStatuses.length > 0 && (
            <div className="main-card">
              <h2>📡 Live Order Status</h2>
              <div className="order-tracker">
                {orderStatuses.map((os, i) => (
                  <div key={i} className="order-status-row">
                    <span style={{ fontSize: "0.95rem", fontWeight: 600, color: "#f4f4f5" }}>
                      {os.itemName || "Order"}
                    </span>
                    {os.quantity && (
                      <span style={{
                        fontSize: "0.7rem",
                        padding: "0.15rem 0.5rem",
                        borderRadius: "10px",
                        background: "rgba(139,92,246,0.2)",
                        color: "#a78bfa",
                        fontWeight: 600,
                      }}>
                        ×{os.quantity}
                      </span>
                    )}
                    <span className="order-id">
                      {os.orderId.substring(0, 16)}...
                    </span>
                    <span
                      className="order-status-badge"
                      style={{ backgroundColor: getStatusColor(os.status) }}
                    >
                      {os.status}
                    </span>
                    <span className="order-time">
                      {new Date(os.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
              <div className="status-flow">
                {(() => {
                  const latestStatus =
                    orderStatuses.length > 0 ? orderStatuses[0].status : "";
                  const steps = [
                    { label: "Pending", key: "PENDING" },
                    { label: "Stock Verified", key: "STOCK_VERIFIED" },
                    { label: "In Kitchen", key: "IN_KITCHEN" },
                    { label: "Ready", key: "READY" },
                  ];
                  const stepOrder = [
                    "PENDING",
                    "STOCK_VERIFIED",
                    "IN_KITCHEN",
                    "READY",
                  ];
                  const currentIdx = stepOrder.indexOf(latestStatus);
                  return steps.map((step, i) => (
                    <span key={step.key}>
                      <span
                        className={`flow-step${i <= currentIdx ? " active" : ""}${i === currentIdx ? " current" : ""}`}
                        style={
                          i <= currentIdx
                            ? {
                                backgroundColor: getStatusColor(step.key),
                                color: "#fff",
                              }
                            : {}
                        }
                      >
                        {step.label}
                      </span>
                      {i < steps.length - 1 && " → "}
                    </span>
                  ));
                })()}
              </div>
            </div>
          )}

          <div className="logs-panel">
            <h3
              style={{
                position: "sticky",
                top: 0,
                background: "#000",
                paddingBottom: "0.5rem",
                borderBottom: "1px solid #333",
              }}
            >
              System Activity
            </h3>
            {logs.map((log, i) => (
              <div key={i} className="log-entry">
                {log}
              </div>
            ))}
          </div>
        </>
      )}

      {/* METRICS VIEW */}
      {view === "metrics" && <MetricsPage />}

      {/* ORDER HISTORY VIEW */}
      {view === "orders" && (
        <div className="admin-page">
          <h2>📋 Order History</h2>
          <div className="main-card">
            {orderHistory.length === 0 ? (
              <p
                style={{
                  color: "#a1a1aa",
                  textAlign: "center",
                  padding: "2rem",
                }}
              >
                No orders placed yet. Go to Dashboard to place your first order!
              </p>
            ) : (
              <div className="order-tracker">
                {orderHistory.map((order: any, i: number) => (
                  <div
                    key={order.id || i}
                    className="order-status-row"
                    style={{
                      padding: "0.75rem",
                      borderBottom: "1px solid #333",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "1rem",
                        flexWrap: "wrap",
                        width: "100%",
                      }}
                    >
                      <span
                        className="order-id"
                        style={{
                          fontFamily: "monospace",
                          fontSize: "0.8rem",
                          color: "#a1a1aa",
                        }}
                      >
                        {order.orderId?.substring(0, 20)}...
                      </span>
                      <span
                        style={{
                          color: "var(--text-primary)",
                          fontWeight: 500,
                        }}
                      >
                        {order.itemId
                          ? items.find((it) => it.id === order.itemId)?.name ||
                            order.itemId.substring(0, 8)
                          : "—"}
                      </span>
                      <span style={{ color: "#a1a1aa", fontSize: "0.85rem" }}>
                        ×{order.quantity || 1}
                      </span>
                      <span
                        className="order-status-badge"
                        style={{
                          backgroundColor: getStatusColor(order.status),
                          marginLeft: "auto",
                        }}
                      >
                        {order.status}
                      </span>
                      <span
                        className="order-time"
                        style={{ fontSize: "0.8rem", color: "#71717a" }}
                      >
                        {order.createdAt
                          ? new Date(order.createdAt).toLocaleString()
                          : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="main-card" style={{ marginTop: "1.5rem" }}>
            <h3 style={{ marginBottom: "1rem" }}>📊 Order Summary</h3>
            <div className="stats-grid">
              <div className="stat-card">
                <span className="stat-label">Total Orders</span>
                <span className="stat-value">{orderHistory.length}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Ready</span>
                <span
                  className="stat-value"
                  style={{ color: "var(--success)" }}
                >
                  {orderHistory.filter((o: any) => o.status === "READY").length}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">In Kitchen</span>
                <span className="stat-value" style={{ color: "#eab308" }}>
                  {
                    orderHistory.filter((o: any) => o.status === "IN_KITCHEN")
                      .length
                  }
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Failed</span>
                <span className="stat-value" style={{ color: "var(--danger)" }}>
                  {
                    orderHistory.filter((o: any) => o.status === "FAILED")
                      .length
                  }
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ADMIN VIEW */}
      {view === "admin" && (
        <div className="admin-page">
          <h2>🔧 Admin Dashboard</h2>

          <div className="stats-grid">
            {Object.entries(health).map(([svc, status]) => (
              <div className="stat-card" key={svc}>
                <span className="stat-label">
                  {svc.charAt(0).toUpperCase() + svc.slice(1)}
                </span>
                <div className="status-indicator">
                  <span
                    className={`dot ${status === "UP" ? "green" : "red"}`}
                  ></span>
                  {status}
                </div>
              </div>
            ))}
          </div>

          <div className="main-card">
            <h2>💀 Chaos Toggle</h2>
            <p style={{ color: "#a1a1aa", marginBottom: "1rem" }}>
              Kill a service to observe system behavior under partial failure:
            </p>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              {["stock-service", "kitchen-service", "notification-hub"].map(
                (svc) => (
                  <div
                    key={svc}
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        color: "var(--text-primary)",
                        fontSize: "0.95rem",
                      }}
                    >
                      {svc}
                    </span>
                    <button
                      className="btn-danger"
                      style={{ minWidth: "80px" }}
                      onClick={() => triggerChaos(svc)}
                    >
                      💀 Kill
                    </button>
                    <button
                      className="btn-primary"
                      style={{ minWidth: "80px" }}
                      onClick={() => restartService(svc)}
                    >
                      🔄 Start
                    </button>
                  </div>
                ),
              )}
            </div>
          </div>

          <div className="logs-panel">
            <h3
              style={{
                position: "sticky",
                top: 0,
                background: "#000",
                paddingBottom: "0.5rem",
                borderBottom: "1px solid #333",
              }}
            >
              Chaos Log
            </h3>
            {logs.map((log, i) => (
              <div key={i} className="log-entry">
                {log}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ============================================
// METRICS PAGE
// ============================================
const MetricsPage = () => {
  const API_GATEWAY_URL_LOCAL =
    import.meta.env.VITE_API_GATEWAY_URL || "http://localhost:8080/api";
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMetrics = async () => {
      const services = [
        "gateway",
        "identity",
        "stock",
        "kitchen",
        "notification",
      ];
      const results: Record<string, string> = {};
      for (const svc of services) {
        try {
          const res = await axios.get(
            `${API_GATEWAY_URL_LOCAL}/metrics/${svc}`,
            { timeout: 3000 },
          );
          results[svc] = res.data;
        } catch {
          results[svc] = "Metrics unavailable";
        }
      }
      setMetrics(results);
      setLoading(false);
    };
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="metrics-page">
      <h2 style={{ marginBottom: "2rem" }}>Service Health & Metrics</h2>
      {loading && <p style={{ color: "#a1a1aa" }}>Loading metrics...</p>}
      {Object.entries(metrics).map(([svc, rawData]) => (
        <ServiceMetricsViewer
          key={svc}
          name={`${svc.charAt(0).toUpperCase() + svc.slice(1)} Service`}
          rawData={rawData}
        />
      ))}
    </div>
  );
};

const ServiceMetricsViewer = ({
  name,
  rawData,
}: {
  name: string;
  rawData: string;
}) => {
  const [showRaw, setShowRaw] = useState(false);

  // Metric value extractor — handles both labeled and unlabeled metrics.
  // For labeled metrics (e.g. histogram _sum/_count), sums across all label combos.
  const getValue = (key: string) => {
    // Try exact match first (unlabeled: "metric_name 123")
    const exactMatch = rawData.match(new RegExp(`^${key} ([0-9.e+-]+)`, "m"));
    if (exactMatch) return parseFloat(exactMatch[1]);
    // Sum across all labeled instances: "metric_name{...} 123"
    const regex = new RegExp(`^${key}\\{[^}]*\\}\\s+([0-9.e+-]+)`, "gm");
    let total = 0;
    let found = false;
    let match;
    while ((match = regex.exec(rawData)) !== null) {
      total += parseFloat(match[1]);
      found = true;
    }
    return found ? total : 0;
  };

  // Labeled metric extractor e.g. orders_total{status="accepted"} 42
  const getLabeledValue = (metric: string, label: string, value: string) => {
    const regex = new RegExp(
      `${metric}\\{[^}]*${label}="${value}"[^}]*\\}\\s+([0-9.e+-]+)`,
    );
    const match = rawData.match(regex);
    return match ? parseFloat(match[1]) : 0;
  };

  // Process metrics
  const cpu = getValue("process_cpu_user_seconds_total");
  const memory = getValue("process_resident_memory_bytes");
  const heap = getValue("nodejs_heap_size_used_bytes");
  const uptime = getValue("process_uptime_seconds");
  const handles = getValue("nodejs_active_handles");
  const lag = getValue("nodejs_eventloop_lag_seconds");
  const formatBytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

  // Business metrics — per service
  const svcKey = name.toLowerCase();
  const isGateway = svcKey.includes("gateway");
  const isIdentity = svcKey.includes("identity");
  const isStock = svcKey.includes("stock");
  const isKitchen = svcKey.includes("kitchen");
  const isNotification = svcKey.includes("notification");

  // Avg latency from histogram (sum/count)
  const httpSum = getValue("http_request_duration_seconds_sum");
  const httpCount = getValue("http_request_duration_seconds_count");
  const avgLatencyMs =
    httpCount > 0 ? ((httpSum / httpCount) * 1000).toFixed(1) : "0.0";

  // Build business metric cards
  const businessMetrics: {
    label: string;
    value: string;
    color: string;
  }[] = [];

  if (isGateway) {
    businessMetrics.push({
      label: "Orders Accepted",
      value: getLabeledValue("orders_total", "status", "accepted").toString(),
      color: "var(--success)",
    });
    businessMetrics.push({
      label: "Orders Failed",
      value: getValue("orders_failed_total").toString(),
      color: "var(--danger)",
    });
    const cbState = getValue("circuit_breaker_state");
    const cbLabel =
      cbState === 0 ? "CLOSED" : cbState === 1 ? "HALF_OPEN" : "OPEN";
    businessMetrics.push({
      label: "Circuit Breaker",
      value: cbLabel,
      color:
        cbState === 0
          ? "var(--success)"
          : cbState === 1
            ? "#eab308"
            : "var(--danger)",
    });
    businessMetrics.push({
      label: "Cache Hits",
      value: getValue("cache_hits_total").toString(),
      color: "var(--success)",
    });
    businessMetrics.push({
      label: "Cache Misses",
      value: getValue("cache_misses_total").toString(),
      color: "#eab308",
    });
  }
  if (isIdentity) {
    businessMetrics.push({
      label: "Login Success",
      value: getLabeledValue(
        "login_attempts_total",
        "status",
        "success",
      ).toString(),
      color: "var(--success)",
    });
    businessMetrics.push({
      label: "Login Failed",
      value: getLabeledValue(
        "login_attempts_total",
        "status",
        "failed",
      ).toString(),
      color: "var(--danger)",
    });
  }
  if (isStock) {
    businessMetrics.push({
      label: "Deductions OK",
      value: getLabeledValue(
        "stock_deductions_total",
        "status",
        "success",
      ).toString(),
      color: "var(--success)",
    });
    businessMetrics.push({
      label: "Deductions Failed",
      value: getLabeledValue(
        "stock_deductions_total",
        "status",
        "failed",
      ).toString(),
      color: "var(--danger)",
    });
  }
  if (isKitchen) {
    businessMetrics.push({
      label: "Orders Completed",
      value: getLabeledValue(
        "kitchen_orders_processed_total",
        "status",
        "completed",
      ).toString(),
      color: "var(--success)",
    });
    businessMetrics.push({
      label: "Orders Failed",
      value: getLabeledValue(
        "kitchen_orders_processed_total",
        "status",
        "failed",
      ).toString(),
      color: "var(--danger)",
    });
  }
  if (isNotification) {
    businessMetrics.push({
      label: "Notifications Sent",
      value: getValue("notifications_sent_total").toString(),
      color: "var(--accent)",
    });
    businessMetrics.push({
      label: "WS Clients",
      value: getValue("websocket_connected_clients").toString(),
      color: "var(--primary)",
    });
  }

  // Always add avg latency & throughput
  businessMetrics.push({
    label: "Avg Latency",
    value: `${avgLatencyMs}ms`,
    color: parseFloat(avgLatencyMs) > 1000 ? "var(--danger)" : "var(--success)",
  });
  businessMetrics.push({
    label: "Total Requests",
    value: Math.round(httpCount).toString(),
    color: "var(--text-primary)",
  });

  return (
    <div className="metrics-section">
      <div className="metrics-header">
        <h3
          style={{
            fontSize: "1.25rem",
            color: "var(--text-primary)",
            margin: 0,
          }}
        >
          {name}
        </h3>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <span className="dot green"></span>
          <span
            style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}
          >
            UP {Math.floor(uptime / 60)}m
          </span>
        </div>
      </div>

      {/* Business Metrics */}
      <h4
        style={{
          fontSize: "0.8rem",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--primary)",
          marginBottom: "1rem",
          fontWeight: 600,
        }}
      >
        Business Metrics
      </h4>
      <div className="key-metrics-grid" style={{ marginBottom: "2rem" }}>
        {businessMetrics.map((m, i) => (
          <div
            className="metric-item"
            key={i}
            style={{ borderLeft: `3px solid ${m.color}` }}
          >
            <span className="label">{m.label}</span>
            <div className="value" style={{ color: m.color }}>
              {m.value}
            </div>
          </div>
        ))}
      </div>

      {/* Process Metrics */}
      <h4
        style={{
          fontSize: "0.8rem",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-secondary)",
          marginBottom: "1rem",
          fontWeight: 600,
        }}
      >
        Process Metrics
      </h4>
      <div className="key-metrics-grid">
        <div className="metric-item">
          <span className="label">Memory (RSS)</span>
          <div className="value">
            {formatBytes(memory)}
            <span className="unit">MB</span>
          </div>
        </div>
        <div className="metric-item">
          <span className="label">Heap Used</span>
          <div className="value">
            {formatBytes(heap)}
            <span className="unit">MB</span>
          </div>
        </div>
        <div className="metric-item">
          <span className="label">CPU Used</span>
          <div className="value">
            {cpu.toFixed(2)}
            <span className="unit">s</span>
          </div>
        </div>
        <div className="metric-item">
          <span className="label">Active Handles</span>
          <div className="value">{handles}</div>
        </div>
        <div className="metric-item">
          <span className="label">Event Loop Lag</span>
          <div className="value">
            {lag.toFixed(4)}
            <span className="unit">s</span>
          </div>
        </div>
      </div>

      <button className="raw-toggle" onClick={() => setShowRaw(!showRaw)}>
        {showRaw ? "Hide Raw Data" : "View Raw Prometheus Data"}
      </button>

      {showRaw && <div className="metric-box">{rawData}</div>}
    </div>
  );
};

export default App;
