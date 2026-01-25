/**
 * Weather Dashboard Client
 * ------------------------
 * Responsibilities:
 *  - Fetch and render "latest" station telemetry
 *  - Fetch and render "range" telemetry (table, sparkline, pressure trend)
 *  - Fetch and render "extremes" (min/max temp within selected window)
 *  - Manage UI state (unit, range, station filter)
 *
 * Notes:
 *  - This is written as a single-file module for easy drop-in use.
 */

/** @typedef {"F"|"C"} Unit */
/** @typedef {"1h"|"3h"|"6h"|"12h"|"24h"|"7d"} RangeKey */

/**
 * @typedef {Object} LatestMetrics
 * @property {number=} t_c
 * @property {number=} rh
 * @property {number=} p_slp_pa
 * @property {number=} rssi_dbm
 */

/**
 * @typedef {Object} LatestPayload
 * @property {string=} station_id
 * @property {number=} ts_ms
 * @property {number=} ts_recv_ms
 * @property {LatestMetrics=} metrics
 */

/**
 * @typedef {Object} RangeRow
 * @property {number=} ts_ms
 * @property {number=} t_c
 * @property {number=} rh
 * @property {number=} p_slp_pa
 */

/**
 * @typedef {Object} RangePayload
 * @property {RangeRow[]=} rows
 */

/**
 * @typedef {Object} ExtremesPoint
 * @property {number=} ts_ms
 * @property {number=} t_c
 */

/**
 * @typedef {Object} ExtremesPayload
 * @property {number=} from_ms
 * @property {number=} to_ms
 * @property {string=} station_id
 * @property {ExtremesPoint=} min
 * @property {ExtremesPoint=} max
 */

/**
 * @typedef {Object} DashboardState
 * @property {Unit} unit
 * @property {RangeKey} range
 * @property {string|null} stationId
 * @property {LatestPayload|null} latest
 * @property {RangeRow[]} rangeRows
 * @property {ExtremesPayload|null} extremes
 */

/**
 * @typedef {Object} DashboardEls
 * @property {HTMLElement} errorBox
 * @property {HTMLElement} subtitle
 * @property {HTMLElement} latestTime
 * @property {HTMLElement} tempValue
 * @property {HTMLElement} rhValue
 * @property {HTMLElement} pslpValue
 * @property {HTMLElement} rssiValue
 * @property {HTMLElement} rangeLabel
 * @property {HTMLAnchorElement} csvLink
 * @property {HTMLTableSectionElement} rowsTbody
 * @property {HTMLCanvasElement} spark
 * @property {HTMLButtonElement} backToTop
 * @property {HTMLElement} pslpTrend
 * @property {HTMLButtonElement} refreshBtn
 * @property {HTMLElement} unitF
 * @property {HTMLElement} unitC
 * @property {HTMLElement} dewValue
 * @property {HTMLElement} feelValue
 * @property {HTMLElement} minTempValue
 * @property {HTMLElement} minTempTime
 * @property {HTMLElement} maxTempValue
 * @property {HTMLElement} maxTempTime
 */

const RANGE_MS = /** @type {const} */ ({
  "1h": 1 * 3600e3,
  "3h": 3 * 3600e3,
  "6h": 6 * 3600e3,
  "12h": 12 * 3600e3,
  "24h": 24 * 3600e3,
  "7d": 7 * 24 * 3600e3
});

const DEFAULTS = /** @type {const} */ ({
  unit: /** @type {Unit} */ ("F"),
  range: /** @type {RangeKey} */ ("3h"),
  latestPollMs: 15000,
  requestTimeoutMs: 8000,
  maxTableRows: 50,
  maxRangeLimit: 50000
});

/** @param {string} id */
function getEl(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLCanvasElement}
 */
function getCanvas(id) {
  const node = /** @type {HTMLCanvasElement} */ (getEl(id));
  if (!(node instanceof HTMLCanvasElement)) throw new Error(`#${id} is not a <canvas>`);
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLAnchorElement}
 */
function getAnchor(id) {
  const node = /** @type {HTMLAnchorElement} */ (getEl(id));
  if (!(node instanceof HTMLAnchorElement)) throw new Error(`#${id} is not an <a>`);
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLTableSectionElement}
 */
