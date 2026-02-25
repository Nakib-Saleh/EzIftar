import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { io, Socket } from "socket.io-client";
import "./index.css";

const API_GATEWAY_URL =
  import.meta.env.VITE_API_GATEWAY_URL || "http://localhost:8080/api";
const NOTIFICATION_HUB_URL =
  import.meta.env.VITE_NOTIFICATION_HUB_URL || "http://localhost:3004";

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
  const [logs, setLogs] = useState<string[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [avgLatency, setAvgLatency] = useState<number>(0);
  const [orderStatuses, setOrderStatuses] = useState<OrderStatus[]>([]);

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
      const { token: jwt, user: userData } = res.data;
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
      await axios.post(`${API_GATEWAY_URL}/auth/register`, {
        studentId: registerStudentId,
        name: registerName,
        password: registerPassword,
      });
      setAuthError("");
      setIsRegistering(false);
      setLoginStudentId(registerStudentId);
      addLog("Registration successful! Please login.");
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

    const newSocket = io(NOTIFICATION_HUB_URL);
    setSocket(newSocket);

    newSocket.on("connect", () => {
      console.log("WebSocket connected");
      newSocket.emit("join", user.studentId);
    });

    newSocket.on("orderStatus", (data: OrderStatus) => {
      addLog(
        `📡 Real-time: Order ${data.orderId.substring(0, 12)}... → ${data.status}`,
      );
      setOrderStatuses((prev) => {
        const existing = prev.findIndex((o) => o.orderId === data.orderId);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = data;
          return updated;
        }
        return [data, ...prev];
      });
    });

    return () => {
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
    for (const svc of services) {
      try {
        await axios.get(`${API_GATEWAY_URL}/health/${svc}`, { timeout: 3000 });
        setHealth((prev) => ({ ...prev, [svc]: "UP" }));
      } catch {
        setHealth((prev) => ({ ...prev, [svc]: "DOWN" }));
      }
    }
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

  // Polling
  useEffect(() => {
    if (view === "login") return;

    const init = async () => {
      await checkHealth();
      await fetchItems(true);
      fetchStats();
    };
    init();

    const interval = setInterval(() => {
      checkHealth();
      fetchItems(false);
      fetchStats();
    }, 5000);

    const statsInterval = setInterval(fetchStats, 2000);

    return () => {
      clearInterval(interval);
      clearInterval(statsInterval);
    };
  }, [view]);

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
          quantity: 1,
        },
        authHeaders,
      );

      const dur = Math.round(performance.now() - start);
      setLatency(dur);
      addLog(
        `✅ Order Accepted! Duration: ${dur}ms | Status: ${res.data.status}`,
      );

      setOrderStatuses((prev) => [
        {
          orderId: res.data.orderId,
          status: res.data.status,
          timestamp: new Date().toISOString(),
        },
        ...prev,
      ]);

      fetchItems();
    } catch (error: any) {
      const dur = Math.round(performance.now() - start);
      setLatency(dur);
      addLog(`❌ Failed: ${error.response?.data?.error || error.message}`);
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
      addLog(`💀 Chaos triggered on ${service}`);
      setTimeout(checkHealth, 2000);
    } catch (error: any) {
      addLog(`💀 Chaos signal sent to ${service} (may already be down)`);
      setTimeout(checkHealth, 2000);
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
                <span className="flow-step">Pending</span> →{" "}
                <span className="flow-step active">Stock Verified</span> →{" "}
                <span className="flow-step">In Kitchen</span> →{" "}
                <span className="flow-step">Ready</span>
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
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              <button
                className="btn-danger"
                onClick={() => triggerChaos("stock-service")}
              >
                Kill Stock Service
              </button>
              <button
                className="btn-danger"
                onClick={() => triggerChaos("kitchen-service")}
              >
                Kill Kitchen Service
              </button>
              <button
                className="btn-danger"
                onClick={() => triggerChaos("notification-hub")}
              >
                Kill Notification Hub
              </button>
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
    const regex = new RegExp(
      `^${key}\\{[^}]*\\}\\s+([0-9.e+-]+)`,
      "gm",
    );
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
    color:
      parseFloat(avgLatencyMs) > 1000 ? "var(--danger)" : "var(--success)",
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
