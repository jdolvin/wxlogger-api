#!/usr/bin/env python3
"""
wxlogger.py

MQTT -> SQLite logger for topics under wx/#

- Subscribes to wx/# (covers tele/meta/state/anything else you add later)
- Logs every message to mqtt_message (catch-all journal)
- Parses wx/<station>/tele into telemetry_raw (with dedupe on station_id+boot_id+seq)
- Logs wx/<station>/meta into station_meta_event
- Logs wx/<station>/state into station_state_event
- Uses SQLite WAL mode
- Safe with paho-mqtt background thread: sqlite connection is created with
  check_same_thread=False and all writes are serialized with a threading.Lock.
"""

import json
import os
import re
import signal
import sqlite3
import threading
import time
from typing import Any, Optional, Tuple

import paho.mqtt.client as mqtt

# -----------------------------
# Configuration (env overrides)
# -----------------------------
MQTT_HOST = os.getenv("WXLOGGER_MQTT_HOST", "192.168.1.171")
MQTT_PORT = int(os.getenv("WXLOGGER_MQTT_PORT", "1883"))
MQTT_USER = os.getenv("WXLOGGER_MQTT_USER", "espuser")
MQTT_PASS = os.getenv("WXLOGGER_MQTT_PASS", "")  # set in /etc/wxlogger/wxlogger.env

MQTT_CLIENT_ID = os.getenv("WXLOGGER_MQTT_CLIENT_ID", "wxlogger_pi")
MQTT_KEEPALIVE = int(os.getenv("WXLOGGER_MQTT_KEEPALIVE", "60"))
MQTT_TOPIC = os.getenv("WXLOGGER_MQTT_TOPIC", "wx/#")

DB_PATH = os.getenv("WXLOGGER_DB_PATH", "/var/lib/wxlogger/wxlogger.sqlite")

TOPIC_RE = re.compile(r"^wx/([^/]+)/([^/]+)$")  # wx/<station_id>/<kind>

SCHEMA_SQL = r"""
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS station (
  station_id      TEXT PRIMARY KEY,
  display_name    TEXT,
  created_at_ms   INTEGER NOT NULL,
  last_seen_ms    INTEGER
);

-- Catch-all journal: logs every message, even if we don't parse it.
CREATE TABLE IF NOT EXISTS mqtt_message (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  topic         TEXT NOT NULL,
  station_id    TEXT,
  kind          TEXT NOT NULL,           -- 'tele' | 'meta' | 'state' | 'other'
  ts_recv_ms    INTEGER NOT NULL,
  payload_text  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mqtt_topic_ts ON mqtt_message(topic, ts_recv_ms);
CREATE INDEX IF NOT EXISTS idx_mqtt_station_ts ON mqtt_message(station_id, ts_recv_ms);

-- Parsed telemetry fields (subset). Full JSON preserved in payload_json.
CREATE TABLE IF NOT EXISTS telemetry_raw (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id   TEXT NOT NULL REFERENCES station(station_id),
  ts_ms        INTEGER NOT NULL,         -- payload ts_unix_ms preferred
  ts_recv_ms   INTEGER NOT NULL,
  boot_id      INTEGER,
  seq          INTEGER,

  t_c          REAL,
  rh           REAL,
  p_sta_pa     REAL,
  p_slp_pa     REAL,

  q_ntp        INTEGER,
  q_aht        INTEGER,
  q_bmp        INTEGER,
  rssi_dbm     INTEGER,

  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tele_station_ts ON telemetry_raw(station_id, ts_ms);

-- Dedupe for reconnect replays / retained delivery
CREATE UNIQUE INDEX IF NOT EXISTS uq_tele_station_boot_seq
ON telemetry_raw(station_id, boot_id, seq);

CREATE TABLE IF NOT EXISTS station_meta_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id  TEXT NOT NULL REFERENCES station(station_id),
  ts_recv_ms  INTEGER NOT NULL,
  meta_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_station_ts ON station_meta_event(station_id, ts_recv_ms);

CREATE TABLE IF NOT EXISTS station_state_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id  TEXT NOT NULL REFERENCES station(station_id),
  ts_recv_ms  INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK(state IN ('online','offline')),
  state_text  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_state_station_ts ON station_state_event(station_id, ts_recv_ms);
"""


def now_ms() -> int:
  return int(time.time() * 1000)


def parse_topic(topic: str) -> Tuple[Optional[str], str]:
  """
  Returns (station_id, kind). kind in {'tele','meta','state','other'}.
  """
  m = TOPIC_RE.match(topic)
  if not m:
    return None, "other"
  station_id, kind = m.group(1), m.group(2)
  if kind not in ("tele", "meta", "state"):
    kind = "other"
  return station_id, kind


def safe_int(v: Any) -> Optional[int]:
  try:
    if v is None:
      return None
    return int(v)
  except Exception:
    return None


def safe_float(v: Any) -> Optional[float]:
  try:
    if v is None:
      return None
    return float(v)
  except Exception:
    return None


def ensure_station(conn: sqlite3.Connection, station_id: str, ts_ms: int) -> None:
  conn.execute(
    """
    INSERT INTO station(station_id, created_at_ms, last_seen_ms)
    VALUES(?, ?, ?)
    ON CONFLICT(station_id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms
    """,
    (station_id, ts_ms, ts_ms),
  )


