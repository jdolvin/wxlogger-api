/**
 * Weather Dashboard Client
 * ========================
 *
 * A single-page weather dashboard application that displays real-time and historical
 * weather data from a local weather station API.
 *
 * FEATURES:
 * --------
 * - Real-time weather metrics (temperature, humidity, pressure, signal strength)
 * - Computed values (dew point, feels-like temperature)
 * - Historical data visualization (table, sparkline chart)
 * - Temperature extremes (min/max) for selected time ranges
 * - Unit conversion (Fahrenheit ↔ Celsius)
 * - Time range filtering (1h, 3h, 6h, 12h, 24h, 7d)
 * - CSV export for historical data
 * - Automatic refresh polling for latest readings
 * - Responsive UI with accessibility features
 *
 * API ENDPOINTS REQUIRED:
 * ----------------------
 * - GET /api/weather/latest?station_id={id}
 *   Returns: {station_id, ts_ms, ts_recv_ms, metrics: {t_c, rh, p_slp_pa, rssi_dbm}}
 *
 * - GET /api/weather/range?from_ms={start}&to_ms={end}&station_id={id}&limit={n}
 *   Returns: {rows: [{ts_ms, t_c, rh, p_slp_pa}]}
 *
 * - GET /api/weather/extremes?from_ms={start}&to_ms={end}&station_id={id}
 *   Returns: {from_ms, to_ms, station_id, min: {ts_ms, t_c}, max: {ts_ms, t_c}}
 *
 * - GET /api/weather.csv?from_ms={start}&to_ms={end}&station_id={id}&limit={n}
 *   Returns: CSV file download
 *
 * ARCHITECTURE:
 * ------------
 * - Pure vanilla JavaScript (ES6+), no framework dependencies
 * - State-driven UI updates via renderAll() function
 * - Separation of concerns: fetch logic, rendering, event handling
 * - Type annotations via JSDoc for better IDE support
 *
 * @author Weather Dashboard Team
 * @version 2.0.0
 */

/* =============================================================================
 TYPE DEFINITIONS
 ============================================================================= */

/** @typedef {"F"|"C"} Unit - Temperature unit (Fahrenheit or Celsius) */
/** @typedef {"1h"|"3h"|"6h"|"12h"|"24h"|"7d"} RangeKey - Time range selector keys */

/**
 * Latest weather metrics from the station
 * @typedef {Object} LatestMetrics
 * @property {number=} t_c - Temperature in Celsius
 * @property {number=} rh - Relative humidity (0-100%)
 * @property {number=} p_slp_pa - Sea-level pressure in Pascals
 * @property {number=} rssi_dbm - Signal strength in dBm
 */

/**
 * Latest reading payload from API
 * @typedef {Object} LatestPayload
 * @property {string=} station_id - Weather station identifier
 * @property {number=} ts_ms - Measurement timestamp (milliseconds since epoch)
 * @property {number=} ts_recv_ms - Server receipt timestamp
 * @property {LatestMetrics=} metrics - Weather measurements
 */

/**
 * Single row of historical data
 * @typedef {Object} RangeRow
 * @property {number=} ts_ms - Timestamp in milliseconds
 * @property {number=} t_c - Temperature in Celsius
 * @property {number=} rh - Relative humidity
 * @property {number=} p_slp_pa - Sea-level pressure in Pascals
 */

/**
 * Historical data payload from API
 * @typedef {Object} RangePayload
 * @property {RangeRow[]=} rows - Array of historical readings
 */

/**
 * Single temperature extreme point
 * @typedef {Object} ExtremesPoint
 * @property {number=} ts_ms - Timestamp when extreme occurred
 * @property {number=} t_c - Temperature value in Celsius
 */

/**
 * Temperature extremes payload from API
 * @typedef {Object} ExtremesPayload
 * @property {number=} from_ms - Start of range
 * @property {number=} to_ms - End of range
 * @property {string=} station_id - Station identifier
 * @property {ExtremesPoint=} min - Minimum temperature point
 * @property {ExtremesPoint=} max - Maximum temperature point
 */

