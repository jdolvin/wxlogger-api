/**
 * Weather Dashboard Client
 * ------------------------
 * Responsibilities:
 *  - Fetch and render "latest" station telemetry
 *  - Fetch and render "range" telemetry (table, sparkline, pressure trend)
 *  - Manage UI state (unit, range, station filter)
 *
 * Notes:
 *  - This is written as a single-file module for easy drop-in use.
 *  - If you move to a bundler, export `createWeatherDashboard()` and import it.
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
 * @typedef {Object} DashboardState
 * @property {Unit} unit
 * @property {RangeKey} range
 * @property {string|null} stationId
 * @property {LatestPayload|null} latest
 * @property {RangeRow[]} rangeRows
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
 * @property {HTMLElement} pslpTrend
 * @property {HTMLButtonElement} refreshBtn
 * @property {HTMLElement} unitF
 * @property {HTMLElement} unitC
 * @property {HTMLElement} dewValue
 * @property {HTMLElement} feelValue
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
  return `${Number(rssi)} dBm`;
}

/** @param {unknown} ms */
function formatTime(ms) {
  if (!isFiniteNumber(ms) || Number(ms) <= 0) return "—";
  return new Date(Number(ms)).toLocaleString();
}

/** @param {unknown} ms */
function formatRelativeTime(ms) {
  if (!isFiniteNumber(ms) || Number(ms) <= 0) return "—";
  const diff = Date.now() - Number(ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Signed delta formatter (ex: +0.03, -0.12).
 * @param {unknown} x
 * @param {number} digits
 */
function formatDeltaSigned(x, digits = 2) {
  if (!isFiniteNumber(x)) return "";
  const v = Number(x);
  const s = v > 0 ? "+" : "";
  return `${s}${v.toFixed(digits)}`;
}

/**
 * Compute delta between first/last finite values for a numeric field.
 * Expects rows in chronological order (oldest -> newest).
 *
 * @template {Record<string, any>} T
 * @param {T[]} rows
 * @param {keyof T} field
 * @returns {{first:number,last:number,delta:number}|null}
 */
function computeTrend(rows, field) {
  const vals = (rows || [])
    .map(r => Number(r[field]))
    .filter(v => Number.isFinite(v));

  if (vals.length < 2) return null;

  const first = vals[0];
  const last = vals[vals.length - 1];
  return { first, last, delta: last - first };
}

/**
 * Small helper for URL query building.
 * @param {Record<string, string>} baseParams
 * @param {string|null} stationId
 */
function withStation(baseParams, stationId) {
  const params = new URLSearchParams(baseParams);
  if (stationId) params.set("station_id", stationId);
  return params;
}

/**
 * Dew point in Celsius from temperature (C) and RH (%).
 * Magnus formula (good for typical ambient ranges).
 * @param {number} t_c
 * @param {number} rh
 */
function dewPointC(t_c, rh) {
  const T = Number(t_c);
  const RH = Number(rh);
  if (!Number.isFinite(T) || !Number.isFinite(RH) || RH <= 0 || RH > 100) return NaN;

  const a = 17.27;
  const b = 237.7;
  const gamma = (a * T) / (b + T) + Math.log(RH / 100);
  return (b * gamma) / (a - gamma);
}

/**
 * Feels-like (apparent temperature) in Celsius using Steadman-style approximation
 * with wind speed assumed ~0 (since we don't have wind).
 * @param {number} t_c
 * @param {number} rh
 */
function feelsLikeC(t_c, rh) {
  const T = Number(t_c);
  const RH = Number(rh);
  if (!Number.isFinite(T) || !Number.isFinite(RH) || RH <= 0 || RH > 100) return NaN;

  // vapor pressure e (hPa)
  const e = (RH / 100) * 6.105 * Math.exp((17.27 * T) / (237.7 + T));
  // Apparent temperature (shade, light wind ~0 m/s)
  return T + 0.33 * e - 4.0;
}

/**
 * Heat index in Fahrenheit (NOAA regression). Returns NaN if out of range.
 * @param {number} t_f
 * @param {number} rh
 */
function heatIndexF(t_f, rh) {
  const T = Number(t_f);
  const R = Number(rh);
  if (!Number.isFinite(T) || !Number.isFinite(R)) return NaN;

  // Only meaningful in warm/humid conditions
  if (T < 80 || R < 40) return NaN;

  const HI =
    -42.379 +
    2.04901523 * T +
    10.14333127 * R -
    0.22475541 * T * R -
    0.00683783 * T * T -
    0.05481717 * R * R +
    0.00122874 * T * T * R +
    0.00085282 * T * R * R -
    0.00000199 * T * T * R * R;

  return HI;
}

/**
 * @param {unknown} t_c
 * @param {unknown} rh
 * @param {Unit} unit
 */
function formatDewPoint(t_c, rh, unit) {
  if (!isFiniteNumber(t_c) || !isFiniteNumber(rh)) return "—";
  const dpC = dewPointC(Number(t_c), Number(rh));
  if (!Number.isFinite(dpC)) return "—";
  const v = unit === "F" ? cToF(dpC) : dpC;
  return `${v.toFixed(1)}°${unit}`;
}

/**
 * @param {unknown} t_c
 * @param {unknown} rh
 * @param {Unit} unit
 */
function formatFeelsLike(t_c, rh, unit) {
  if (!isFiniteNumber(t_c) || !isFiniteNumber(rh)) return "—";

  const T_c = Number(t_c);
  const RH = Number(rh);

  // Prefer heat index when truly hot/humid (more intuitive for users)
  const T_f = cToF(T_c);
  const hiF = heatIndexF(T_f, RH);

  let outC;
  if (Number.isFinite(hiF)) {
    outC = (hiF - 32) * 5 / 9; // convert heat index back to C for unified unit handling
  } else {
    outC = feelsLikeC(T_c, RH);
  }

  if (!Number.isFinite(outC)) return "—";
  const v = unit === "F" ? cToF(outC) : outC;
  return `${v.toFixed(1)}°${unit}`;
}

/**
 * Fetch JSON with an iOS-friendly timeout and no-store caching.
 * @template T
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
    }
    return /** @type {Promise<T>} */ (res.json());
  } finally {
    clearTimeout(t);
  }
}

