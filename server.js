import express from "express";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";

/**
 * wxlogger-api: minimal read-only API over the wxlogger SQLite database.
 * Keep changes behavior-preserving unless explicitly noted.
 */

const DB_PATH = "/var/lib/wxlogger/wxlogger.sqlite";
const PORT = 3001;

const app = express();

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Static UI (if present)
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------
// DB (read-only)
// -----------------------------
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error("Failed to open DB:", err.message);
    process.exit(1);
  }
  console.log("Connected to SQLite DB.");
});

// -----------------------------
// Helpers
// -----------------------------
function clampInt(value, min, max, fallback) {
  const x = Number.parseInt(value, 10);
  if (Number.isNaN(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function parseEpochMs(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const x = Number(value);
  if (!Number.isFinite(x)) return fallback;
  return Math.trunc(x);
}

function getStationId(req) {
  return req.query.station_id ? String(req.query.station_id) : null;
}

function getRangeWindowMs(req) {
  // Defaults preserved: last 24h to now
  const fromMs = parseEpochMs(req.query.from_ms, Date.now() - 24 * 3600 * 1000);
  const toMs = parseEpochMs(req.query.to_ms, Date.now());
  return {
    from_ms: Math.min(fromMs, toMs),
    to_ms: Math.max(fromMs, toMs)
  };
}

function getLimit(req) {
  // Defaults preserved
  return clampInt(req.query.limit, 1, 200000, 50000);
}

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

function buildTelemetryLatestQuery({ stationId }) {
  const sql =
    "SELECT ts_ms, ts_recv_ms, station_id, t_c, rh, p_slp_pa, p_sta_pa, rssi_dbm, payload_json " +
    "FROM telemetry_raw " +
    (stationId ? "WHERE station_id = ? " : "") +
    "ORDER BY ts_ms DESC LIMIT 1";

  return sql;
}

function makeRangeParams({ from_ms, to_ms, stationId, limit }) {
  return stationId ? [from_ms, to_ms, stationId, limit] : [from_ms, to_ms, limit];
}

function sendDbJsonError(res, err) {
  return res.status(500).json({ error: err.message });
}

function sendDbTextError(res, err) {
  return res.status(500).send(err.message);
}

function writeTelemetryCsvHeader(res) {
  res.write("ts_ms,ts_recv_ms,station_id,t_c,rh,p_slp_pa,p_sta_pa,rssi_dbm\n");
}

function writeTelemetryCsvRow(res, r) {
  res.write(
    `${r.ts_ms},${r.ts_recv_ms},${String(r.station_id ?? "")},` +
    `${r.t_c ?? ""},${r.rh ?? ""},${r.p_slp_pa ?? ""},${r.p_sta_pa ?? ""},${r.rssi_dbm ?? ""}\n`
  );
}

// -----------------------------
// Routes
// -----------------------------
app.get("/api/weather/range", (req, res) => {
  const stationId = getStationId(req);
  const limit = getLimit(req);
  const { from_ms, to_ms } = getRangeWindowMs(req);

  const sql = buildTelemetryRangeQuery({ stationId, includePayloadJson: false });
  const params = makeRangeParams({ from_ms, to_ms, stationId, limit });

  db.all(sql, params, (err, rows) => {
    if (err) return sendDbJsonError(res, err);
    res.json({ from_ms, to_ms, limit, station_id: stationId, rows });
  });
});

app.get("/api/weather.csv", (req, res) => {
  const stationId = getStationId(req);
  const limit = getLimit(req);
  const { from_ms, to_ms } = getRangeWindowMs(req);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=weather.csv");

  writeTelemetryCsvHeader(res);

  const sql = buildTelemetryRangeQuery({ stationId, includePayloadJson: false });
  const params = makeRangeParams({ from_ms, to_ms, stationId, limit });

  db.all(sql, params, (err, rows) => {
    if (err) return sendDbTextError(res, err);

    for (const r of rows) writeTelemetryCsvRow(res, r);
    res.end();
  });
});

app.get("/health", (req, res) => {
  db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_raw'",
    (err, row) => {
      if (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
      res.json({
        ok: true,
        db_path: DB_PATH,
        telemetry_raw_exists: !!row
      });
    }
  );
});

app.get("/api/weather/latest", (req, res) => {
  const stationId = getStationId(req);

  const sql = buildTelemetryLatestQuery({ stationId });
  const params = stationId ? [stationId] : [];

  db.get(sql, params, (err, row) => {
    if (err) return sendDbJsonError(res, err);
    if (!row) return res.status(404).json({ error: "No telemetry found." });

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

// -----------------------------
// Startup
// -----------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