/**
 * Application state object
 * @typedef {Object} DashboardState
 * @property {Unit} unit - Current temperature unit
 * @property {RangeKey} range - Currently selected time range
 * @property {string|null} stationId - Station filter (null = all stations)
 * @property {LatestPayload|null} latest - Most recent reading
 * @property {RangeRow[]} rangeRows - Historical data rows
 * @property {ExtremesPayload|null} extremes - Min/max temperatures
 */

/**
 * DOM element references for UI updates
 * @typedef {Object} DashboardEls
 * @property {HTMLElement} errorBox - Error message banner
 * @property {HTMLElement} subtitle - Station info subtitle
 * @property {HTMLElement} latestTime - Latest reading timestamp display
 * @property {HTMLElement} tempValue - Current temperature display
 * @property {HTMLElement} rhValue - Current humidity display
 * @property {HTMLElement} pslpValue - Current pressure display
 * @property {HTMLElement} rssiValue - Current signal strength display
 * @property {HTMLElement} rangeLabel - Selected range label
 * @property {HTMLAnchorElement} csvLink - CSV download link
 * @property {HTMLTableSectionElement} rowsTbody - Historical data table body
 * @property {HTMLCanvasElement} spark - Sparkline canvas element
 * @property {HTMLButtonElement} backToTop - Scroll-to-top button
 * @property {HTMLElement} pslpTrend - Pressure trend indicator
 * @property {HTMLButtonElement} refreshBtn - Manual refresh button
 * @property {HTMLElement} unitF - Fahrenheit unit button
 * @property {HTMLElement} unitC - Celsius unit button
 * @property {HTMLElement} dewValue - Dew point display
 * @property {HTMLElement} feelValue - Feels-like temperature display
 * @property {HTMLElement} minTempValue - Minimum temperature value
 * @property {HTMLElement} minTempTime - Minimum temperature timestamp
 * @property {HTMLElement} maxTempValue - Maximum temperature value
 * @property {HTMLElement} maxTempTime - Maximum temperature timestamp
 */

/* =============================================================================
 CONSTANTS
 ============================================================================= */

/**
 * Time range definitions in milliseconds
 * Maps range keys to their duration in milliseconds
 */
const RANGE_MS = /** @type {const} */ ({
  "1h": 1 * 3600e3,      // 1 hour
  "3h": 3 * 3600e3,      // 3 hours
  "6h": 6 * 3600e3,      // 6 hours
  "12h": 12 * 3600e3,    // 12 hours
  "24h": 24 * 3600e3,    // 24 hours (1 day)
  "7d": 7 * 24 * 3600e3  // 7 days (1 week)
});

/**
 * Application configuration defaults
 */
const DEFAULTS = /** @type {const} */ ({
  unit: /** @type {Unit} */ ("F"),           // Default to Fahrenheit
  range: /** @type {RangeKey} */ ("3h"),     // Default to 3-hour range
  latestPollMs: 15000,                       // Poll for updates every 15 seconds
  requestTimeoutMs: 8000,                    // 8-second timeout for API requests
  maxTableRows: 50,                          // Limit historical table to 50 rows
  maxRangeLimit: 50000                       // Maximum data points for range queries
});

/* =============================================================================
 DOM UTILITIES
 ============================================================================= */

/**
 * Get element by ID with error checking
 * @param {string} id - Element ID
 * @returns {HTMLElement} The element
 * @throws {Error} If element is not found
 */
function getEl(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node;
}

/**
 * Get canvas element by ID with type checking
 * @param {string} id - Canvas element ID
 * @returns {HTMLCanvasElement} The canvas element
 * @throws {Error} If element is not found or not a canvas
 */
