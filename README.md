# 🌤️ Local Weather Dashboard

A beautiful, self-hosted weather dashboard for personal weather stations. Built for makers who want to monitor their own hyperlocal weather data.

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)

## ✨ Features

- **Real-time Updates** - Live weather data with 15-second auto-refresh
- **Historical Data** - View trends from 1 hour to 7 days
- **Temperature Extremes** - Track daily/weekly min/max temperatures
- **Computed Metrics** - Dew point and feels-like temperature
- **Data Export** - Download historical data as CSV
- **Responsive Design** - Works on desktop, tablet, and mobile
- **Accessible** - WCAG AA compliant with screen reader support
- **Dark Theme** - Easy on the eyes, optimized for nighttime viewing

## 🏗️ System Architecture

The complete weather monitoring system consists of five components:

```
┌──────────────────┐
│ ESP8266 Station  │  ── MQTT Publish ──>  ┌──────────────┐
│  NodeMCU v3      │   wx/<station>/tele   │ MQTT Broker  │
│  - AHTx0 (T/RH)  │   wx/<station>/meta   │ (Mosquitto)  │
│  - BMP180 (P)    │   wx/<station>/state  └──────┬───────┘
└──────────────────┘                              │
                                          [MQTT Subscribe]
                                                  │
                                           ┌──────▼────────┐
                                           │  wxlogger.py  │
                                           │  Data Logger  │
                                           │  SQLite (WAL) │
                                           └───────────────┘
                                                  │
                                           [SQL Queries]
                                                  │
                                           ┌──────▼────────┐
                                           │  server.js    │
                                           │  API Server   │
                                           │  (Express)    │
                                           └──────┬────────┘
                                                  │
                                            [HTTP GET]
                                                  │
                                           ┌──────▼────────┐
                                           │ Web Dashboard │
                                           │   (Browser)   │
                                           └───────────────┘
```

### Component Roles

1. **ESP8266 Weather Station** - Collects sensor data (temp, humidity, pressure) and publishes to MQTT every 60 seconds
2. **MQTT Broker (Mosquitto)** - Message queue running on Raspberry Pi
3. **wxlogger.py** - Python daemon that subscribes to MQTT topics and writes to SQLite database
4. **server.js** - Read-only API server that queries SQLite and serves JSON/CSV data
5. **Web Dashboard** - Browser-based UI for visualization and data export

## 🚀 Quick Start

### Prerequisites

- **Raspberry Pi** (or similar Linux server) for hosting
- **Node.js** 18+ (for API server)
- **Python 3** with `paho-mqtt` (for data logger)
- **Mosquitto** MQTT broker
- **ESP8266/NodeMCU** with sensors (AHTx0 for temp/humidity, BMP180 for pressure)

### Installation

#### 1. Install System Dependencies

```bash
# Update system
sudo apt-get update
sudo apt-get upgrade -y

# Install Mosquitto MQTT broker
sudo apt-get install -y mosquitto mosquitto-clients

# Install Python and pip
sudo apt-get install -y python3 python3-pip

# Install Node.js (using NodeSource)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### 2. Install Python Dependencies

```bash
pip3 install paho-mqtt
```

#### 3. Setup MQTT Broker

```bash
# Create MQTT user (for ESP8266 authentication)
sudo mosquitto_passwd -c /etc/mosquitto/passwd espuser
# Enter password when prompted

# Configure Mosquitto to use password file
sudo tee /etc/mosquitto/conf.d/default.conf > /dev/null <<EOF
listener 1883
allow_anonymous false
password_file /etc/mosquitto/passwd
EOF

# Restart Mosquitto
sudo systemctl restart mosquitto
sudo systemctl enable mosquitto

# Test subscription
mosquitto_sub -h localhost -t "wx/#" -u espuser -P "YOUR_PASSWORD" -v
```

#### 4. Clone Repository and Setup API Server

```bash
cd ~
git clone https://github.com/yourusername/weather-dashboard.git
cd weather-dashboard
npm install
```

#### 5. Setup Data Logger

```bash
# Create wxlogger directory
sudo mkdir -p /var/lib/wxlogger
sudo chown $USER:$USER /var/lib/wxlogger

