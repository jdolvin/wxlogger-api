/**
 * Weather Logger API Server
 * ==========================
 *
 * A read-only Express.js API server that provides access to weather telemetry data
 * stored in a SQLite database. Designed to run on a Raspberry Pi alongside other
 * services with minimal resource usage.
 *
 * FEATURES:
 * --------
 * - Real-time latest weather readings
 * - Historical data queries with time range filtering
 * - Temperature extremes (min/max) calculations
 * - CSV export for data analysis
 * - Station-based filtering for multi-sensor setups
 * - Health check endpoint for monitoring
 * - Read-only database access for safety
 *
 * API ENDPOINTS:
 * -------------
 * GET  /api/weather/latest      - Get most recent weather reading
 * GET  /api/weather/range       - Get historical data within time range (JSON)
 * GET  /api/weather.csv         - Download historical data as CSV
 * GET  /api/weather/extremes    - Get min/max temperatures in range
 * GET  /health                  - Database health check
 *
 * QUERY PARAMETERS:
 * ----------------
 * - station_id (string)   - Filter by specific weather station
 * - from_ms (number)      - Start timestamp in milliseconds (default: 24h ago)
 * - to_ms (number)        - End timestamp in milliseconds (default: now)
 * - limit (number)        - Maximum rows to return (1-200000, default: 50000)
 *
 * DATABASE SCHEMA:
 * ---------------
 * Table: telemetry_raw
 * - ts_ms (INTEGER)       - Measurement timestamp (milliseconds since epoch)
 * - ts_recv_ms (INTEGER)  - Server receipt timestamp
 * - station_id (TEXT)     - Weather station identifier
 * - t_c (REAL)            - Temperature in Celsius
 * - rh (REAL)             - Relative humidity (0-100%)
 * - p_slp_pa (REAL)       - Sea-level pressure in Pascals
 * - p_sta_pa (REAL)       - Station pressure in Pascals
 * - rssi_dbm (REAL)       - Signal strength in dBm
 * - payload_json (TEXT)   - Original JSON payload (optional)
 *
 * ENVIRONMENT VARIABLES:
 * ---------------------
 * - DB_PATH (string)      - Path to SQLite database (default: /var/lib/wxlogger/wxlogger.sqlite)
 * - PORT (number)         - Server port (default: 3001)
 * - HOST (string)         - Bind address (default: 0.0.0.0)
 *
 * DEPLOYMENT:
 * ----------
 * This server uses the asynchronous sqlite3 package (not better-sqlite3) because:
 * 1. Better compatibility with ARM architecture (Raspberry Pi)
 * 2. Non-blocking I/O suitable for resource-constrained environments
 * 3. Allows concurrent requests without blocking the event loop
 *
 * USAGE:
 * -----
 * # Development (custom database path)
 * DB_PATH=/path/to/test.sqlite node server.js
 *
 * # Production (uses default path)
 * node server.js
 *
 * # With PM2 process manager
 * pm2 start server.js --name weather-api
 *
 * @author Weather Logger Team
 * @version 2.0.0
 * @requires express ^4.18.0
 * @requires sqlite3 ^5.1.0
 */

import express from "express";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";

/* =============================================================================
 CONFIGURATION
 ============================================================================= */

/**
 * Database file path
 * Can be overridden via DB_PATH environment variable
 * @type {string}
 */
const DB_PATH = process.env.WXLOGGER_DB_PATH || "/var/lib/wxlogger/wxlogger.sqlite";

/**
 * Server port
 * Can be overridden via PORT environment variable
 * @type {number}
 */
const PORT = parseInt(process.env.WXLOGGER_PORT || "3001", 10);

/**
 * Host/bind address
 * Can be overridden via HOST environment variable
 * Default 0.0.0.0 allows external connections
 * @type {string}
 */
const HOST = process.env.HOST || "0.0.0.0";

/* =============================================================================
 APPLICATION SETUP
 ============================================================================= */

/**
 * Express application instance
 */
const app = express();

/**
 * ESM __dirname equivalent
 * ES modules don't have __dirname, so we derive it from import.meta.url
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Serve static files from public/ directory
 * This serves the frontend HTML/CSS/JS files
 */