function getCanvas(id) {
  const node = /** @type {HTMLCanvasElement} */ (getEl(id));
  if (!(node instanceof HTMLCanvasElement)) {
    throw new Error(`#${id} is not a <canvas>`);
  }
  return node;
}

/**
 * Get anchor element by ID with type checking
 * @param {string} id - Anchor element ID
 * @returns {HTMLAnchorElement} The anchor element
 * @throws {Error} If element is not found or not an anchor
 */
function getAnchor(id) {
  const node = /** @type {HTMLAnchorElement} */ (getEl(id));
  if (!(node instanceof HTMLAnchorElement)) {
    throw new Error(`#${id} is not an <a>`);
  }
  return node;
}

/**
 * Get table body element by ID with type checking
 * @param {string} id - Table body element ID
 * @returns {HTMLTableSectionElement} The tbody element
 * @throws {Error} If element is not found or not a tbody
 */
function getTbody(id) {
  const node = /** @type {HTMLTableSectionElement} */ (getEl(id));
  if (!(node instanceof HTMLTableSectionElement)) {
    throw new Error(`#${id} is not a <tbody>`);
  }
  return node;
}

/* =============================================================================
 CONVERSION & FORMATTING UTILITIES
 ============================================================================= */

/**
 * Convert temperature from Celsius to Fahrenheit
 * Formula: °F = (°C × 9/5) + 32
 * @param {number} c - Temperature in Celsius
 * @returns {number} Temperature in Fahrenheit
 */
function cToF(c) {
  return (c * 9) / 5 + 32;
}

/**
 * Convert pressure from Pascals to inches of mercury
 * 1 Pa = 0.0002953 inHg
 * @param {number} pa - Pressure in Pascals
 * @returns {number} Pressure in inHg
 */
function paToInHg(pa) {
  return pa * 0.0002953;
}

/**
 * Check if a value is a finite number
 * Guards against NaN, Infinity, null, undefined, etc.
 * @param {unknown} x - Value to check
 * @returns {x is number} True if x is a finite number
 */
function isFiniteNumber(x) {
  return Number.isFinite(Number(x));
}

/**
 * Format temperature value with unit symbol
 * @param {unknown} t_c - Temperature in Celsius
 * @param {Unit} unit - Display unit (F or C)
 * @returns {string} Formatted temperature (e.g., "72.5°F")
 */
function formatTemp(t_c, unit) {
  if (!isFiniteNumber(t_c)) return "—";
  const c = Number(t_c);
  const v = unit === "F" ? cToF(c) : c;
  return `${v.toFixed(1)}°${unit}`;
}

/**
 * Format relative humidity percentage
 * @param {unknown} rh - Humidity value (0-100)
 * @returns {string} Formatted humidity (e.g., "65.0%")
 */
function formatRh(rh) {
  if (!isFiniteNumber(rh)) return "—";
  return `${Number(rh).toFixed(1)}%`;
}

/**
 * Format pressure in inches of mercury
 * @param {unknown} pa - Pressure in Pascals
 * @returns {string} Formatted pressure (e.g., "29.92 inHg")
 */
function formatPressure(pa) {
  if (!isFiniteNumber(pa)) return "—";
  return `${paToInHg(Number(pa)).toFixed(2)} inHg`;
}

/**
 * Format RSSI (signal strength) in dBm
 * @param {unknown} rssi - Signal strength value
 * @returns {string} Formatted RSSI (e.g., "-45 dBm")
 */
function formatRssi(rssi) {
  if (!isFiniteNumber(rssi)) return "—";
  return `${Math.round(Number(rssi))} dBm`;
}

/**
 * Format timestamp as localized date/time string
 * @param {number} tsMs - Timestamp in milliseconds
 * @returns {string} Formatted date/time (e.g., "Jan 15, 02:30 PM")
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

/* =============================================================================
 WEATHER CALCULATIONS
 ============================================================================= */