/**
 * Create and start the dashboard runtime.
 * Keep this as a single entrypoint to make future extraction to a module trivial.
 */
function createWeatherDashboard() {
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
    pslpTrend: getEl("pslpTrend"),
    refreshBtn: /** @type {HTMLButtonElement} */ (getEl("refreshBtn")),
    unitF: getEl("unitF"),
    unitC: getEl("unitC"),
    dewValue: getEl("dewValue"),
    feelValue: getEl("feelValue")
  };

  /** @type {DashboardState} */
  const state = {
    unit: DEFAULTS.unit,
    range: DEFAULTS.range,
    stationId: null,
    latest: null,
    rangeRows: []
  };

  /**
   * Error rendering should never throw.
   * @param {string} msg
   */
  function setError(msg) {
    if (!msg) {
      els.errorBox.classList.add("hidden");
      els.errorBox.textContent = "";
      return;
    }
    els.errorBox.textContent = msg;
    els.errorBox.classList.remove("hidden");
  }

  function getRangeWindowMs() {
    const now = Date.now();
    const span = RANGE_MS[state.range] ?? RANGE_MS[DEFAULTS.range];
    return { from_ms: now - span, to_ms: now };
  }

  function updateCsvLink() {
    const { from_ms, to_ms } = getRangeWindowMs();
    const params = withStation(
      {
        from_ms: String(from_ms),
        to_ms: String(to_ms),
        limit: String(DEFAULTS.maxRangeLimit)
      },
      state.stationId
    );
    els.csvLink.href = `/api/weather.csv?${params.toString()}`;
  }

  function renderLatest() {
    const l = state.latest;
    if (!l) return;

    els.subtitle.textContent = `${l.station_id || "—"} • ${formatRelativeTime(l.ts_ms)} • ${formatTime(l.ts_ms)}`;
    els.latestTime.textContent = `Event: ${formatTime(l.ts_ms)} • Recv: ${formatTime(l.ts_recv_ms)}`;
    els.tempValue.textContent = formatTemp(l.metrics?.t_c, state.unit);
    els.rhValue.textContent = formatRh(l.metrics?.rh);
    els.pslpValue.textContent = formatPressure(l.metrics?.p_slp_pa);
    els.rssiValue.textContent = formatRssi(l.metrics?.rssi_dbm);
    els.dewValue.textContent = formatDewPoint(l.metrics?.t_c, l.metrics?.rh, state.unit);
    els.feelValue.textContent = formatFeelsLike(l.metrics?.t_c, l.metrics?.rh, state.unit);
  }

  function renderPressureTrend() {
    const rows = state.rangeRows;
    const t = computeTrend(rows, "p_slp_pa");
    if (!t) {
      els.pslpTrend.textContent = "—";
      return;
    }

    const deltaInHg = paToInHg(t.delta);

    // Threshold to avoid noise-driven arrow flipping
    let arrow = "→";
    if (deltaInHg > 0.01) arrow = "↑";
    else if (deltaInHg < -0.01) arrow = "↓";

    els.pslpTrend.textContent = `${arrow} ${formatDeltaSigned(deltaInHg, 2)} inHg over ${state.range}`;
  }

  function renderTable() {
    els.rowsTbody.innerHTML = "";

    // Rows are assumed oldest->newest. We want newest first for mobile.
    const lastRows = [...state.rangeRows].reverse().slice(0, DEFAULTS.maxTableRows);

    for (const r of lastRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatTime(r.ts_ms)}</td>
        <td>${formatTemp(r.t_c, state.unit)}</td>
        <td>${formatRh(r.rh)}</td>
        <td>${formatPressure(r.p_slp_pa)}</td>
      `;
      els.rowsTbody.appendChild(tr);
    }
  }

  function renderSparkline() {
    const canvas = els.spark;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rows = state.rangeRows;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (rows.length < 2) {
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

    const values = valuesC.map(v => (state.unit === "F" ? cToF(v) : v));

    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }

    const padX = 12,
      padY = 14;
    const W = canvas.width - padX * 2;
    const H = canvas.height - padY * 2;

    // Grid baseline
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(padX, padY + H);
    ctx.lineTo(padX + W, padY + H);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Fill gradient
    const grad = ctx.createLinearGradient(0, padY, 0, padY + H);
    grad.addColorStop(0, "rgba(0, 200, 255, 0.6)");
    grad.addColorStop(1, "rgba(0, 200, 255, 0.05)");

    // Area path
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = padX + (i / (values.length - 1)) * W;
      const y = padY + (1 - (v - min) / (max - min)) * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(padX + W, padY + H);
    ctx.lineTo(padX, padY + H);
    ctx.closePath();

    ctx.fillStyle = grad;
    ctx.fill();

    // Outline
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

  function renderAll() {
    renderLatest();
    renderTable();
    renderSparkline();
    renderPressureTrend();
    updateCsvLink();
  }

  /** @param {Unit} unit */
  function setUnit(unit) {
    state.unit = unit;
    els.unitF.classList.toggle("is-active", unit === "F");
    els.unitC.classList.toggle("is-active", unit === "C");
    renderAll();
  }

  /** @param {RangeKey} range */
  function setRange(range) {
    state.range = range;
    els.rangeLabel.textContent = `Last ${range}`;

    document.querySelectorAll(".chip").forEach(btn => {
      const b = /** @type {HTMLElement} */ (btn);
      b.classList.toggle("is-active", b.dataset.range === range);
    });

    updateCsvLink();
    void refreshRange(); // deliberate fire-and-forget (errors handled internally)
  }

  async function refreshLatest() {
    setError("");
    const params = withStation({}, state.stationId);

    try {
      const data = await fetchJson(
        `/api/weather/latest?${params.toString()}`,
        DEFAULTS.requestTimeoutMs
      );
      state.latest = /** @type {LatestPayload} */ (data);
      renderLatest();
    } catch (e) {
      setError(`Latest failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function refreshRange() {
    setError("");
    const { from_ms, to_ms } = getRangeWindowMs();

    const params = withStation(
      {
        from_ms: String(from_ms),
        to_ms: String(to_ms),
        limit: String(DEFAULTS.maxRangeLimit)
      },
      state.stationId
    );

    try {
      const data = await fetchJson(
        `/api/weather/range?${params.toString()}`,
        DEFAULTS.requestTimeoutMs
      );
      const payload = /** @type {RangePayload} */ (data);
      state.rangeRows = payload.rows || [];
      renderTable();
      renderSparkline();
      renderPressureTrend();
    } catch (e) {
      setError(`Range failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function wireUI() {
    els.refreshBtn.addEventListener("click", async () => {
      await refreshLatest();
      await refreshRange();
    });

    els.unitF.addEventListener("click", () => setUnit("F"));
    els.unitC.addEventListener("click", () => setUnit("C"));

    document.querySelectorAll(".chip").forEach(btn => {
      btn.addEventListener("click", () => {
        const range = /** @type {RangeKey} */ (/** @type {HTMLElement} */ (btn).dataset.range);
        setRange(range);
      });
    });
  }

  let latestTimer = /** @type {number|undefined} */ (undefined);

  async function start() {
    wireUI();
    setUnit(DEFAULTS.unit);
    setRange(DEFAULTS.range);

    // Initial load
    await refreshLatest();
    await refreshRange();

    // Gentle polling for “latest” (internal LAN, iOS-friendly)
    latestTimer = window.setInterval(() => {
      void refreshLatest();
    }, DEFAULTS.latestPollMs);
  }

  function stop() {
    if (latestTimer) window.clearInterval(latestTimer);
    latestTimer = undefined;
  }

  return {
    start,
    stop,

    // Future expansion points (station selector UI, etc.)
    /** @param {string|null} stationId */
    setStationId(stationId) {
      state.stationId = stationId;
      updateCsvLink();
      void refreshLatest();
      void refreshRange();
    }
  };
}

// Boot
(() => {
  const dashboard = createWeatherDashboard();
  void dashboard.start();
})();