# Create environment file for wxlogger
sudo mkdir -p /etc/wxlogger
sudo tee /etc/wxlogger/wxlogger.env > /dev/null <<EOF
WXLOGGER_MQTT_HOST=192.168.1.171
WXLOGGER_MQTT_PORT=1883
WXLOGGER_MQTT_USER=espuser
WXLOGGER_MQTT_PASS=YOUR_MQTT_PASSWORD
WXLOGGER_DB_PATH=/var/lib/wxlogger/wxlogger.sqlite
EOF
```

#### 6. Create Systemd Services

**Data Logger Service:**

```bash
sudo tee /etc/systemd/system/wxlogger.service > /dev/null <<EOF
[Unit]
Description=Weather MQTT Logger
After=network.target mosquitto.service
Requires=mosquitto.service

[Service]
Type=simple
User=$USER
EnvironmentFile=/etc/wxlogger/wxlogger.env
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/python3 $(pwd)/wxlogger.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
```

**API Server Service:**

```bash
sudo tee /etc/systemd/system/weather-api.service > /dev/null <<EOF
[Unit]
Description=Weather Dashboard API
After=network.target wxlogger.service
Requires=wxlogger.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
Environment="WXLOGGER_DB_PATH=/var/lib/wxlogger/wxlogger.sqlite"
Environment="WXLOGGER_PORT=3001"
ExecStart=/usr/bin/node $(pwd)/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

#### 7. Enable and Start Services

```bash
# Enable services to start on boot
sudo systemctl enable wxlogger
sudo systemctl enable weather-api

# Start services
sudo systemctl start wxlogger
sudo systemctl start weather-api

# Check status
sudo systemctl status wxlogger
sudo systemctl status weather-api
```

#### 8. Flash ESP8266 Weather Station

1. Install Arduino IDE and required libraries:
  - ESP8266 Board Support
  - PubSubClient
  - Adafruit AHTX0
  - Adafruit BMP085 (compatible with BMP180)

2. Edit `nodeMCU_wSensors.ino`:
   ```cpp
   static const char* STATION_ID = "basement_outdoor_esp8266";  // Your station name
   static const char* WIFI_SSID = "YOUR_WIFI_SSID";
   static const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
   static const char* MQTT_HOST = "192.168.1.171";  // Your Pi IP
   static const char* MQTT_PASS = "YOUR_MQTT_PASSWORD";
   static const float ALT_M = 275.3f;  // Your altitude in meters
   ```

3. Flash to NodeMCU and verify in Serial Monitor

#### 9. Access Dashboard

Open browser to: `http://your-pi-ip:3001`

## 📊 Database Schema

The wxlogger creates a SQLite database with multiple tables. The API primarily uses `telemetry_raw`:

```sql
CREATE TABLE telemetry_raw (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id   TEXT NOT NULL,
  ts_ms        INTEGER NOT NULL,         -- Unix timestamp (milliseconds)
  ts_recv_ms   INTEGER NOT NULL,         -- Receive timestamp
  boot_id      INTEGER,                  -- ESP boot session ID
  seq          INTEGER,                  -- Sequence number within boot
  
  -- Environmental measurements
  t_c          REAL,                     -- Temperature (Celsius)
  rh           REAL,                     -- Relative humidity (%)
  p_sta_pa     REAL,                     -- Station pressure (Pascals)
  p_slp_pa     REAL,                     -- Sea-level pressure (Pascals)
  
  -- Quality indicators
  q_ntp        INTEGER,                  -- NTP sync valid (1/0)
  q_aht        INTEGER,                  -- AHTx0 sensor working (1/0)
  q_bmp        INTEGER,                  -- BMP180 sensor working (1/0)
  rssi_dbm     INTEGER,                  -- WiFi signal strength (dBm)
  
  payload_json TEXT NOT NULL
);

-- Performance indexes
CREATE INDEX idx_tele_station_ts ON telemetry_raw(station_id, ts_ms);
CREATE UNIQUE INDEX uq_tele_station_boot_seq 
  ON telemetry_raw(station_id, boot_id, seq);
```