/**
 * Calculate dew point temperature using Magnus formula
 *
 * The Magnus formula is a commonly used approximation for dew point:
 * γ = (a × T)/(b + T) + ln(RH/100)
 * Td = (b × γ)/(a - γ)
 *
 * Where a=17.62, b=243.12°C for temperatures above 0°C
 *
 * @param {number} tC - Temperature in Celsius
 * @param {number} rhPct - Relative humidity (0-100%)
 * @returns {number} Dew point in Celsius
 */
function dewPointC(tC, rhPct) {
  // Clamp humidity to valid range (avoid log of 0)
  const rh = Math.max(1e-6, Math.min(100, rhPct));

  // Magnus formula constants
  const a = 17.62;
  const b = 243.12;

  // Calculate gamma (intermediate value)
  const gamma = (a * tC) / (b + tC) + Math.log(rh / 100);

  // Calculate dew point
  return (b * gamma) / (a - gamma);
}

/**
 * Calculate "feels like" temperature (heat index for warm weather)
 *
 * For temperatures below 80°F (26.7°C), returns actual temperature.
 * For warm temperatures, uses Rothfusz heat index regression equation.
 *
 * Note: This does not account for wind chill in cold weather, as we don't
 * have wind speed data. For a complete feels-like calculation, wind data
 * would be needed for temperatures below 50°F.
 *
 * @param {number} tC - Temperature in Celsius
 * @param {number} rhPct - Relative humidity (0-100%)
 * @returns {number} Feels-like temperature in Celsius
 */
function feelsLikeC(tC, rhPct) {
  // If RH is missing, return actual temperature
  if (!isFiniteNumber(rhPct)) return tC;

  // Convert to Fahrenheit for calculation
  const tF = cToF(tC);

  // Only apply heat index for warm temperatures (≥80°F)
  if (tF < 80) return tC;

  // Clamp humidity to valid range
  const R = Math.max(0, Math.min(100, rhPct));

  // Rothfusz regression equation for heat index
  // This is the equation used by the US National Weather Service
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

  // Convert back to Celsius
  return (HI - 32) * (5 / 9);
}

/* =============================================================================
 NETWORK UTILITIES
 ============================================================================= */

/**
 * Fetch JSON with timeout and error handling
 *
 * Wrapper around fetch() that:
 * - Adds AbortController for timeout
 * - Parses JSON response
 * - Extracts error messages from API responses
 * - Cleans up timeout on completion
 *
 * @param {string} url - API endpoint URL
 * @param {number} timeoutMs - Request timeout in milliseconds
 * @returns {Promise<any>} Parsed JSON response
 * @throws {Error} On timeout, network error, or API error response
 */
async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, {signal: ctrl.signal});
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;

    // Check for HTTP errors
    if (!r.ok) {
      // Try to extract error message from response
      const msg = (data && data.error) ? data.error : `${r.status} ${r.statusText}`;
      throw new Error(msg);
    }

    return data;
  } finally {
    clearTimeout(t);
  }
}

/* =============================================================================
 VISUALIZATION
 ============================================================================= */

/**
 * Draw temperature sparkline chart on canvas
 *
 * Creates a simple line chart with:
 * - Blue gradient fill beneath the line
 * - Blue stroke line
 * - Automatic Y-axis scaling with 10% padding
 * - High-DPI support (devicePixelRatio)
 *
 * @param {HTMLCanvasElement} canvas - Canvas element to draw on
 * @param {number[]} ys - Array of Y values (temperature readings)
 */