app.use(express.static(path.join(__dirname, "public")));

/* =============================================================================
 DATABASE CONNECTION
 ============================================================================= */

/**
 * SQLite database connection
 * Opened in read-only mode for safety - prevents accidental writes
 *
 * Note: Even in read-only mode, SQLite needs write access to the parent
 * directory to create temporary lock files (.sqlite-shm, .sqlite-wal)
 */
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error("❌ Failed to open database:", err.message);
    console.error("   Database path:", DB_PATH);
    console.error("   Ensure the file exists and you have read permissions");
    process.exit(1);
  }
  console.log("✅ Connected to SQLite database");
  console.log("   Path:", DB_PATH);
});

/**
 * Graceful shutdown: close database connection on process termination
 */
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down gracefully...");
  db.close((err) => {
    if (err) {
      console.error("Error closing database:", err.message);
      process.exit(1);
    }
    console.log("✅ Database connection closed");
    process.exit(0);
  });
});

/* =============================================================================
 UTILITY FUNCTIONS
 ============================================================================= */

/**
 * Clamp an integer value within a specified range
 *
 * @param {string|number|undefined} value - Value to clamp
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @param {number} fallback - Default value if parsing fails
 * @returns {number} Clamped integer value
 *
 * @example
 * clampInt("150", 1, 100, 50) // returns 100
 * clampInt("abc", 1, 100, 50) // returns 50 (fallback)
 * clampInt(25, 1, 100, 50)    // returns 25
 */
