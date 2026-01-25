const el = (id) => document.getElementById(id);

const state = {
  unit: "F",        // default Fahrenheit
  range: "3h",      // default last 3 hours
  stationId: null,  // you can add a UI later if needed
  latest: null,
  rangeRows: []
};

function cToF(c) { return (c * 9/5) + 32; }

function fmtTemp(t_c) {
  if (t_c === null || t_c === undefined || Number.isNaN(Number(t_c))) return "—";
  const c = Number(t_c);
  const v = state.unit === "F" ? cToF(c) : c;
  return `${v.toFixed(1)}°${state.unit}`;
}

function fmtRH(rh) {
  if (rh === null || rh === undefined || Number.isNaN(Number(rh))) return "—";
  return `${Number(rh).toFixed(1)}%`;
}

function paToInHg(pa) {
  return pa * 0.0002953;
}

function fmtPa(pa) {
  if (pa === null || pa === undefined || Number.isNaN(Number(pa))) return "—";
  const inHg = paToInHg(Number(pa));
  return `${inHg.toFixed(2)} inHg`;
}

function fmtRssi(rssi) {
  if (rssi === null || rssi === undefined || Number.isNaN(Number(rssi))) return "—";
  return `${Number(rssi)} dBm`;
}

function fmtTime(ms) {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  return d.toLocaleString();
}

function computeTrend(rows, field) {
  const vals = (rows || [])
    .map(r => Number(r[field]))
    .filter(v => Number.isFinite(v));

  if (vals.length < 2) return null;

  const first = vals[0];
  const last = vals[vals.length - 1];
  const delta = last - first;

  return { first, last, delta };
}

function fmtDeltaSigned(x, digits = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "";
  const s = v > 0 ? "+" : "";
  return `${s}${v.toFixed(digits)}`;
}