## 🔌 API Endpoints

### Get Latest Reading
```http
GET /api/weather/latest?station_id=basement_outdoor_esp8266
```

**Response:**
```json
{
  "ts_ms": 1706745600000,
  "ts_recv_ms": 1706745601000,
  "station_id": "basement_outdoor_esp8266",
  "metrics": {
    "t_c": 22.5,
    "rh": 65.0,
    "p_slp_pa": 101325,
    "p_sta_pa": 100800,
    "rssi_dbm": -45
  }
}
```

### Get Historical Data
```http
GET /api/weather/range?from_ms=1706659200000&to_ms=1706745600000&limit=1000
```

### Get Temperature Extremes
```http
GET /api/weather/extremes?from_ms=1706659200000&to_ms=1706745600000
```

### Download CSV
```http
GET /api/weather.csv?from_ms=1706659200000&to_ms=1706745600000
```

### Health Check
```http
GET /health
```

## ⚙️ Configuration

### Environment Variables

All components use the `WXLOGGER_` prefix for consistency:

| Variable | Component | Description | Default |
|----------|-----------|-------------|---------|
| `WXLOGGER_DB_PATH` | logger, API | SQLite database path | `/var/lib/wxlogger/wxlogger.sqlite` |
| `WXLOGGER_PORT` | API | HTTP server port | `3001` |
| `WXLOGGER_MQTT_HOST` | logger | MQTT broker address | `192.168.1.171` |
| `WXLOGGER_MQTT_PORT` | logger | MQTT broker port | `1883` |
| `WXLOGGER_MQTT_USER` | logger | MQTT username | `espuser` |
| `WXLOGGER_MQTT_PASS` | logger | MQTT password | (required) |

### ESP8266 Configuration

Edit these constants in `nodeMCU_wSensors.ino`:

```cpp
// Station identity
static const char* STATION_ID = "basement_outdoor_esp8266";

// WiFi credentials
static const char* WIFI_SSID = "YOUR_WIFI_SSID";
static const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// MQTT broker
static const char* MQTT_HOST = "192.168.1.171";  // Raspberry Pi IP
static const uint16_t MQTT_PORT = 1883;
static const char* MQTT_USER = "espuser";
static const char* MQTT_PASS = "YOUR_PASSWORD";

// Altitude for sea-level pressure correction
static const float ALT_M = 275.3f;  // Your elevation in meters

// Publish interval
static const unsigned long PUBLISH_INTERVAL_MS = 60UL * 1000UL;  // 60 seconds
```

### Frontend Configuration

Edit `app.js` to customize dashboard behavior:

```javascript
const DEFAULTS = {
  unit: "F",              // Default temperature unit (F or C)
  range: "3h",            // Default time range
  latestPollMs: 15000,    // Auto-refresh interval (15 seconds)
  requestTimeoutMs: 8000, // API request timeout
  maxTableRows: 50,       // Rows shown in table (visual limit)
  maxRangeLimit: 50000    // Maximum data points to fetch from API
};
```

## 🔧 Hardware Setup

### Bill of Materials

- **NodeMCU v3** (ESP8266) - $5-10
- **AHTx0 Sensor** (AHT10/AHT20/AHT21) - Temperature & Humidity - $5
- **BMP180 Sensor** - Barometric Pressure - $3
- **Jumper Wires** - $2
- **Enclosure** - Weather-resistant box - $10-20
- **USB Power Supply** - 5V/1A - $5

**Total:** ~$30-45

### Wiring Diagram

```
NodeMCU v3          AHTx0           BMP180
-----------         -----           ------
3.3V    ----------- VCC  ----------- VIN
GND     ----------- GND  ----------- GND
D2(GPIO4/SDA) ----- SDA  ----------- SDA
D1(GPIO5/SCL) ----- SCL  ----------- SCL
```

### Sensor Notes

- **AHTx0**: I2C address 0x38
- **BMP180**: I2C address 0x77
- Both sensors share the same I2C bus
- 3.3V power is sufficient for both
- Keep I2C wires short (<15cm) for reliability

## 🎨 Customization

### Theme Colors

Edit `styles.css` CSS custom properties:

```css
:root {
  --bg: #0b0c10;       /* Page background */
  --card: #12141b;     /* Card backgrounds */
  --text: #e8eaf0;     /* Primary text */
  --muted: #a8afc2;    /* Secondary text */
  /* ... more colors */
}
```

### Adding Metrics

The system is designed to be extensible. To add new sensors:

1. **ESP8266 Code**: Add sensor reading to `readSensorsOnce()` and include in telemetry JSON
2. **Database**: wxlogger will store it in `payload_json` automatically
3. **API**: Optionally add new field to API response
4. **Frontend**: Add metric card to HTML and update JavaScript to display it

### Multiple Stations

The system supports multiple weather stations:

1. Flash additional ESP8266s with different `STATION_ID` values
2. They'll all publish to the same MQTT broker
3. wxlogger automatically creates entries in the `station` table
4. Use `?station_id=<id>` query parameter to filter API results
5. Future: Add station selector to web UI

## 🐛 Troubleshooting

### Check Service Status

```bash
# View logs
sudo journalctl -u wxlogger -f
sudo journalctl -u weather-api -f

# Check if services are running
sudo systemctl status wxlogger
sudo systemctl status weather-api
sudo systemctl status mosquitto
```

### ESP8266 Not Connecting

1. **Check Serial Monitor** - Look for connection errors
2. **Verify WiFi credentials** - SSID and password correct?
3. **Check MQTT broker** - Is Mosquitto running? `sudo systemctl status mosquitto`
4. **Test MQTT manually**:
   ```bash
   mosquitto_pub -h localhost -t "test" -m "hello" -u espuser -P "YOUR_PASSWORD"
   ```

### No Data in Dashboard

1. **Check database exists**:
   ```bash
   ls -la /var/lib/wxlogger/wxlogger.sqlite
   ```

2. **Verify data is being logged**:
   ```bash
   sqlite3 /var/lib/wxlogger/wxlogger.sqlite "SELECT COUNT(*) FROM telemetry_raw;"
   ```

3. **Check API health**:
   ```bash
   curl http://localhost:3001/health
   ```

4. **Test MQTT subscription**:
   ```bash
   mosquitto_sub -h localhost -t "wx/#" -u espuser -P "YOUR_PASSWORD" -v
   ```

### Database Permissions Issues

```bash
# Ensure correct ownership
sudo chown -R $USER:$USER /var/lib/wxlogger
sudo chmod 755 /var/lib/wxlogger
sudo chmod 644 /var/lib/wxlogger/wxlogger.sqlite
```

### NTP Sync Failing on ESP8266

- Ensure ESP8266 has internet access (not just local network)
- Check firewall isn't blocking NTP (UDP port 123)
- NTP sync can take 15-30 seconds on first boot
- Look for `q.ntp: 1` in telemetry payload when synced

## 📁 Project Structure

```
weather-dashboard/
├── public/                  # Frontend files (served by Express)
│   ├── index.html          # Main HTML page
│   ├── styles.css          # Styling and theme
│   └── app.js              # Client-side JavaScript
├── server.js               # API server (Node.js/Express)
├── wxlogger.py             # MQTT→SQLite data logger (Python)
├── nodeMCU_wSensors.ino    # ESP8266 firmware (Arduino)
├── package.json            # Node dependencies
├── README.md               # This file
└── TROUBLESHOOTING.md      # Additional help
```

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License.

## 🙏 Acknowledgments

- Built for the maker community
- Inspired by DIY weather station enthusiasts
- Optimized for Raspberry Pi + ESP8266 deployments

## 💬 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/weather-dashboard/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/weather-dashboard/discussions)

## 🗺️ Roadmap

- [ ] Multi-station dashboard view with station selector
- [ ] Weather alerts and notifications (email/SMS)
- [ ] Wind speed and direction support
- [ ] Rainfall tracking with tipping bucket
- [ ] Mobile app (React Native)
- [ ] Integration with Home Assistant
- [ ] Weather Underground upload
- [ ] Graph export (PNG/SVG)
- [ ] Solar panel voltage/current monitoring

---

**Made with ☕ for hyperlocal weather nerds**