function drawSpark(canvas, ys) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Get canvas dimensions
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width;
  const h = canvas.height;

  // Clear canvas
  ctx.clearRect(0, 0, w, h);

  // Need at least 2 points to draw a line
  if (ys.length < 2) return;

  // Calculate Y-axis range with 10% padding
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = (maxY - minY) * 0.1 || 1; // Avoid division by zero
  const yRange = (maxY - minY) + 2 * pad;

  // Map data point index to X coordinate
  const xStep = w / (ys.length - 1);

  /**
   * Map Y value to canvas coordinate
   * @param {number} y - Data value
   * @returns {number} Canvas Y coordinate (inverted: 0 is top)
   */
  const toY = (y) => h - ((y - minY + pad) / yRange) * h;

  // Build path for line and fill
  ctx.beginPath();
  ctx.moveTo(0, toY(ys[0]));

  for (let i = 1; i < ys.length; i++) {
    ctx.lineTo(i * xStep, toY(ys[i]));
  }

  // Create gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(59, 130, 246, 0.3)");  // Blue at top
  grad.addColorStop(1, "rgba(59, 130, 246, 0.05)"); // Transparent at bottom

  // Draw fill
  ctx.lineTo(w, h);        // Bottom right
  ctx.lineTo(0, h);        // Bottom left
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Draw line
  ctx.beginPath();
  ctx.moveTo(0, toY(ys[0]));
  for (let i = 1; i < ys.length; i++) {
    ctx.lineTo(i * xStep, toY(ys[i]));
  }
  ctx.strokeStyle = "rgba(59, 130, 246, 0.9)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

/* =============================================================================
 UI STATE MANAGEMENT
 ============================================================================= */

/**
 * Display or clear error message banner
 * @param {DashboardEls} els - DOM element references
 * @param {string|null} msg - Error message (null to clear)
 */
function setError(els, msg) {
  if (msg) {
    els.errorBox.textContent = msg;
    els.errorBox.classList.remove("hidden");
  } else {
    els.errorBox.classList.add("hidden");
    els.errorBox.textContent = "";
  }
}

/**
 * Calculate time window for selected range
 * @param {RangeKey} rangeKey - Selected time range
 * @returns {{from_ms: number, to_ms: number}} Time window
 */
function computeWindow(rangeKey) {
  const to_ms = Date.now();
  const from_ms = to_ms - RANGE_MS[rangeKey];
  return {from_ms, to_ms};
}

/**
 * Build URL parameters for range API requests
 * @param {DashboardState} state - Application state
 * @param {number} fromMs - Start timestamp
 * @param {number} toMs - End timestamp
 * @returns {URLSearchParams} URL parameters object
 */
function buildRangeParams(state, fromMs, toMs) {
  const params = new URLSearchParams();
  params.set("from_ms", String(fromMs));
  params.set("to_ms", String(toMs));
  params.set("limit", String(DEFAULTS.maxRangeLimit));
  if (state.stationId) params.set("station_id", state.stationId);
  return params;
}

/* =============================================================================
 EVENT HANDLERS
 ============================================================================= */

/**
 * Bind click handlers to time range selection chips
 * @param {DashboardState} state - Application state
 * @param {DashboardEls} els - DOM element references
 */
function bindRangeChips(state, els) {
  const chips = document.querySelectorAll(".chip[data-range]");

  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const newRange = chip.getAttribute("data-range");
      if (!newRange || !(newRange in RANGE_MS)) return;

      // Update state
      state.range = /** @type {RangeKey} */ (newRange);

      // Update UI: toggle active class
      chips.forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");

      // Fetch and render new range data
      refreshAll(state, els).catch((e) =>
        setError(els, `Range change failed: ${e?.message || e}`)
      );
    });
  });
}

/**
 * Bind click handlers to temperature unit toggle buttons
 * @param {DashboardState} state - Application state
 * @param {DashboardEls} els - DOM element references
 */
function bindUnitToggle(state, els) {
  /**
   * Set temperature unit and update UI
   * @param {Unit} u - Unit to set (F or C)
   */
  function setUnit(u) {
    state.unit = u;

    // Update button states
    els.unitF.classList.toggle("is-active", u === "F");
    els.unitC.classList.toggle("is-active", u === "C");

    // Update ARIA attributes for accessibility
    els.unitF.setAttribute("aria-pressed", String(u === "F"));
    els.unitC.setAttribute("aria-pressed", String(u === "C"));

    // Re-render with new unit (no need to re-fetch)
    renderAll(state, els);
  }

  els.unitF.addEventListener("click", () => setUnit("F"));
  els.unitC.addEventListener("click", () => setUnit("C"));
}