function relTime(ms) {
  if (!ms) return "—";
  const diff = Date.now() - Number(ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function rangeToMs(range) {
  const now = Date.now();
  const map = {
    "1h": 1 * 3600e3,
    "3h": 3 * 3600e3,
    "6h": 6 * 3600e3,
    "12h": 12 * 3600e3,
    "24h": 24 * 3600e3,
    "7d": 7 * 24 * 3600e3
  };
  return { from_ms: now - (map[range] || map["3h"]), to_ms: now };
}

function setError(msg) {
  const box = el("errorBox");
  if (!msg) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.textContent = msg;
  box.classList.remove("hidden");
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000); // iOS-friendly timeout
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function updateLatestUI() {
  const l = state.latest;
  if (!l) return;

  el("subtitle").textContent = `${l.station_id || "—"} • ${relTime(l.ts_ms)} • ${fmtTime(l.ts_ms)}`;
  el("latestTime").textContent = `Event: ${fmtTime(l.ts_ms)} • Recv: ${fmtTime(l.ts_recv_ms)}`;
  el("tempValue").textContent = fmtTemp(l.metrics?.t_c);
  el("rhValue").textContent = fmtRH(l.metrics?.rh);
  el("pslpValue").textContent = fmtPa(l.metrics?.p_slp_pa);
  el("rssiValue").textContent = fmtRssi(l.metrics?.rssi_dbm);
}

function updatePressureTrend() {
  const out = el("pslpTrend");
  if (!out) return;

  const rows = state.rangeRows || [];
  const t = computeTrend(rows, "p_slp_pa");
  if (!t) {
    out.textContent = "—";
    return;
  }

  const deltaInHg = paToInHg(t.delta);

  // Threshold to avoid noise-driven arrow flipping
  let arrow = "→";
  if (deltaInHg > 0.01) arrow = "↑";
  else if (deltaInHg < -0.01) arrow = "↓";

  out.textContent = `${arrow} ${fmtDeltaSigned(deltaInHg, 2)} inHg over ${state.range}`;
}

function updateTable() {
  const tbody = el("rows");
  tbody.innerHTML = "";

  const rows = state.rangeRows || [];
  // show newest first in the table (more useful on mobile)
  const last = [...rows].reverse().slice(0, 50);

  for (const r of last) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtTime(r.ts_ms)}</td>
      <td>${fmtTemp(r.t_c)}</td>
      <td>${fmtRH(r.rh)}</td>
      <td>${fmtPa(r.p_slp_pa)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function drawSparkline() {
  const canvas = el("spark");
  const ctx = canvas.getContext("2d");
  const rows = state.rangeRows || [];

  // Clear
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (rows.length < 2) {
    // basic placeholder line
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(12, canvas.height / 2);
    ctx.lineTo(canvas.width - 12, canvas.height / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  // Use t_c
  const valuesC = rows.map(r => Number(r.t_c)).filter(v => Number.isFinite(v));
  if (valuesC.length < 2) return;

  const values = valuesC.map(v => state.unit === "F" ? cToF(v) : v);

  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }

  const padX = 12, padY = 14;
  const W = canvas.width - padX * 2;
  const H = canvas.height - padY * 2;

  // Grid baseline
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(padX, padY + H);
  ctx.lineTo(padX + W, padY + H);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Bright gradient fill
  const grad = ctx.createLinearGradient(0, padY, 0, padY + H);
  grad.addColorStop(0, "rgba(0, 200, 255, 0.6)");
  grad.addColorStop(1, "rgba(0, 200, 255, 0.05)");

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = padX + (i / (values.length - 1)) * W;
    const y = padY + (1 - (v - min) / (max - min)) * H;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

 // Close shape to bottom for fill
  ctx.lineTo(padX + W, padY + H);
  ctx.lineTo(padX, padY + H);
  ctx.closePath();

  ctx.fillStyle = grad;
  ctx.fill();

  // Bright outline
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = padX + (i / (values.length - 1)) * W;
    const y = padY + (1 - (v - min) / (max - min)) * H;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.strokeStyle = "#00d4ff";
  ctx.lineWidth = 2.5;
  ctx.stroke();


  // Labels (min/max)
  ctx.globalAlpha = 0.7;
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(`${max.toFixed(1)}°${state.unit}`, padX, 12);
  ctx.fillText(`${min.toFixed(1)}°${state.unit}`, padX, canvas.height - 6);
  ctx.globalAlpha = 1;
}

function updateCsvLink() {
  const { from_ms, to_ms } = rangeToMs(state.range);
  const params = new URLSearchParams({
    from_ms: String(from_ms),
    to_ms: String(to_ms),
    limit: "50000"
  });
  if (state.stationId) params.set("station_id", state.stationId);

  el("csvLink").href = `/api/weather.csv?${params.toString()}`;
}

function setRange(range) {
  state.range = range;
  el("rangeLabel").textContent = `Last ${range}`;
  document.querySelectorAll(".chip").forEach(b => {
    b.classList.toggle("is-active", b.dataset.range === range);
  });
  updateCsvLink();
  refreshRange();
}

async function refreshLatest() {
  setError("");
  const params = new URLSearchParams();
  if (state.stationId) params.set("station_id", state.stationId);

  try {
    const data = await fetchJson(`/api/weather/latest?${params.toString()}`);
    state.latest = data;
    updateLatestUI();
  } catch (e) {
    setError(`Latest failed: ${e.message}`);
  }
}

async function refreshRange() {
  setError("");
  const { from_ms, to_ms } = rangeToMs(state.range);
  const params = new URLSearchParams({
    from_ms: String(from_ms),
    to_ms: String(to_ms),
    limit: "50000"
  });
  if (state.stationId) params.set("station_id", state.stationId);

  try {
    const data = await fetchJson(`/api/weather/range?${params.toString()}`);
    state.rangeRows = data.rows || [];
    updateTable();
    drawSparkline();
    updatePressureTrend();
  } catch (e) {
    setError(`Range failed: ${e.message}`);
  }
}

function setUnit(unit) {
  state.unit = unit;
  el("unitF").classList.toggle("is-active", unit === "F");
  el("unitC").classList.toggle("is-active", unit === "C");

  // Redraw with new unit
  updateLatestUI();
  updateTable();
  drawSparkline();
}

function wireUI() {
  el("refreshBtn").addEventListener("click", async () => {
    await refreshLatest();
    await refreshRange();
  });

  el("unitF").addEventListener("click", () => setUnit("F"));
  el("unitC").addEventListener("click", () => setUnit("C"));

  document.querySelectorAll(".chip").forEach(btn => {
    btn.addEventListener("click", () => setRange(btn.dataset.range));
  });

  // Default state
  setUnit("F");
  setRange("3h");
}

(async function init() {
  wireUI();
  updateCsvLink();

  // Initial load
  await refreshLatest();
  await refreshRange();

  // Gentle polling for “latest” (internal LAN, iOS-friendly)
  setInterval(refreshLatest, 15000);
})();