function getTbody(id) {
  const node = /** @type {HTMLTableSectionElement} */ (getEl(id));
  if (!(node instanceof HTMLTableSectionElement)) throw new Error(`#${id} is not a <tbody>`);
  return node;
}

/**
 * Convert Celsius -> Fahrenheit.
 * @param {number} c
 */
function cToF(c) {
  return (c * 9) / 5 + 32;
}

/**
 * Convert Pascals -> inHg.
 * @param {number} pa
 */
function paToInHg(pa) {
  return pa * 0.0002953;
}

/**
 * Basic finite-number guard.
 * @param {unknown} x
 * @returns {x is number}
 */
function isFiniteNumber(x) {
  return Number.isFinite(Number(x));
}

/**
 * @param {unknown} t_c
 * @param {Unit} unit
 */
function formatTemp(t_c, unit) {
  if (!isFiniteNumber(t_c)) return "—";
  const c = Number(t_c);
  const v = unit === "F" ? cToF(c) : c;
  return `${v.toFixed(1)}°${unit}`;
}

/** @param {unknown} rh */
function formatRh(rh) {
  if (!isFiniteNumber(rh)) return "—";
  return `${Number(rh).toFixed(1)}%`;
}

/** @param {unknown} pa */
function formatPressure(pa) {
  if (!isFiniteNumber(pa)) return "—";
  return `${paToInHg(Number(pa)).toFixed(2)} inHg`;
}

/** @param {unknown} rssi */
function formatRssi(rssi) {
  if (!isFiniteNumber(rssi)) return "—";
  return `${Math.round(Number(rssi))} dBm`;
}

/**
 * @param {number} tsMs
 */
function formatTimeLocal(tsMs) {
  try {
    const d = new Date(tsMs);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "—";
  }
}

/**
 * Simple dewpoint (Magnus) approximation.
 * @param {number} tC
 * @param {number} rhPct
 */
function dewPointC(tC, rhPct) {
  // Guard
  const rh = Math.max(1e-6, Math.min(100, rhPct));
  const a = 17.62;
  const b = 243.12;
  const gamma = (a * tC) / (b + tC) + Math.log(rh / 100);
  return (b * gamma) / (a - gamma);
}

/**
 * Simple "feels like" approximation:
 *  - If cold: wind chill requires wind; we don’t have it, so use actual.
 *  - If warm: use a basic heat-index approximation when RH is present.
 * @param {number} tC
 * @param {number} rhPct
 */
function feelsLikeC(tC, rhPct) {
  // If RH missing, return actual
  if (!isFiniteNumber(rhPct)) return tC;

  // Simple heat-index-like curve for warm temps
  const tF = cToF(tC);
  if (tF < 80) return tC;

  // Rothfusz regression (approx), using F and RH
  const R = Math.max(0, Math.min(100, rhPct));
  const HI =
    -42.379 +
    2.04901523 * tF +
    10.14333127 * R -
    0.22475541 * tF * R -
    0.00683783 * tF * tF -
    0.05481717 * R * R +
    0.00122874 * tF * tF * R +
    0.00085282 * tF * R * R -
    0.00000199 * tF * tF * R * R;

  // Back to C
  return (HI - 32) * (5 / 9);
}

/**
 * fetch wrapper with timeout and JSON parsing
 * @param {string} url
 * @param {number} timeoutMs
 */
async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {signal: ctrl.signal});
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;

    if (!r.ok) {
      const msg = (data && data.error) ? data.error : `${r.status} ${r.statusText}`;
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Draw sparkline in the original style: blue line + blue shaded fill.
 * Matches the old renderSparkline() look:
 *   fill: rgba(0, 200, 255, 0.6) -> rgba(0, 200, 255, 0.05)
 *   stroke: #00d4ff, width 2.5
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} ys
 */