/**
 * Bind scroll-based back-to-top button visibility and click handler
 * @param {DashboardEls} els - DOM element references
 */
function bindBackToTop(els) {
  const btn = els.backToTop;

  // Click handler: smooth scroll to top
  btn.addEventListener("click", () => {
    window.scrollTo({top: 0, behavior: "smooth"});
  });

  // Scroll handler: show/hide button based on scroll position
  window.addEventListener("scroll", () => {
    const show = window.scrollY > 600;
    btn.classList.toggle("is-visible", show);
  }, {passive: true}); // Passive listener for better scroll performance
}

/* =============================================================================
 RENDERING FUNCTIONS
 ============================================================================= */

/**
 * Render the "Latest" card with current readings
 *
 * Updates:
 * - Timestamp
 * - Temperature, humidity, pressure, RSSI
 * - Dew point and feels-like (computed)
 * - Station info subtitle
 *
 * @param {DashboardState} state - Application state
 * @param {DashboardEls} els - DOM element references
 */
function renderLatest(state, els) {
  const payload = state.latest;
  if (!payload || !payload.metrics) return;

  const m = payload.metrics;

  // Update timestamp
  els.latestTime.textContent = payload.ts_ms
    ? formatTimeLocal(payload.ts_ms)
    : "—";

  // Update basic metrics
  els.tempValue.textContent = formatTemp(m.t_c, state.unit);
  els.rhValue.textContent = formatRh(m.rh);
  els.pslpValue.textContent = formatPressure(m.p_slp_pa);
  els.rssiValue.textContent = formatRssi(m.rssi_dbm);

  // Compute and display dew point + feels-like temperature
  if (isFiniteNumber(m.t_c) && isFiniteNumber(m.rh)) {
    const dp = dewPointC(Number(m.t_c), Number(m.rh));
    const fl = feelsLikeC(Number(m.t_c), Number(m.rh));
    els.dewValue.textContent = formatTemp(dp, state.unit);
    els.feelValue.textContent = formatTemp(fl, state.unit);
  } else {
    els.dewValue.textContent = "—";
    els.feelValue.textContent = "—";
  }

  // Update subtitle with station info and timing
  const station = payload.station_id || (state.stationId ?? "—");
  const rel = payload.ts_ms
    ? `${Math.max(0, Math.round((Date.now() - payload.ts_ms) / 1000))}s`
    : "—";
  const abs = payload.ts_ms
    ? new Date(payload.ts_ms).toLocaleString()
    : "—";

  els.subtitle.textContent = `${station} • measured ${rel} ago • ${abs}`;
}

/**
 * Render historical data table, sparkline, and pressure trend
 *
 * Updates:
 * - Historical readings table (newest first)
 * - Temperature sparkline chart
 * - Pressure trend indicator (rising/falling/steady)
 *
 * @param {DashboardState} state - Application state
 * @param {DashboardEls} els - DOM element references
 */