def handle_telemetry(conn: sqlite3.Connection, station_id: str, ts_recv: int, payload_text: str) -> None:
  try:
    data = json.loads(payload_text)
  except Exception:
    return

  ts_ms = safe_int(data.get("ts_unix_ms")) or ts_recv
  boot_id = safe_int(data.get("boot_id"))
  seq = safe_int(data.get("seq"))

  env = data.get("env") if isinstance(data.get("env"), dict) else {}
  q = data.get("q") if isinstance(data.get("q"), dict) else {}

  t_c = safe_float(env.get("t_c"))
  rh = safe_float(env.get("rh"))
  p_sta_pa = safe_float(env.get("p_sta_pa"))
  p_slp_pa = safe_float(env.get("p_slp_pa"))

  q_ntp = safe_int(q.get("ntp"))
  q_aht = safe_int(q.get("aht"))
  q_bmp = safe_int(q.get("bmp"))
  rssi_dbm = safe_int(q.get("rssi_dbm"))

  ensure_station(conn, station_id, ts_recv)

  try:
    conn.execute(
      """
      INSERT INTO telemetry_raw(
        station_id, ts_ms, ts_recv_ms, boot_id, seq,
        t_c, rh, p_sta_pa, p_slp_pa,
        q_ntp, q_aht, q_bmp, rssi_dbm,
        payload_json
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      """,
      (
        station_id, ts_ms, ts_recv, boot_id, seq,
        t_c, rh, p_sta_pa, p_slp_pa,
        q_ntp, q_aht, q_bmp, rssi_dbm,
        payload_text,
      ),
    )
  except sqlite3.IntegrityError:
    # Duplicate (station_id, boot_id, seq) — ignore
    pass


def handle_meta(conn: sqlite3.Connection, station_id: str, ts_recv: int, payload_text: str) -> None:
  ensure_station(conn, station_id, ts_recv)
  conn.execute(
    "INSERT INTO station_meta_event(station_id, ts_recv_ms, meta_json) VALUES(?,?,?)",
    (station_id, ts_recv, payload_text),
  )


def handle_state(conn: sqlite3.Connection, station_id: str, ts_recv: int, payload_text: str) -> None:
  ensure_station(conn, station_id, ts_recv)
  state = payload_text.strip().lower()
  if state not in ("online", "offline"):
    return
  conn.execute(
    "INSERT INTO station_state_event(station_id, ts_recv_ms, state, state_text) VALUES(?,?,?,?)",
    (station_id, ts_recv, state, payload_text),
  )


class WXLogger:
  def __init__(self) -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    # IMPORTANT: paho-mqtt callbacks run on a background thread when using loop_start().
    # SQLite connections are thread-bound by default, so we allow cross-thread usage and
    # serialize DB access with a lock.
    self.db_lock = threading.Lock()
    self.conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    self.conn.executescript(SCHEMA_SQL)
    self.conn.commit()

    # MQTT client
    # Note: Some paho-mqtt versions warn about "Callback API version 1 is deprecated".
    # It's harmless. We keep broad compatibility here.
    self.client = mqtt.Client(client_id=MQTT_CLIENT_ID, clean_session=True)
    if MQTT_USER:
      self.client.username_pw_set(MQTT_USER, MQTT_PASS)

    self.client.on_connect = self.on_connect
    self.client.on_message = self.on_message
    self.client.on_disconnect = self.on_disconnect
    self.client.reconnect_delay_set(min_delay=1, max_delay=30)

    self._stop = False

  def stop(self) -> None:
    self._stop = True

  def on_connect(self, client, userdata, flags, rc) -> None:
    if rc == 0:
      print(f"[mqtt] connected to {MQTT_HOST}:{MQTT_PORT}, subscribing to {MQTT_TOPIC}", flush=True)
      client.subscribe(MQTT_TOPIC, qos=0)
    else:
      print(f"[mqtt] connect failed rc={rc}", flush=True)

  def on_disconnect(self, client, userdata, rc) -> None:
    print(f"[mqtt] disconnected rc={rc}", flush=True)

  def on_message(self, client, userdata, msg) -> None:
    ts_recv = now_ms()
    topic = msg.topic
    payload_text = msg.payload.decode("utf-8", errors="replace")

    station_id, kind = parse_topic(topic)

    try:
      with self.db_lock:
        with self.conn:
          self.conn.execute(
            "INSERT INTO mqtt_message(topic, station_id, kind, ts_recv_ms, payload_text) VALUES(?,?,?,?,?)",
            (topic, station_id, kind, ts_recv, payload_text),
          )

          if station_id:
            if kind == "tele":
              handle_telemetry(self.conn, station_id, ts_recv, payload_text)
            elif kind == "meta":
              handle_meta(self.conn, station_id, ts_recv, payload_text)
            elif kind == "state":
              handle_state(self.conn, station_id, ts_recv, payload_text)
            else:
              ensure_station(self.conn, station_id, ts_recv)
    except Exception as e:
      print(f"[error] failed to log message topic={topic}: {e}", flush=True)

  def run(self) -> None:
    print(f"[init] db={DB_PATH}", flush=True)
    print(f"[init] mqtt={MQTT_HOST}:{MQTT_PORT} user={MQTT_USER} topic={MQTT_TOPIC}", flush=True)

    self.client.connect(MQTT_HOST, MQTT_PORT, MQTT_KEEPALIVE)
    self.client.loop_start()
    try:
      while not self._stop:
        time.sleep(0.5)
    finally:
      try:
        self.client.loop_stop()
        self.client.disconnect()
      except Exception:
        pass
      try:
        with self.db_lock:
          self.conn.close()
      except Exception:
        pass


def main() -> int:
  app = WXLogger()

  def _sig(signum, frame):
    print(f"[signal] {signum} received, stopping...", flush=True)
    app.stop()

  signal.signal(signal.SIGINT, _sig)
  signal.signal(signal.SIGTERM, _sig)

  app.run()
  return 0


if __name__ == "__main__":
  raise SystemExit(main())

