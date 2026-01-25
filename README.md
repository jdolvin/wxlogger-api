# 🌦️ Local Weather Dashboard & Telemetry API

This project is a locally hosted weather monitoring system and dashboard built to collect, process, and visualize environmental data from custom hardware sensors deployed around my home.

It combines:
- Embedded systems (ESP8266 microcontrollers)
- MQTT-based telemetry
- A Raspberry Pi data pipeline
- A Node.js + SQLite backend API
- A mobile-first web UI for live weather viewing

The goal is simple:  
**own my data, understand my environment, and build a real system that solves a real problem.**

---

## 📡 System Overview

### Hardware Layer
Custom weather and environmental sensors are built using:

- ESP8266 microcontrollers
- Temperature, humidity, and pressure sensors (AHT + BMP series)
- WiFi connectivity

Each sensor node publishes telemetry over MQTT at regular intervals.

These devices were designed, assembled, and deployed by me, including 3D-printed enclosures and mounting solutions (documented separately).

---

### Data Pipeline (Raspberry Pi)

A Raspberry Pi acts as the central hub:

1. Receives MQTT telemetry from all sensor nodes
2. Normalizes and validates incoming data
3. Stores raw telemetry in a local SQLite database
4. Preserves the original JSON payload for debugging and future expansion

This allows:
- Reliable long-term storage
- Offline operation (no cloud dependency)
- Full control over the data format and retention

---

## 🧠 Backend API (Node.js)

The backend is a lightweight local API built with Node.js and Express.

It exposes weather data in multiple formats for both humans and machines:

### Endpoints include:

- `GET /api/weather/latest`  
  Returns the most recent sensor reading

- `GET /api/weather/range`  
  Returns historical data over a selected time window

- `GET /api/weather.csv`  
  CSV export for spreadsheets and analysis

- `GET /health`  
  System health and database connectivity check
- 
---

## 📱 Frontend Web Dashboard

The web interface is designed for **mobile-first use**, primarily on iPhones and tablets within the local network.

Features include:

- Live temperature display (°F / °C toggle)
- Humidity and sea-level pressure
- Pressure trend indicators (inHg with arrows)
- Dew point calculation
- “Feels like” temperature calculation
- Historical range selection (1h, 3h, 6h, 12h, 24h, 7d)
- Trend sparkline graph
- CSV export for selected time range
- Graceful error handling when sensors or network are unavailable

No frontend frameworks are used—this is plain HTML, CSS, and JavaScript to keep the system lightweight and easy to deploy on constrained hardware.

---

## 🌡️ Derived Metrics

The dashboard computes several values in real time from raw sensor data:

- **Dew Point** (Magnus formula)
- **Feels Like / Apparent Temperature**
    - Heat Index when hot and humid
    - Apparent temperature approximation otherwise
- **Pressure trend** over selected time windows
- Temperature conversion (°C ↔ °F)

---

## 🧩 Why This Exists
- I wanted reliable local weather data for my home
- I didn’t want to rely on cloud services
- I wanted to build a complete end-to-end system:
    - hardware → network → database → API → UI
- I wanted something my household could actually use daily

It also serves as a personal engineering lab for:
- IoT telemetry
- time-series data handling
- mobile-first UI design
- Raspberry Pi deployment
- system reliability and fault tolerance

---

## 🛠️ Technologies Used

- **ESP8266 microcontrollers**
- **MQTT**
- **Raspberry Pi (Linux)**
- **SQLite**
- **Node.js / Express**
- **HTML / CSS / Vanilla JavaScript**
- **Git & GitHub**
- **3D printing for sensor enclosures (documented separately)**

---

## 🚀 Future Work

Planned additions include:

- Documentation of 3D printed weather station enclosures
- Documentation/repo for the Arduino code feeding the data lake.
- Station selector for multiple sensor nodes
- Wind speed and wind chill support
- Light/dark theme support
- Long-term trend visualization
- Alerting (rapid pressure drops, extreme temps)
- Home Assistant integration

## 📜 License

Internal / personal project.  
Open to adaptation for educational and personal use.