function drawSpark(canvas, ys) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // Old behavior: draw a simple midline if we can't form a curve
  if (!ys || ys.length < 2) {
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(12, h / 2);
    ctx.lineTo(w - 12, h / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  const min = Math.min(...ys);
  const max = Math.max(...ys);

  // Avoid divide-by-zero if flat
  const span = Math.max(1e-9, max - min);

  const padX = 12;
  const padY = 14;
  const x0 = padX;
  const x1 = w - padX;
  const y0 = padY;
  const y1 = h - padY;
  const W = x1 - x0;
  const H = y1 - y0;

  // Baseline (same vibe as old function)
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Precompute points
  const pts = ys.map((v, i) => {
    const t = i / (ys.length - 1);
    const x = x0 + t * W;
    const y = y1 - ((v - min) / span) * H;
    return { x, y };
  });

  // Fill gradient (exact old colors)
  const grad = ctx.createLinearGradient(0, y0, 0, y1);
  grad.addColorStop(0, "rgba(0, 200, 255, 0.6)");
  grad.addColorStop(1, "rgba(0, 200, 255, 0.05)");

  // Area path
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.lineTo(pts[pts.length - 1].x, y1);
  ctx.lineTo(pts[0].x, y1);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Outline (exact old stroke)
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = "#00d4ff";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Optional labels (matches old behavior; harmless if you prefer them)
  ctx.globalAlpha = 0.7;
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(`${max.toFixed(1)}`, x0, 12);
  ctx.fillText(`${min.toFixed(1)}`, x0, h - 6);
  ctx.globalAlpha = 1;
}

/**
 * Set error banner message (and show/hide).
 * @param {DashboardEls} els
 * @param {string|null} msg
 */
function setError(els, msg) {
  if (!msg) {
    els.errorBox.classList.add("hidden");
    els.errorBox.textContent = "";
    return;
  }
  els.errorBox.textContent = msg;
  els.errorBox.classList.remove("hidden");
}

/**
 * Compute range window in ms from now.
 * @param {RangeKey} key
 */
function computeWindow(key) {
  const now = Date.now();
  const dur = RANGE_MS[key] ?? RANGE_MS["3h"];
  return {from_ms: now - dur, to_ms: now};
}

/**
 * Build query params for range/extremes endpoints.
 * @param {DashboardState} state
 * @param {number} fromMs
 * @param {number} toMs
 */
function buildRangeParams(state, fromMs, toMs) {
  const params = new URLSearchParams();
  params.set("from_ms", String(fromMs));
  params.set("to_ms", String(toMs));
  params.set("limit", String(DEFAULTS.maxRangeLimit));
  if (state.stationId) params.set("station_id", state.stationId);
  return params;
}

/**
 * Bind range chip click handlers.
 * @param {DashboardState} state
 * @param {DashboardEls} els
 */
function bindRangeChips(state, els) {
  const chips = Array.from(document.querySelectorAll(".chip"));
  chips.forEach((btn) => {
    btn.addEventListener("click", () => {
      chips.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const key = /** @type {RangeKey} */ (btn.getAttribute("data-range") || "3h");
      state.range = key;
      refreshAll(state, els).catch(() => {});
    });
  });
}

/**
 * Bind unit toggle buttons.
 * @param {DashboardState} state
 * @param {DashboardEls} els
 */
function bindUnitToggle(state, els) {
  function setUnit(u) {
    state.unit = u;
    els.unitF.classList.toggle("is-active", u === "F");
    els.unitC.classList.toggle("is-active", u === "C");
    els.unitF.setAttribute("aria-pressed", String(u === "F"));
    els.unitC.setAttribute("aria-pressed", String(u === "C"));
    renderAll(state, els);
  }

  els.unitF.addEventListener("click", () => setUnit("F"));
  els.unitC.addEventListener("click", () => setUnit("C"));
}

/**
 * Back-to-top button.
 * @param {DashboardEls} els
 */
function bindBackToTop(els) {
  const btn = els.backToTop;
  btn.addEventListener("click", () => window.scrollTo({top: 0, behavior: "smooth"}));

  window.addEventListener("scroll", () => {
    const show = window.scrollY > 600;
    btn.classList.toggle("is-visible", show);
  }, {passive: true});
}

/**
 * Render latest card.
 * @param {DashboardState} state
 * @param {DashboardEls} els
 */
function renderLatest(state, els) {
  const payload = state.latest;
  if (!payload || !payload.metrics) return;

  const m = payload.metrics;
  els.latestTime.textContent = payload.ts_ms ? formatTimeLocal(payload.ts_ms) : "—";
  els.tempValue.textContent = formatTemp(m.t_c, state.unit);
  els.rhValue.textContent = formatRh(m.rh);
  els.pslpValue.textContent = formatPressure(m.p_slp_pa);
  els.rssiValue.textContent = formatRssi(m.rssi_dbm);

  // Dew + feels-like (best-effort)
  if (isFiniteNumber(m.t_c) && isFiniteNumber(m.rh)) {
    const dp = dewPointC(Number(m.t_c), Number(m.rh));
    const fl = feelsLikeC(Number(m.t_c), Number(m.rh));
    els.dewValue.textContent = formatTemp(dp, state.unit);
    els.feelValue.textContent = formatTemp(fl, state.unit);
  } else {
    els.dewValue.textContent = "—";
    els.feelValue.textContent = "—";
  }

  // Subtitle
  const station = payload.station_id || (state.stationId ?? "—");
  const rel = payload.ts_ms && payload.ts_recv_ms ? `${Math.round((payload.ts_recv_ms - payload.ts_ms) / 1000)}s lag` : "—";
  const abs = payload.ts_ms ? new Date(payload.ts_ms).toLocaleString() : "—";
  els.subtitle.textContent = `${station} • ${rel} • ${abs}`;
}

/**
 * Render range table + sparkline + pressure trend.
 * @param {DashboardState} state
 * @param {DashboardEls} els
 */
function renderRange(state, els) {
  const rows = state.rangeRows || [];
  els.rowsTbody.innerHTML = "";

  const limited = rows.slice(-DEFAULTS.maxTableRows);

  for (const r of limited) {
    const tr = document.createElement("tr");

    const tdT = document.createElement("td");
    tdT.textContent = r.ts_ms ? new Date(r.ts_ms).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit"
    }) : "—";

    const tdTemp = document.createElement("td");
    tdTemp.textContent = formatTemp(r.t_c, state.unit);

    const tdRh = document.createElement("td");
    tdRh.textContent = formatRh(r.rh);

    const tdP = document.createElement("td");
    tdP.textContent = formatPressure(r.p_slp_pa);

    tr.appendChild(tdT);
    tr.appendChild(tdTemp);
    tr.appendChild(tdRh);
    tr.appendChild(tdP);
    els.rowsTbody.appendChild(tr);
  }

  // Sparkline from temp
  const temps = rows
    .map((x) => (isFiniteNumber(x.t_c) ? Number(x.t_c) : null))
    .filter((x) => x !== null);

  // Convert to selected unit for visual consistency
  const ys = state.unit === "F" ? temps.map((c) => cToF(c)) : temps;
  drawSpark(els.spark, ys);

  // Pressure trend: compare first and last valid
  const ps = rows.map((x) => (isFiniteNumber(x.p_slp_pa) ? Number(x.p_slp_pa) : null)).filter((x) => x !== null);
  if (ps.length >= 2) {
    const delta = paToInHg(ps[ps.length - 1] - ps[0]);
    const dir = delta > 0.001 ? "Rising" : delta < -0.001 ? "Falling" : "Steady";
    els.pslpTrend.textContent = `${dir} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)} inHg)`;
  } else {
    els.pslpTrend.textContent = "—";
  }
}