function clampInt(value, min, max, fallback) {
  const x = Number.parseInt(value, 10);
  if (Number.isNaN(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

/**
 * Parse a timestamp in epoch milliseconds format
 *
 * @param {string|number|undefined|null} value - Timestamp value to parse
 * @param {number} fallback - Default value if parsing fails
 * @returns {number} Parsed timestamp (truncated to integer)
 *
 * @example
 * parseEpochMs("1706745600000", 0)     // returns 1706745600000
 * parseEpochMs(undefined, Date.now())  // returns current time
 * parseEpochMs("invalid", 0)           // returns 0
 */
function parseEpochMs(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const x = Number(value);
  if (!Number.isFinite(x)) return fallback;
  return Math.trunc(x);
}

/**
 * Extract station_id from request query parameters
 *
 * @param {express.Request} req - Express request object
 * @returns {string|null} Station ID or null if not provided
 *
 * @example
 * // GET /api/weather/latest?station_id=WX001
 * getStationId(req) // returns "WX001"
 */
function getStationId(req) {
  return req.query.station_id ? String(req.query.station_id) : null;
}

/**
 * Extract and validate time range window from request query parameters
 *
 * Defaults to last 24 hours if not specified.
 * Ensures from_ms is always less than to_ms.
 *
 * @param {express.Request} req - Express request object
 * @returns {{from_ms: number, to_ms: number}} Time window
 *
 * @example
 * // GET /api/weather/range?from_ms=1706659200000&to_ms=1706745600000
 * getRangeWindowMs(req) // returns {from_ms: 1706659200000, to_ms: 1706745600000}
 *
 * // GET /api/weather/range (no params)
 * getRangeWindowMs(req) // returns {from_ms: now-24h, to_ms: now}
 */
function getRangeWindowMs(req) {
  const now = Date.now();
  const defaultFrom = now - 24 * 3600 * 1000; // 24 hours ago

  const fromMs = parseEpochMs(req.query.from_ms, defaultFrom);
  const toMs = parseEpochMs(req.query.to_ms, now);

  // Ensure from_ms <= to_ms
  return {
    from_ms: Math.min(fromMs, toMs),
    to_ms: Math.max(fromMs, toMs)
  };
}

/**
 * Extract and validate limit parameter from request
 *
 * Clamps value between 1 and 200,000 to prevent excessive queries.
 *
 * @param {express.Request} req - Express request object
 * @returns {number} Validated limit value
 *
 * @example
 * // GET /api/weather/range?limit=100
 * getLimit(req) // returns 100
 *
 * // GET /api/weather/range?limit=999999
 * getLimit(req) // returns 200000 (clamped to max)
 */
function getLimit(req) {
  return clampInt(req.query.limit, 1, 200000, 50000);
}

/* =============================================================================
 SQL QUERY BUILDERS
 ============================================================================= */

/**
 * Build SQL query for fetching telemetry data within a time range
 *
 * Dynamically includes station_id filter and payload_json column based on options.
 * Results are ordered chronologically (oldest first) and limited by the limit parameter.
 *
 * @param {Object} options - Query options
 * @param {string|null} options.stationId - Optional station filter
 * @param {boolean} options.includePayloadJson - Whether to include raw JSON payload
 * @returns {string} SQL query string
 *
 * @example
 * buildTelemetryRangeQuery({ stationId: "WX001", includePayloadJson: false })
 * // Returns: "SELECT ts_ms, ... FROM telemetry_raw WHERE ts_ms BETWEEN ? AND ? AND station_id = ? ORDER BY ts_ms ASC LIMIT ?"
 */
function buildTelemetryRangeQuery({ stationId, includePayloadJson }) {
  const cols = [
    "ts_ms",
    "ts_recv_ms",
    "station_id",
    "t_c",
    "rh",
    "p_slp_pa",
    "p_sta_pa",
    "rssi_dbm"
  ];

  if (includePayloadJson) cols.push("payload_json");

  const sql =
    `SELECT ${cols.join(", ")} ` +
    "FROM telemetry_raw WHERE ts_ms BETWEEN ? AND ? " +
    (stationId ? "AND station_id = ? " : "") +
    "ORDER BY ts_ms ASC LIMIT ?";

  return sql;
}

/**
 * Build SQL query for fetching the most recent telemetry reading
 *
 * @param {Object} options - Query options
 * @param {string|null} options.stationId - Optional station filter
 * @returns {string} SQL query string
 *
 * @example
 * buildTelemetryLatestQuery({ stationId: null })
 * // Returns: "SELECT ... FROM telemetry_raw ORDER BY ts_ms DESC LIMIT 1"
 */
function buildTelemetryLatestQuery({ stationId }) {
  const sql =
    "SELECT ts_ms, ts_recv_ms, station_id, t_c, rh, p_slp_pa, p_sta_pa, rssi_dbm, payload_json " +
    "FROM telemetry_raw " +
    (stationId ? "WHERE station_id = ? " : "") +
    "ORDER BY ts_ms DESC LIMIT 1";

  return sql;
}

/**
 * Build parameter array for range queries
 *
 * Order matters: [from_ms, to_ms, station_id?, limit]
 * station_id is optional and only included if provided
 *
 * @param {Object} params - Query parameters
 * @param {number} params.from_ms - Start timestamp
 * @param {number} params.to_ms - End timestamp
 * @param {string|null} params.stationId - Optional station ID
 * @param {number} params.limit - Row limit
 * @returns {Array<number|string>} Parameter array for SQL query
 *
 * @example
 * makeRangeParams({ from_ms: 100, to_ms: 200, stationId: "WX001", limit: 50 })
 * // Returns: [100, 200, "WX001", 50]
 *
 * makeRangeParams({ from_ms: 100, to_ms: 200, stationId: null, limit: 50 })
 * // Returns: [100, 200, 50]
 */
function makeRangeParams({ from_ms, to_ms, stationId, limit }) {
  return stationId
    ? [from_ms, to_ms, stationId, limit]
    : [from_ms, to_ms, limit];
}

/* =============================================================================
 ERROR HANDLERS
 ============================================================================= */

/**
 * Send database error as JSON response
 *
 * @param {express.Response} res - Express response object
 * @param {Error} err - Error object
 * @returns {express.Response} Response with 500 status and error message
 */
function sendDbJsonError(res, err) {
  console.error("❌ Database error:", err.message);
  return res.status(500).json({ error: err.message });
}

/**
 * Send database error as plain text response
 *
 * Used for non-JSON endpoints like CSV downloads
 *
 * @param {express.Response} res - Express response object
 * @param {Error} err - Error object
 * @returns {express.Response} Response with 500 status and error message
 */
function sendDbTextError(res, err) {
  console.error("❌ Database error:", err.message);
  return res.status(500).send(err.message);
}

/* =============================================================================
 CSV UTILITIES
 ============================================================================= */

/**
 * Write CSV header row to response stream
 *
 * @param {express.Response} res - Express response object
 */
function writeTelemetryCsvHeader(res) {
  res.write("ts_ms,ts_recv_ms,station_id,t_c,rh,p_slp_pa,p_sta_pa,rssi_dbm\n");
}

/**
 * Write a single telemetry row to CSV response stream
 *
 * Handles null/undefined values by writing empty strings.
 *
 * @param {express.Response} res - Express response object
 * @param {Object} r - Database row object
 * @param {number} r.ts_ms - Timestamp
 * @param {number} r.ts_recv_ms - Receipt timestamp
 * @param {string} r.station_id - Station ID
 * @param {number} r.t_c - Temperature
 * @param {number} r.rh - Humidity
 * @param {number} r.p_slp_pa - Sea-level pressure
 * @param {number} r.p_sta_pa - Station pressure
 * @param {number} r.rssi_dbm - Signal strength
 */
function writeTelemetryCsvRow(res, r) {
  res.write(
    `${r.ts_ms},${r.ts_recv_ms},${String(r.station_id ?? "")},` +
    `${r.t_c ?? ""},${r.rh ?? ""},${r.p_slp_pa ?? ""},${r.p_sta_pa ?? ""},${r.rssi_dbm ?? ""}\n`
  );
}

/* =============================================================================
 API ROUTES
 ============================================================================= */

/**
 * GET /api/weather/range
 *
 * Fetch historical weather data within a specified time range
 *
 * Query Parameters:
 * - from_ms (number, optional): Start timestamp (default: 24h ago)
 * - to_ms (number, optional): End timestamp (default: now)
 * - station_id (string, optional): Filter by station
 * - limit (number, optional): Max rows (1-200000, default: 50000)
 *
 * Response (JSON):
 * {
 *   from_ms: number,
 *   to_ms: number,
 *   limit: number,
 *   station_id: string | null,
 *   rows: Array<{
 *     ts_ms: number,
 *     ts_recv_ms: number,
 *     station_id: string,
 *     t_c: number,
 *     rh: number,
 *     p_slp_pa: number,
 *     p_sta_pa: number,
 *     rssi_dbm: number
 *   }>
 * }
 *
 * @example
 * GET /api/weather/range?from_ms=1706659200000&to_ms=1706745600000&limit=100
 */
app.get("/api/weather/range", (req, res) => {
  const stationId = getStationId(req);
  const limit = getLimit(req);
  const { from_ms, to_ms } = getRangeWindowMs(req);

  const sql = buildTelemetryRangeQuery({ stationId, includePayloadJson: false });
  const params = makeRangeParams({ from_ms, to_ms, stationId, limit });

  db.all(sql, params, (err, rows) => {
    if (err) return sendDbJsonError(res, err);

    console.log(`📊 Range query: ${rows.length} rows (${new Date(from_ms).toISOString()} to ${new Date(to_ms).toISOString()})`);

    res.json({ from_ms, to_ms, limit, station_id: stationId, rows });
  });
});

/**
 * GET /api/weather.csv
 *
 * Download historical weather data as CSV file
 *
 * Query Parameters: Same as /api/weather/range
 *
 * Response: CSV file with headers
 * Content-Type: text/csv
 * Content-Disposition: attachment; filename=weather.csv
 *
 * @example
 * GET /api/weather.csv?from_ms=1706659200000&to_ms=1706745600000
 */
app.get("/api/weather.csv", (req, res) => {
  const stationId = getStationId(req);
  const limit = getLimit(req);
  const { from_ms, to_ms } = getRangeWindowMs(req);

  // Set headers for CSV download
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=weather.csv");

  writeTelemetryCsvHeader(res);

  const sql = buildTelemetryRangeQuery({ stationId, includePayloadJson: false });
  const params = makeRangeParams({ from_ms, to_ms, stationId, limit });

  db.all(sql, params, (err, rows) => {
    if (err) return sendDbTextError(res, err);

    console.log(`📥 CSV download: ${rows.length} rows`);

    for (const r of rows) writeTelemetryCsvRow(res, r);
    res.end();
  });
});

/**
 * GET /api/weather/latest
 *
 * Fetch the most recent weather reading
 *
 * Query Parameters:
 * - station_id (string, optional): Filter by specific station
 *
 * Response (JSON):
 * {
 *   ts_ms: number,
 *   ts_recv_ms: number,
 *   station_id: string,
 *   metrics: {
 *     t_c: number,
 *     rh: number,
 *     p_slp_pa: number,
 *     p_sta_pa: number,
 *     rssi_dbm: number
 *   },
 *   payload_json: string (original JSON payload)
 * }
 *
 * Error Responses:
 * - 404: No telemetry data found
 * - 500: Database error
 *
 * @example
 * GET /api/weather/latest
 * GET /api/weather/latest?station_id=WX001
 */
app.get("/api/weather/latest", (req, res) => {
  const stationId = getStationId(req);

  const sql = buildTelemetryLatestQuery({ stationId });
  const params = stationId ? [stationId] : [];

  db.get(sql, params, (err, row) => {
    if (err) return sendDbJsonError(res, err);

    if (!row) {
      console.warn("⚠️  No telemetry data found");
      return res.status(404).json({ error: "No telemetry found." });
    }

    console.log(`📡 Latest reading: ${new Date(row.ts_ms).toISOString()} (${row.station_id})`);

    res.json({
      ts_ms: row.ts_ms,
      ts_recv_ms: row.ts_recv_ms,
      station_id: row.station_id,
      metrics: {
        t_c: row.t_c,
        rh: row.rh,
        p_slp_pa: row.p_slp_pa,
        p_sta_pa: row.p_sta_pa,
        rssi_dbm: row.rssi_dbm
      },
      payload_json: row.payload_json
    });
  });
});

/**
 * GET /api/weather/extremes
 *
 * Calculate minimum and maximum temperatures within a time range
 *
 * Uses a CTE (Common Table Expression) to efficiently find min/max values
 * in a single query. Also returns counts for diagnostics.
 *
 * Query Parameters:
 * - from_ms (number, optional): Start timestamp (default: 24h ago)
 * - to_ms (number, optional): End timestamp (default: now)
 * - station_id (string, optional): Filter by station
 *
 * Response (JSON):
 * {
 *   from_ms: number,
 *   to_ms: number,
 *   station_id: string | null,
 *   min: {
 *     ts_ms: number,    // When minimum occurred
 *     t_c: number       // Minimum temperature value
 *   },
 *   max: {
 *     ts_ms: number,    // When maximum occurred
 *     t_c: number       // Maximum temperature value
 *   },
 *   counts: {
 *     rows_in_range: number,    // Total rows in time range
 *     rows_with_temp: number    // Rows with non-null temperature
 *   }
 * }
 *
 * Error Responses:
 * - 404: No temperature data in the selected range
 * - 500: Database error
 *
 * @example
 * GET /api/weather/extremes?from_ms=1706659200000&to_ms=1706745600000
 */
app.get("/api/weather/extremes", (req, res) => {
  const stationId = getStationId(req);
  const { from_ms, to_ms } = getRangeWindowMs(req);

  // Build WHERE clause for filtering
  const baseWhere = "ts_ms BETWEEN ? AND ? " + (stationId ? "AND station_id = ? " : "");
  const baseParams = stationId ? [from_ms, to_ms, stationId] : [from_ms, to_ms];

  // Complex CTE query to find min/max in a single database round-trip
  // This is more efficient than separate queries for min and max
  const sql = `
WITH filtered AS (
  SELECT ts_ms, station_id, t_c
  FROM telemetry_raw
  WHERE ${baseWhere} AND t_c IS NOT NULL
),
minrow AS (
  SELECT ts_ms, t_c
  FROM filtered
  ORDER BY t_c ASC, ts_ms ASC
  LIMIT 1
),
maxrow AS (
  SELECT ts_ms, t_c
  FROM filtered
  ORDER BY t_c DESC, ts_ms ASC
  LIMIT 1
),
counts AS (
  SELECT
    (SELECT COUNT(*) FROM telemetry_raw WHERE ${baseWhere}) AS rows_in_range,
    (SELECT COUNT(*) FROM filtered) AS rows_with_temp
)
SELECT
  (SELECT ts_ms FROM minrow) AS min_ts_ms,
  (SELECT t_c   FROM minrow) AS min_t_c,
  (SELECT ts_ms FROM maxrow) AS max_ts_ms,
  (SELECT t_c   FROM maxrow) AS max_t_c,
  (SELECT rows_in_range FROM counts) AS rows_in_range,
  (SELECT rows_with_temp FROM counts) AS rows_with_temp
;`;

  // baseWhere is used twice in the query, so duplicate params
  const params = [...baseParams, ...baseParams];

  db.get(sql, params, (err, row) => {
    if (err) return sendDbJsonError(res, err);

    // Check if we have valid data
    if (!row || row.rows_with_temp === 0 || row.min_t_c === null || row.max_t_c === null) {
      console.warn("⚠️  No temperature data in selected range");
      return res.status(404).json({
        error: "No temperature data in the selected range.",
        from_ms,
        to_ms,
        station_id: stationId,
      });
    }

    console.log(`🌡️  Extremes: ${row.min_t_c}°C to ${row.max_t_c}°C (${row.rows_with_temp} readings)`);

    res.json({
      from_ms,
      to_ms,
      station_id: stationId,
      min: { ts_ms: row.min_ts_ms, t_c: row.min_t_c },
      max: { ts_ms: row.max_ts_ms, t_c: row.max_t_c },
      counts: { rows_in_range: row.rows_in_range, rows_with_temp: row.rows_with_temp },
    });
  });
});

/**
 * GET /health
 *
 * Health check endpoint for monitoring and diagnostics
 *
 * Verifies:
 * 1. Database connection is alive
 * 2. Required table exists
 *
 * Response (JSON):
 * {
 *   ok: boolean,
 *   db_path: string,
 *   telemetry_raw_exists: boolean
 * }
 *
 * Error Response (500):
 * {
 *   ok: false,
 *   error: string
 * }
 *
 * @example
 * GET /health
 * // Response: { "ok": true, "db_path": "/var/lib/wxlogger/wxlogger.sqlite", "telemetry_raw_exists": true }
 */
app.get("/health", (req, res) => {
  db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_raw'",
    (err, row) => {
      if (err) {
        console.error("❌ Health check failed:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }

      const isHealthy = !!row;
      console.log(`${isHealthy ? "✅" : "⚠️ "} Health check: ${isHealthy ? "OK" : "Table missing"}`);

      res.json({
        ok: true,
        db_path: DB_PATH,
        telemetry_raw_exists: isHealthy
      });
    }
  );
});

/* =============================================================================
 SERVER STARTUP
 ============================================================================= */

/**
 * Start the Express server
 *
 * Listens on configured HOST and PORT.
 * Logs startup information for diagnostics.
 */
app.listen(PORT, HOST, () => {
  console.log("\n" + "=".repeat(60));
  console.log("🌤️  Weather Logger API Server");
  console.log("=".repeat(60));
  console.log(`📍 Server:    http://${HOST}:${PORT}`);
  console.log(`💾 Database:  ${DB_PATH}`);
  console.log(`🔍 Health:    http://${HOST}:${PORT}/health`);
  console.log("=".repeat(60) + "\n");
  console.log("📡 API Endpoints:");
  console.log(`   GET  /api/weather/latest   - Most recent reading`);
  console.log(`   GET  /api/weather/range    - Historical data (JSON)`);
  console.log(`   GET  /api/weather.csv      - Historical data (CSV)`);
  console.log(`   GET  /api/weather/extremes - Min/Max temperatures`);
  console.log(`   GET  /health               - Health check`);
  console.log("=".repeat(60) + "\n");
  console.log("✅ Server is ready for requests");
});