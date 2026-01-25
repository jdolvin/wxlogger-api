import express from "express";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const DB_PATH = "/var/lib/wxlogger/wxlogger.sqlite";
const PORT = 3001;

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error("Failed to open DB:", err.message);
    process.exit(1);
  } else {
    console.log("Connected to SQLite DB.");
  }
});

function clampInt(n, min, max, fallback) {
  const x = Number.parseInt(n, 10);
  if (Number.isNaN(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function parseEpochMs(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  const x = Number(v);
  if (!Number.isFinite(x)) return fallback;
  return Math.trunc(x);
}

app.get("/api/weather/range", (req, res) => {
  const stationId = req.query.station_id ? String(req.query.station_id) : null;
  const limit = clampInt(req.query.limit, 1, 200000, 50000);

  const fromMs = parseEpochMs(req.query.from_ms, Date.now() - 24 * 3600 * 1000);
  const toMs = parseEpochMs(req.query.to_ms, Date.now());

  const a = Math.min(fromMs, toMs);
  const b = Math.max(fromMs, toMs);

  const sql =
    "SELECT ts_ms, ts_recv_ms, station_id, t_c, rh, p_slp_pa, p_sta_pa, rssi_dbm " +
    "FROM telemetry_raw WHERE ts_ms BETWEEN ? AND ? " +
    (stationId ? "AND station_id = ? " : "") +
    "ORDER BY ts_ms ASC LIMIT ?";

  const params = stationId ? [a, b, stationId, limit] : [a, b, limit];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ from_ms: a, to_ms: b, limit, station_id: stationId, rows });
  });
});

app.get("/api/weather.csv", (req, res) => {
  const stationId = req.query.station_id ? String(req.query.station_id) : null;
  const limit = clampInt(req.query.limit, 1, 200000, 50000);

  const fromMs = parseEpochMs(req.query.from_ms, Date.now() - 24 * 3600 * 1000);
  const toMs = parseEpochMs(req.query.to_ms, Date.now());

  const a = Math.min(fromMs, toMs);
  const b = Math.max(fromMs, toMs);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=weather.csv");

  res.write("ts_ms,ts_recv_ms,station_id,t_c,rh,p_slp_pa,p_sta_pa,rssi_dbm\n");

  const sql =
    "SELECT ts_ms, ts_recv_ms, station_id, t_c, rh, p_slp_pa, p_sta_pa, rssi_dbm " +
    "FROM telemetry_raw WHERE ts_ms BETWEEN ? AND ? " +
    (stationId ? "AND station_id = ? " : "") +
    "ORDER BY ts_ms ASC LIMIT ?";

  const params = stationId ? [a, b, stationId, limit] : [a, b, limit];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).send(err.message);

    for (const r of rows) {
      res.write(
        `${r.ts_ms},${r.ts_recv_ms},${String(r.station_id ?? "")},` +
        `${r.t_c ?? ""},${r.rh ?? ""},${r.p_slp_pa ?? ""},${r.p_sta_pa ?? ""},${r.rssi_dbm ?? ""}\n`
      );
    }
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
  const stationId = req.query.station_id ? String(req.query.station_id) : null;

  const sql =
    "SELECT ts_ms, ts_recv_ms, station_id, t_c, rh, p_slp_pa, p_sta_pa, rssi_dbm, payload_json " +
    "FROM telemetry_raw " +
    (stationId ? "WHERE station_id = ? " : "") +
    "ORDER BY ts_ms DESC LIMIT 1";

  const params = stationId ? [stationId] : [];

  db.get(sql, params, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});