/**
 * Render range extremes (min/max temp within selected window).
 * @param {DashboardState} state
 * @param {DashboardEls} els
 */
function renderExtremes(state, els) {
  const ex = state.extremes;

  if (!ex || !ex.min || !ex.max) {
    els.minTempValue.textContent = "—";
    els.minTempTime.textContent = "—";
    els.maxTempValue.textContent = "—";
    els.maxTempTime.textContent = "—";
    return;
  }

  els.minTempValue.textContent = formatTemp(ex.min.t_c, state.unit);
  els.minTempTime.textContent = ex.min.ts_ms ? formatTimeLocal(ex.min.ts_ms) : "—";

  els.maxTempValue.textContent = formatTemp(ex.max.t_c, state.unit);
  els.maxTempTime.textContent = ex.max.ts_ms ? formatTimeLocal(ex.max.ts_ms) : "—";
}

/**
 * Render all UI pieces.
 * @param {DashboardState} state
 * @param {DashboardEls} els
 */
function renderAll(state, els) {
  renderLatest(state, els);
  renderRange(state, els);
  renderExtremes(state, els);
}

/**
 * Fetch latest.
 * @param {DashboardState} state
 */
async function fetchLatest(state) {
  const params = new URLSearchParams();
  if (state.stationId) params.set("station_id", state.stationId);
  const url = `/api/weather/latest?${params.toString()}`;
  const data = await fetchJson(url, DEFAULTS.requestTimeoutMs);
  state.latest = /** @type {LatestPayload} */ (data);
}