function renderRange(state, els) {
  const rows = state.rangeRows || [];
  els.rowsTbody.innerHTML = "";

  // Populate table (reverse order: newest first)
  for (const r of rows.slice().reverse()) {
    const tr = document.createElement("tr");

    // Time column
    const tdT = document.createElement("td");
    tdT.textContent = r.ts_ms
      ? new Date(r.ts_ms).toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      })
      : "—";

    // Temperature column
    const tdTemp = document.createElement("td");
    tdTemp.textContent = formatTemp(r.t_c, state.unit);

    // Humidity column
    const tdRh = document.createElement("td");
    tdRh.textContent = formatRh(r.rh);

    // Pressure column
    const tdP = document.createElement("td");
    tdP.textContent = formatPressure(r.p_slp_pa);

    tr.appendChild(tdT);
    tr.appendChild(tdTemp);
    tr.appendChild(tdRh);
    tr.appendChild(tdP);
    els.rowsTbody.appendChild(tr);
  }

  // Extract temperature data for sparkline
  const temps = rows
    .map((x) => (isFiniteNumber(x.t_c) ? Number(x.t_c) : null))
    .filter((x) => x !== null);

  // Convert to selected unit for visual consistency
  const ys = state.unit === "F"
    ? temps.map((c) => cToF(c))
    : temps;

  drawSpark(els.spark, ys);

  // Calculate pressure trend: compare first and last readings
  const ps = rows
    .map((x) => (isFiniteNumber(x.p_slp_pa) ? Number(x.p_slp_pa) : null))
    .filter((x) => x !== null);

  if (ps.length >= 2) {
    const delta = paToInHg(ps[ps.length - 1] - ps[0]);

    // Determine trend direction (threshold: 0.001 inHg)
    const dir = delta > 0.001
      ? "Rising"
      : delta < -0.001
        ? "Falling"
        : "Steady";

    const sign = delta >= 0 ? "+" : "";
    els.pslpTrend.textContent = `${dir} (${sign}${delta.toFixed(2)} inHg)`;
  } else {
    els.pslpTrend.textContent = "—";
  }
}

/**
 * Render temperature extremes (min/max) for selected time range
 *
 * Updates:
 * - Minimum temperature value and timestamp
 * - Maximum temperature value and timestamp
 *
 * @param {DashboardState} state - Application state
 * @param {DashboardEls} els - DOM element references
 */
function renderExtremes(state, els) {
  const ex = state.extremes;

  // If no data or incomplete data, show placeholders
  if (!ex || !ex.min || !ex.max) {
    els.minTempValue.textContent = "—";
    els.minTempTime.textContent = "—";
    els.maxTempValue.textContent = "—";
    els.maxTempTime.textContent = "—";
    return;
  }

  // Display minimum temperature
  els.minTempValue.textContent = formatTemp(ex.min.t_c, state.unit);
  els.minTempTime.textContent = ex.min.ts_ms
    ? formatTimeLocal(ex.min.ts_ms)
    : "—";

  // Display maximum temperature
  els.maxTempValue.textContent = formatTemp(ex.max.t_c, state.unit);
  els.maxTempTime.textContent = ex.max.ts_ms
    ? formatTimeLocal(ex.max.ts_ms)
    : "—";
}

/**
 * Re-render all UI components based on current state
 *
 * This is the main UI update function called after state changes.
 *
 * @param {DashboardState} state - Application state
 * @param {DashboardEls} els - DOM element references
 */
function renderAll(state, els) {
  renderLatest(state, els);
  renderRange(state, els);
  renderExtremes(state, els);
}

/* =============================================================================
 API FUNCTIONS
 ============================================================================= */

/**
 * Fetch latest weather reading from API
 *
 * Updates state.latest with the most recent data point.
 *
 * @param {DashboardState} state - Application state
 * @throws {Error} On network error or API error
 */
async function fetchLatest(state) {
  const params = new URLSearchParams();
  if (state.stationId) params.set("station_id", state.stationId);

  const url = `/api/weather/latest?${params.toString()}`;
  const data = await fetchJson(url, DEFAULTS.requestTimeoutMs);

  state.latest = /** @type {LatestPayload} */ (data);
}

/**
 * Fetch historical data for specified time range
 *
 * Updates state.rangeRows and sets CSV download link.
 *
 * @param {DashboardState} state - Application state
 * @param {DashboardEls} els - DOM element references
 * @param {number} fromMs - Start timestamp
 * @param {number} toMs - End timestamp
 * @throws {Error} On network error or API error
 */