/**
 * Fetch range + set CSV link.
 * @param {DashboardState} state
 * @param {DashboardEls} els
 * @param {number} fromMs
 * @param {number} toMs
 */
async function fetchRange(state, els, fromMs, toMs) {
  const params = buildRangeParams(state, fromMs, toMs);

  const url = `/api/weather/range?${params.toString()}`;
  const data = await fetchJson(url, DEFAULTS.requestTimeoutMs);

  const payload = /** @type {RangePayload} */ (data);
  state.rangeRows = Array.isArray(payload?.rows) ? payload.rows : [];

  // CSV link mirrors the same range window (and station_id) but uses /api/weather.csv
  const csvParams = new URLSearchParams(params);
  els.csvLink.href = `/api/weather.csv?${csvParams.toString()}`;
}

/**
 * Fetch extremes for the same window as range.
 * Non-fatal if it fails.
 * @param {DashboardState} state
 * @param {number} fromMs
 * @param {number} toMs
 */
async function fetchExtremes(state, fromMs, toMs) {
  try {
    const params = new URLSearchParams();
    params.set("from_ms", String(fromMs));
    params.set("to_ms", String(toMs));
    if (state.stationId) params.set("station_id", state.stationId);

    const data = await fetchJson(`/api/weather/extremes?${params.toString()}`, DEFAULTS.requestTimeoutMs);
    state.extremes = /** @type {ExtremesPayload} */ (data);
  } catch {
    state.extremes = null;
  }
}

/**
 * Refresh latest + range (+ extremes) in one shot.
 * @param {DashboardState} state
 * @param {DashboardEls} els
 */
async function refreshAll(state, els) {
  setError(els, null);

  const {from_ms, to_ms} = computeWindow(state.range);

  // Label
  const label = state.range === "7d" ? "Last 7d" : `Last ${state.range.replace("h", "h")}`;
  els.rangeLabel.textContent = label;

  await Promise.all([
    fetchLatest(state),
    fetchRange(state, els, from_ms, to_ms),
    fetchExtremes(state, from_ms, to_ms)
  ]);

  renderAll(state, els);
}

/**
 * Startup
 */
function main() {
  /** @type {DashboardEls} */
  const els = {
    errorBox: getEl("errorBox"),
    subtitle: getEl("subtitle"),
    latestTime: getEl("latestTime"),
    tempValue: getEl("tempValue"),
    rhValue: getEl("rhValue"),
    pslpValue: getEl("pslpValue"),
    rssiValue: getEl("rssiValue"),
    rangeLabel: getEl("rangeLabel"),
    csvLink: getAnchor("csvLink"),
    rowsTbody: getTbody("rows"),
    spark: getCanvas("spark"),
    backToTop: /** @type {HTMLButtonElement} */ (getEl("backToTop")),
    pslpTrend: getEl("pslpTrend"),
    refreshBtn: /** @type {HTMLButtonElement} */ (getEl("refreshBtn")),
    unitF: getEl("unitF"),
    unitC: getEl("unitC"),
    dewValue: getEl("dewValue"),
    feelValue: getEl("feelValue"),
    minTempValue: getEl("minTempValue"),
    minTempTime: getEl("minTempTime"),
    maxTempValue: getEl("maxTempValue"),
    maxTempTime: getEl("maxTempTime"),
  };

  /** @type {DashboardState} */
  const state = {
    unit: DEFAULTS.unit,
    range: DEFAULTS.range,
    stationId: null,
    latest: null,
    rangeRows: [],
    extremes: null
  };

  bindRangeChips(state, els);
  bindUnitToggle(state, els);
  bindBackToTop(els);

  els.refreshBtn.addEventListener("click", () => {
    refreshAll(state, els).catch((e) => setError(els, `Refresh failed: ${e?.message || e}`));
  });

  // Initial load
  refreshAll(state, els).catch((e) => setError(els, `Init failed: ${e?.message || e}`));

  // Poll latest periodically (keep it lightweight: just latest + redraw the latest card)
  setInterval(async () => {
    try {
      await fetchLatest(state);
      renderLatest(state, els);
    } catch {
      // silent; do not annoy with flapping errors
    }
  }, DEFAULTS.latestPollMs);
}

document.addEventListener("DOMContentLoaded", main);