async function fetchRange(state, els, fromMs, toMs) {
  const params = buildRangeParams(state, fromMs, toMs);

  const url = `/api/weather/range?${params.toString()}`;
  const data = await fetchJson(url, DEFAULTS.requestTimeoutMs);

  const payload = /** @type {RangePayload} */ (data);
  state.rangeRows = Array.isArray(payload?.rows) ? payload.rows : [];

  // Update CSV download link to match the same time range
  const csvParams = new URLSearchParams(params);
  els.csvLink.href = `/api/weather.csv?${csvParams.toString()}`;
}

/**
 * Fetch temperature extremes for specified time range
 *
 * Updates state.extremes. Non-fatal: failures are silently ignored.
 *
 * @param {DashboardState} state - Application state
 * @param {number} fromMs - Start timestamp
 * @param {number} toMs - End timestamp
 */
async function fetchExtremes(state, fromMs, toMs) {
  try {
    const params = new URLSearchParams();
    params.set("from_ms", String(fromMs));
    params.set("to_ms", String(toMs));
    if (state.stationId) params.set("station_id", state.stationId);

    const url = `/api/weather/extremes?${params.toString()}`;
    const data = await fetchJson(url, DEFAULTS.requestTimeoutMs);

    state.extremes = /** @type {ExtremesPayload} */ (data);
  } catch {
    // Extremes are optional - don't fail the whole refresh
    state.extremes = null;
  }
}

/**
 * Refresh all data (latest + range + extremes) and update UI
 *
 * This is the main data refresh function called:
 * - On initial page load
 * - When user clicks refresh button
 * - When user changes time range
 *
 * @param {DashboardState} state - Application state
 * @param {DashboardEls} els - DOM element references
 */
async function refreshAll(state, els) {
  // Clear any previous errors
  setError(els, null);

  // Calculate time window for selected range
  const {from_ms, to_ms} = computeWindow(state.range);

  // Update range label in UI
  const label = state.range === "7d"
    ? "Last 7d"
    : `Last ${state.range}`;
  els.rangeLabel.textContent = label;

  // Update extremes card labels to match selected range
  const labelShort = label.toLowerCase();
  document
    .querySelectorAll("[data-extremes-range]")
    .forEach((el) => (el.textContent = labelShort));

  // Fetch all data in parallel for better performance
  await Promise.all([
    fetchLatest(state),
    fetchRange(state, els, from_ms, to_ms),
    fetchExtremes(state, from_ms, to_ms)
  ]);

  // Update all UI components
  renderAll(state, els);
}

/* =============================================================================
 APPLICATION INITIALIZATION
 ============================================================================= */

/**
 * Main application entry point
 *
 * Responsibilities:
 * 1. Initialize DOM element references
 * 2. Initialize application state
 * 3. Bind event handlers
 * 4. Perform initial data fetch
 * 5. Start polling for live updates
 */
function main() {
  // Gather all required DOM element references
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

  // Initialize application state with defaults
  /** @type {DashboardState} */
  const state = {
    unit: DEFAULTS.unit,
    range: DEFAULTS.range,
    stationId: null,      // null = show data from all stations
    latest: null,
    rangeRows: [],
    extremes: null
  };

  // Bind UI event handlers
  bindRangeChips(state, els);
  bindUnitToggle(state, els);
  bindBackToTop(els);

  // Manual refresh button
  els.refreshBtn.addEventListener("click", () => {
    refreshAll(state, els).catch((e) =>
      setError(els, `Refresh failed: ${e?.message || e}`)
    );
  });

  // Initial data load
  refreshAll(state, els).catch((e) =>
    setError(els, `Init failed: ${e?.message || e}`)
  );

  // Start polling for live updates
  // Only fetches latest reading (lightweight) to keep data fresh
  setInterval(async () => {
    try {
      await fetchLatest(state);
      renderLatest(state, els);
    } catch {
      // Silent failure - don't spam user with polling errors
      // Main refresh button is always available if needed
    }
  }, DEFAULTS.latestPollMs);
}

// Wait for DOM to be ready before initializing
document.addEventListener("DOMContentLoaded", main);