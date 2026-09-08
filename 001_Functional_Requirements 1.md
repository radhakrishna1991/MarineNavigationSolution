# Build an iSpatialTec Assured Marine Navigation System

## 1. Role

Act as a senior full-stack software architect, maritime navigation engineer, resilient PNT specialist, geospatial developer, sensor-fusion engineer, cybersecurity engineer, test engineer, and UI/UX designer.

Build a working software for **iSpatialTec Assured Marine Navigation Platform**, intended to demonstrate resilient vessel positioning when GNSS/GPS is unavailable, jammed, spoofed, degraded, or inconsistent.

This is a **proof-of-concept and decision-support system**, not a certified navigation product.

The system must:

* treat GNSS as one potentially untrusted sensor;
* detect GNSS anomalies;
* reject unreliable GNSS data;
* estimate vessel position using available independent sources;
* support operation without INS;
* optionally accept INS data when available;
* estimate position uncertainty;
* calculate an integrity or protection level;
* clearly indicate whether the Safeen requirement of less than 2 m horizontal error is currently satisfied;
* provide a maritime operations dashboard;
* support simulated and recorded-data replay;
* log all sensor, integrity, mode, alarm, and operator events.


---

# 2. Business Context

Safeen requires a solution for hydrographic survey and marine operations in UAE waters when GNSS is unavailable or unreliable.

Safeen’s primary requirement is:

> Horizontal position error shall remain below 2.0 m within an approved operating area during a defined GNSS outage.

The current assumptions are:

* Safeen has general vector maps and ENC-like data.
* Safeen has bathymetric data with approximately 10 cm grid resolution in selected operating areas.
* Some vessels use Sonardyne equipment.
* Safeen is not fully satisfied with its current solution.
* Existing equipment may include:

  * GNSS receiver;
  * gyrocompass;
  * speed log;
  * DVL;
  * marine radar;
  * echo sounder;
  * multibeam sonar;
  * ECDIS;
  * AIS;
  * INS on some vessels;
  * survey acquisition systems.
* iSpatialTec should not build INS, radar, DVL, GNSS, or sonar hardware.
* iSpatialTec should build a vendor-neutral navigation intelligence, map-matching, integrity-monitoring, visualization, replay, and integration layer.

The system must demonstrate what iSpatialTec can offer without falsely claiming that less than 2 m accuracy is always guaranteed.

---

# 3. Core Product Concept

Create a software platform with the following logical flow:

```text
GNSS
Marine Radar
HD Radar
LiDAR
Gyrocompass
DVL
Speed Log
Echo Sounder
Multibeam Sonar
INS, optional
AIS, advisory only
ENC / Vector Map
High-Resolution Bathymetric Map
Local Survey Control Points
Recorded Ground Truth

              |
              v

Data Ingestion and Time Synchronization

              |
              v

Sensor Validation and Quality Assessment

              |
              v

GNSS Spoofing, Jamming and Anomaly Detection

              |
              v

Independent Localization Engines

- Radar Map Matching
- Bathymetric Terrain Matching
- LiDAR Map Matching
- Dead Reckoning
- Optional INS Aiding
- Local Beacon / Control Point Positioning

              |
              v

Multi-Sensor Fusion

              |
              v

Fault Detection, Isolation and Exclusion

              |
              v

Position Uncertainty and Protection Level

              |
              v

Trusted Navigation Output

- Position
- Velocity
- Heading
- Time
- Integrity Status
- Estimated Error
- Protection Level
- Navigation Mode
- Sensor Trust Status
- Alerts
- Logs
```

---

# 4. system Objectives

The system must demonstrate the following use cases.

## 4.1 Normal GNSS Operation

* GNSS is healthy.
* GNSS agrees with independent sensors.
* The system uses GNSS as one input.
* The system displays:

  * trusted position;
  * GNSS trust score;
  * estimated horizontal error;
  * protection level;
  * active navigation mode;
  * contributing sensors.

## 4.2 GNSS Jamming

* GNSS signal quality degrades.
* Satellite count decreases.
* C/N0 values drop.
* Position becomes unavailable or unstable.
* The system detects likely jamming.
* GNSS is rejected.
* Navigation continues using non-GNSS sources.

## 4.3 GNSS Spoofing

Support at least these simulated spoofing patterns:

* sudden position jump;
* gradual position drag;
* false velocity;
* false course over ground;
* false time;
* position frozen while the vessel continues moving;
* GNSS position that looks smooth but disagrees with radar, bathymetry, DVL, or dead reckoning.

The system must:

* detect inconsistencies;
* reduce GNSS trust;
* isolate GNSS;
* raise an alarm;
* continue with independent positioning;
* record the reason for rejection.

## 4.4 GNSS Outage

* GNSS stops completely.
* The system transitions to a GNSS-denied mode.
* Position continues using:

  * radar localization;
  * LiDAR localization;
  * bathymetric matching;
  * DVL and gyro dead reckoning;
  * optional INS;
  * local positioning infrastructure, when simulated.

## 4.5 Radar Localization Loss

* Radar matching becomes unavailable or confidence falls.
* The system continues using remaining sensors.
* Estimated uncertainty increases.
* The system raises a warning when the 2 m requirement is at risk.

## 4.6 Bathymetric Ambiguity

* The vessel operates over flat or repetitive seabed.
* Bathymetric matching produces multiple possible locations.
* The system must not present a false high-confidence position.
* Bathymetric confidence must decrease.
* The fusion engine must reject or down-weight ambiguous fixes.

## 4.7 Sensor Failure

Simulate:

* gyro heading bias;
* frozen DVL velocity;
* speed-log scale error;
* echo-sounder depth offset;
* stale radar data;
* delayed sensor messages;
* duplicate messages;
* out-of-order timestamps;
* noisy measurements;
* INS drift, when INS is enabled.

## 4.8 GNSS Recovery

When GNSS returns:

* do not immediately trust it;
* compare it with the trusted fused solution;
* validate consistency over a configurable period;
* restore GNSS gradually;
* log reintegration;
* display a recovery status.

---

# 5. Required Navigation Modes

Implement an explicit state machine with the following modes:

1. `NORMAL_GNSS`
2. `GNSS_DEGRADED`
3. `SPOOFING_SUSPECTED`
4. `JAMMING_SUSPECTED`
5. `GNSS_REJECTED`
6. `RADAR_AIDED_NAVIGATION`
7. `BATHYMETRIC_AIDED_NAVIGATION`
8. `LIDAR_AIDED_NAVIGATION`
9. `DEAD_RECKONING`
10. `INS_AIDED_NAVIGATION`
11. `LOCAL_POSITIONING_MODE`
12. `MANUAL_FALLBACK`
13. `GNSS_RECOVERY_VALIDATION`
14. `INTEGRITY_NOT_ASSURED`

For every mode define:

* entry conditions;
* active sensors;
* rejected sensors;
* expected accuracy;
* estimated uncertainty behaviour;
* operator alarm;
* operator guidance;
* exit conditions;
* next valid modes.

Implement the mode logic in a configuration-driven state machine rather than hard-coding all transitions in UI components.

---

# 6. Safeen Less-Than-2-Metre Requirement

The system must continuously determine whether the less-than-2-metre requirement is currently satisfied.

Implement these metrics:

* estimated horizontal position error;
* horizontal protection level;
* 95% confidence radius;
* 99% confidence radius;
* current sensor geometry quality;
* current localization confidence;
* current navigation solution availability;
* current integrity status.

Display one of these statuses:

* `REQUIREMENT_MET`
* `REQUIREMENT_AT_RISK`
* `REQUIREMENT_NOT_MET`
* `INSUFFICIENT_INFORMATION`

Use the following default logic:

```text
REQUIREMENT_MET:
Horizontal protection level <= 2.0 m
AND at least one independent absolute positioning source is valid
AND no unresolved critical sensor inconsistency exists.

REQUIREMENT_AT_RISK:
Horizontal protection level > 1.5 m and <= 2.0 m
OR only one absolute source is available
OR uncertainty is increasing rapidly.

REQUIREMENT_NOT_MET:
Horizontal protection level > 2.0 m
OR integrity is not assured
OR the system is operating only on unbounded dead reckoning.

INSUFFICIENT_INFORMATION:
Required measurements are missing
OR time synchronization is invalid
OR map localization confidence is below threshold.
```

Make all thresholds configurable.

Never display a green “less than 2 m” indication based only on average accuracy.

---

# 7. Sensor Inputs

Create a standardized internal sensor message format.

Each measurement must contain:

```json
{
  "sensor_id": "string",
  "sensor_type": "GNSS",
  "timestamp_utc": "ISO-8601",
  "sequence_number": 1,
  "position": {
    "latitude": 24.0,
    "longitude": 54.0,
    "altitude_m": 0.0
  },
  "velocity": {
    "north_mps": 0.0,
    "east_mps": 0.0,
    "down_mps": 0.0
  },
  "heading_deg": 0.0,
  "depth_m": 0.0,
  "quality": {},
  "raw": {},
  "valid": true
}
```

Support simulated adapters for:

* GNSS;
* gyrocompass;
* DVL;
* speed log;
* radar localization;
* LiDAR localization;
* echo sounder;
* multibeam bathymetric matching;
* INS;
* local ranging system;
* ground-truth reference.

Create a generic adapter interface so real NMEA or IEC 61162 adapters can be added later.

---

# 8. Data Protocols and Future Integration

The system must include interface placeholders for:

* NMEA 0183;
* NMEA 2000;
* IEC 61162-1;
* IEC 61162-450;
* UDP;
* TCP;
* WebSocket;
* REST;
* MQTT;
* CSV replay;
* JSON replay;
* ROS bag import placeholder;
* PCAP import placeholder.

Implement working support for:

* CSV;
* JSON;
* WebSocket;
* REST ingestion;
* simulated UDP input.

Do not implement direct output to:

* autopilot;
* DP controller;
* propulsion system;
* steering gear.

Provide a read-only “trusted output” API for demonstration.

---

# 9. GNSS Integrity and Anomaly Detection

Implement a rule-based system GNSS trust engine.

Inputs may include:

* number of satellites;
* HDOP;
* VDOP;
* PDOP;
* C/N0;
* fix type;
* reported accuracy;
* clock bias;
* position innovation;
* velocity innovation;
* heading disagreement;
* time disagreement;
* consistency with radar localization;
* consistency with LiDAR localization;
* consistency with bathymetric localization;
* consistency with DVL and gyro prediction;
* rate of position change;
* rate of acceleration;
* geographic plausibility;
* map constraint violations.

Implement detection for:

* excessive position jump;
* gradual drag;
* improbable acceleration;
* impossible vessel speed;
* impossible turn rate;
* GNSS position outside allowed water polygon;
* GNSS position crossing land;
* disagreement with independent absolute localization;
* GNSS time jump;
* stale GNSS timestamp;
* frozen coordinates;
* degraded signal metrics;
* sudden multi-satellite signal-strength reduction.

Return:

```json
{
  "trust_score": 0.0,
  "status": "REJECTED",
  "detected_conditions": [
    "GRADUAL_POSITION_DRAG",
    "RADAR_POSITION_DISAGREEMENT"
  ],
  "recommended_action": "EXCLUDE_FROM_FUSION"
}
```

Trust score range:

* 0 to 20: rejected;
* 21 to 50: highly suspect;
* 51 to 75: degraded;
* 76 to 90: acceptable;
* 91 to 100: trusted.

Make thresholds configurable.

---

# 10. Localization Engines

Implement simplified but functioning system engines.

## 10.1 Radar Map-Matching Engine

For the system, do not process raw radar video unless practical.

Create two modes:

### Mode A: Simulated Radar Fix

Input:

* radar-derived position;
* covariance;
* match score;
* number of matched features;
* map age;
* sensor status.

### Mode B: Simplified Point-Cloud Map Matching

Input:

* 2D radar-like point cloud;
* stored reference point cloud;
* initial position estimate.

Use a simplified ICP or scan-matching implementation.

Output:

* latitude;
* longitude;
* heading correction;
* covariance;
* match confidence;
* residual;
* number of inliers;
* validity.

## 10.2 LiDAR Localization Engine

Use the same generic point-cloud matching abstraction.

Output:

* absolute or map-relative position;
* covariance;
* confidence;
* match quality;
* environment feature score.

## 10.3 Bathymetric Terrain-Matching Engine

Inputs:

* vessel depth measurements;
* optional multibeam depth profile;
* vessel heading;
* vessel velocity;
* bathymetric raster;
* tide correction;
* draft;
* squat estimate;
* sounder offset;
* prior position region.

Implement a system particle-filter or grid-search method.

At minimum:

1. Search candidate positions around the predicted location.
2. Compare observed depth sequence with map depth.
3. Calculate residuals.
4. Generate candidate likelihoods.
5. Detect multi-modal ambiguity.
6. Return:

   * best candidate;
   * covariance;
   * confidence;
   * ambiguity score;
   * terrain observability score.

Do not assume 10 cm bathymetric grid resolution equals 10 cm positioning accuracy.

## 10.4 Dead-Reckoning Engine

Inputs:

* last trusted position;
* gyro heading;
* DVL velocity;
* speed-log velocity;
* optional INS velocity;
* timestamp.

Implement:

* geodetic position propagation;
* configurable velocity scale error;
* heading bias;
* uncertainty growth;
* elapsed-time tracking;
* bottom-lock status.

The uncertainty must grow over time when no absolute update exists.

## 10.5 Optional INS Adapter

INS must be optional.

The system must operate when no INS messages exist.

When INS is present, use it for:

* high-rate motion propagation;
* attitude;
* velocity;
* heave;
* short-term continuity.

Do not allow the system to treat INS as drift-free.

INS uncertainty must grow when not externally aided.

## 10.6 Local Positioning Engine

Create simulated support for:

* UWB;
* Locata-like terrestrial ranging;
* local radio beacons;
* total-station observations;
* acoustic LBL/USBL fixes.

Return an absolute position and covariance.

---

# 11. Sensor Fusion

Implement a modular fusion engine.

Preferred initial method:

* Extended Kalman Filter.

Optional advanced method:

* Unscented Kalman Filter or factor graph as an experimental module.

State vector should include at minimum:

```text
latitude or local X
longitude or local Y
velocity north
velocity east
heading
gyro bias
speed scale factor
position uncertainty
```

Use a local East-North-Up coordinate frame for filtering and convert to WGS84 for display.

Fusion requirements:

* asynchronous sensor updates;
* configurable measurement covariance;
* measurement gating;
* innovation checks;
* residual monitoring;
* sensor exclusion;
* sensor re-entry;
* covariance propagation;
* sensor source attribution;
* solution confidence calculation.

For every fused position, record which sensors contributed.

Example:

```json
{
  "position": {
    "latitude": 24.123,
    "longitude": 54.456
  },
  "velocity_mps": 2.4,
  "heading_deg": 82.3,
  "horizontal_protection_level_m": 1.4,
  "integrity_status": "ASSURED",
  "navigation_mode": "RADAR_AIDED_NAVIGATION",
  "contributing_sensors": [
    "RADAR_01",
    "GYRO_01",
    "DVL_01"
  ],
  "excluded_sensors": [
    "GNSS_01"
  ]
}
```

---

# 12. Fault Detection, Isolation and Exclusion

Implement residual-based monitoring for every sensor.

Functions:

* compare predicted and measured values;
* normalize residuals;
* calculate innovation statistics;
* identify inconsistent sensors;
* isolate probable faulty sensor;
* exclude it from fusion;
* generate alarm;
* allow controlled reintegration.

Fault categories:

* stale data;
* missing data;
* excessive noise;
* bias;
* frozen value;
* scale error;
* timestamp error;
* impossible rate;
* disagreement with independent sources;
* map mismatch;
* loss of bottom lock;
* invalid quality flags.

Provide a human-readable explanation.

Example:

```text
GNSS excluded because the reported position differs from radar localization by 38.4 m and is moving east while DVL and gyro indicate north-east motion.
```

---

# 13. Integrity Monitoring

Implement a System integrity engine separate from the fusion engine.

It must calculate:

* horizontal protection level;
* vertical protection level placeholder;
* estimated position error;
* confidence ellipse;
* solution age;
* time since last absolute fix;
* number of independent absolute sources;
* sensor diversity score;
* fault-detection status;
* requirement compliance.

Integrity states:

* `ASSURED`
* `DEGRADED`
* `NOT_ASSURED`
* `UNKNOWN`

The engine must distinguish:

* accuracy;
* precision;
* confidence;
* integrity;
* availability;
* continuity.

Do not use these terms interchangeably.

---

# 14. Maps and Geospatial Data

Use an interactive web map.

Preferred options:

* MapLibre GL JS;
* OpenLayers;
* Leaflet only if advanced layers are not required.

The map must support:

* vessel position;
* GNSS position;
* fused trusted position;
* radar position;
* LiDAR position;
* bathymetric position;
* INS/dead-reckoning position;
* ground truth;
* position history trails;
* confidence ellipse;
* 2 m protection circle;
* approved operating polygon;
* no-go areas;
* land polygons;
* shoreline;
* vector chart-like overlays;
* bathymetry raster;
* depth contours;
* radar map features;
* local control points;
* alarm locations.

Use synthetic GeoJSON and raster data for the System.

Create a sample UAE-like harbour environment but do not represent it as an official navigational chart.

Add a clear label:

> Demonstration geospatial data — not for navigation.

---

# 15. Dashboard Requirements

Create a professional maritime operations dashboard.

## 15.1 Main Navigation Screen

Display:

* interactive map;
* trusted vessel position;
* current heading;
* speed;
* active navigation mode;
* GNSS status;
* system integrity;
* estimated horizontal error;
* horizontal protection level;
* Safeen 2 m requirement status;
* active sensor list;
* rejected sensor list;
* current alarms;
* current simulation time.

## 15.2 Sensor Health Panel

For each sensor display:

* sensor name;
* sensor type;
* online/offline;
* last update;
* update frequency;
* trust score;
* measurement quality;
* residual;
* accepted/rejected;
* reason;
* data age.

Use a sortable table.

## 15.3 GNSS Integrity Panel

Display:

* GNSS trust score;
* satellites;
* HDOP;
* C/N0 trend;
* fix type;
* reported accuracy;
* detected attack or anomaly;
* difference from fused position;
* difference from radar;
* difference from bathymetric fix;
* time consistency;
* current decision.

## 15.4 Fusion and Integrity Panel

Display:

* contributing sensors;
* filter covariance;
* confidence ellipse;
* estimated horizontal error;
* protection level;
* sensor diversity score;
* last absolute position fix;
* dead-reckoning duration;
* uncertainty growth rate.

## 15.5 Alarm Panel

Alarm severity:

* INFO;
* ADVISORY;
* WARNING;
* CRITICAL.

Support:

* acknowledge;
* filter;
* search;
* export;
* timestamp;
* source;
* reason;
* recommended operator action.

## 15.6 Replay and Scenario Panel

Controls:

* scenario selection;
* play;
* pause;
* stop;
* step forward;
* speed 0.5x, 1x, 2x, 5x, 10x;
* jump to event;
* inject fault;
* remove fault;
* reset;
* compare trusted solution against ground truth.

## 15.7 Performance Analytics Screen

Display:

* horizontal error over time;
* 95th percentile error;
* 99th percentile error;
* maximum error;
* protection level over time;
* GNSS trust over time;
* sensor availability;
* navigation mode timeline;
* requirement compliance percentage;
* alarm timeline;
* time to detect spoofing;
* time to reject GNSS;
* time to recover;
* time spent below 2 m;
* time spent above 2 m.

Use separate charts rather than overcrowded combined charts.

---

# 16. Simulation Engine

Build a deterministic vessel simulation. and create enough mockup data in database to simulate all possible scenarios.

Create a sample vessel route through:

1. open approach area;
2. channel;
3. harbour entrance;
4. quay area;
5. survey polygon;
6. feature-poor zone;
7. return route.

Generate ground-truth:

* position;
* speed;
* heading;
* turn rate;
* depth.

Generate simulated sensor streams with configurable:

* frequency;
* noise;
* bias;
* latency;
* dropout;
* drift;
* failure time;
* recovery time.

Default frequencies:

* GNSS: 5 Hz;
* gyro: 20 Hz;
* DVL: 10 Hz;
* speed log: 5 Hz;
* radar localization: 2 Hz;
* LiDAR localization: 5 Hz;
* echo sounder: 10 Hz;
* bathymetric match: 1 Hz;
* INS: 50 Hz, optional;
* integrity output: 5 Hz.

Create at least these scenarios:

### Scenario 1: Healthy Navigation

All sensors nominal.

### Scenario 2: GNSS Sudden Jump

GNSS jumps 50 m east.

### Scenario 3: Gradual Spoofing Drag

GNSS is dragged 1 m every 10 seconds until reaching 40 m error.

### Scenario 4: GNSS Jamming

GNSS quality degrades and then becomes unavailable.

### Scenario 5: Flat Seabed

Bathymetric localization becomes ambiguous.

### Scenario 6: Radar Feature Loss

Radar localization confidence drops in open water.

### Scenario 7: DVL Bottom-Lock Loss

DVL becomes invalid.

### Scenario 8: Gyro Bias

Heading bias increases gradually.

### Scenario 9: GNSS Recovery

GNSS returns but is validated for 30 seconds before reintegration.

### Scenario 10: Multiple Sensor Failure

GNSS rejected, radar unavailable, and DVL degraded.

The final scenario should demonstrate that the system correctly reports that the 2 m requirement is no longer assured.

---

# 17. System Technology Stack

Use a maintainable monorepo.

Recommended stack:

## Frontend

* React;
* TypeScript;
* Vite.js;
* MapLibre GL JS;
* Tailwind CSS;
* accessible component library;
* charting library such as ECharts;
* WebSocket client;
* state management using Redux Toolkit.

## Backend

* nodejs;
* expressjs;
* WebSocket;
* PostgreSQL for database;


## Testing
* backend unit and integration tests;
* React Testing Library;


## Deployment

* Docker;
* Docker Compose;
* environment-based configuration;
* local development instructions;
* no cloud dependency required.

Avoid unnecessary microservices. Use a modular monolith for the system.

---

# 18. Suggested Repository Structure

```text
assured-marine-navigation/
│
├── README.md
├── docker-compose.yml
├── .env.example
├── docs/
│   ├── architecture.md
│   ├── assumptions.md
│   ├── limitations.md
│   ├── api.md
│   ├── safety.md
│   ├── test-plan.md
│   └── demo-script.md
│
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── config/
│   │   ├── api/
│   │   ├── models/
│   │   ├── ingestion/
│   │   ├── adapters/
│   │   ├── simulation/
│   │   ├── navigation/
│   │   │   ├── fusion/
│   │   │   ├── dead_reckoning/
│   │   │   ├── radar_matching/
│   │   │   ├── lidar_matching/
│   │   │   ├── bathymetric_matching/
│   │   │   ├── gnss_integrity/
│   │   │   ├── fault_detection/
│   │   │   ├── integrity/
│   │   │   └── mode_manager/
│   │   ├── geospatial/
│   │   ├── logging/
│   │   ├── replay/
│   │   ├── storage/
│   │   └── utils/
│   ├── tests/
│   ├── requirements.txt
│   └── Dockerfile
│
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── map/
│   │   ├── charts/
│   │   ├── alarms/
│   │   ├── sensors/
│   │   ├── replay/
│   │   ├── api/
│   │   ├── store/
│   │   ├── types/
│   │   └── utils/
│   ├── tests/
│   ├── package.json
│   └── Dockerfile
│
├── data/
│   ├── scenarios/
│   ├── bathymetry/
│   ├── geojson/
│   ├── radar_maps/
│   ├── lidar_maps/
│   └── replay/
│
└── scripts/
    ├── generate_demo_data.py
    ├── run_scenario.py
    ├── export_results.py
    └── seed_database.py
```

---

# 19. Backend APIs

Implement at least these endpoints.

```text
GET  /api/health
GET  /api/system/status
GET  /api/navigation/current
GET  /api/navigation/history
GET  /api/sensors
GET  /api/sensors/{sensor_id}
GET  /api/alarms
POST /api/alarms/{alarm_id}/acknowledge
GET  /api/scenarios
POST /api/scenarios/{scenario_id}/start
POST /api/scenarios/pause
POST /api/scenarios/resume
POST /api/scenarios/stop
POST /api/scenarios/reset
POST /api/scenarios/inject-fault
POST /api/scenarios/remove-fault
GET  /api/performance/summary
GET  /api/performance/timeseries
GET  /api/config
PUT  /api/config
POST /api/data/upload
GET  /api/replay/sessions
POST /api/replay/{session_id}/start
WS   /ws/live
```

The WebSocket should stream:

* sensor updates;
* trusted navigation solution;
* alarms;
* mode transitions;
* integrity status;
* scenario time.

---

# 20. Configuration

Provide YAML or JSON configuration for:

* sensor definitions;
* update rates;
* measurement noise;
* rejection thresholds;
* GNSS trust thresholds;
* fusion covariances;
* navigation mode transitions;
* 2 m requirement threshold;
* alarm thresholds;
* GNSS recovery validation time;
* map data paths;
* operating polygons;
* simulation scenarios.

Example:

```yaml
requirements:
  horizontal_error_limit_m: 2.0
  confidence_level: 0.95
  alarm_time_s: 2.0

gnss_integrity:
  reject_score_below: 20
  degraded_score_below: 75
  max_position_innovation_m: 8.0
  max_velocity_innovation_mps: 2.0
  recovery_validation_s: 30

dead_reckoning:
  maximum_unassisted_duration_s: 120
  warning_protection_level_m: 1.5
  critical_protection_level_m: 2.0
```

---

# 21. Data Recording and Audit Trail

Record:

* raw sensor messages;
* normalized sensor messages;
* sensor quality;
* trust scores;
* residuals;
* fusion decisions;
* excluded measurements;
* position solutions;
* uncertainties;
* protection levels;
* mode transitions;
* alarms;
* operator acknowledgements;
* configuration changes;
* scenario events.

Logs must be immutable from the UI.

Provide export to:

* CSV;
* JSON;
* GeoJSON;
* PDF report placeholder;
* KML optional.

---

# 22. Cybersecurity Requirements

For the System implement:

* role-based access:

  * viewer;
  * operator;
  * engineer;
  * administrator;
* authentication placeholder;
* input validation;
* schema validation;
* timestamp validation;
* message size limits;
* rate limiting;
* audit logging;
* no arbitrary code execution;
* secure configuration handling;
* no credentials in source code;
* dependency pinning;
* Docker non-root user;
* basic security headers;
* separation between sensor ingestion and UI access;
* read-only trusted output API by default.

Document future requirements for:

* secure boot;
* signed firmware;
* signed software releases;
* mTLS;
* certificate management;
* network segmentation;
* IEC 62443 alignment;
* classification-society review;
* vulnerability management;
* incident response.

---

# 23. Safety Requirements

Display these warnings where required:

The software must fail safely.

When confidence is insufficient:

* do not continue displaying a green assured status;
* display `INTEGRITY NOT ASSURED`;
* display the increasing uncertainty;
* identify the missing or faulty sensors;
* recommend manual verification;
* preserve operator access to raw sensor values.

Never fabricate a trusted position when observability is insufficient.

---

# 24. Test Requirements

Create automated tests for:

## GNSS Integrity

* sudden position jump detected;
* gradual drag detected;
* frozen GNSS detected;
* degraded C/N0 detected;
* false time detected;
* healthy GNSS not falsely rejected.

## Fusion

* radar update corrects dead reckoning;
* bathymetric update is rejected when ambiguous;
* sensor covariance affects weighting;
* stale measurement rejected;
* outlier gating works;
* GNSS can be excluded and later reintegrated.

## Integrity

* protection level grows during dead reckoning;
* requirement changes from met to at risk;
* requirement changes from at risk to not met;
* no green status without an independent absolute position source;
* mode changes are logged.

## Replay

* scenario is deterministic;
* pause and resume work;
* playback speed changes;
* fault injection is repeatable.

## UI

* map loads;
* position updates;
* alarms appear;
* sensor table updates;
* 2 m requirement status changes correctly;
* replay controls work;
* critical warning remains visible.

---

# 25. System Acceptance Criteria

The System is accepted when it demonstrates all of the following:

1. A simulated vessel moves through a mapped UAE-like harbour environment.
2. Ground truth is generated and recorded.
3. GNSS, gyro, DVL, radar, bathymetric, and optional INS streams are generated.
4. Healthy GNSS is accepted.
5. A sudden GNSS jump is detected and GNSS is rejected.
6. Gradual spoofing drag is detected before reaching 20 m error.
7. Navigation continues using radar, gyro, and DVL.
8. The dashboard shows the trusted fused position separately from GNSS.
9. The system calculates uncertainty and horizontal protection level.
10. The dashboard clearly shows whether the 2 m requirement is met.
11. During radar loss, uncertainty grows.
12. When protection level exceeds 2 m, the system declares that integrity is not assured.
13. Bathymetric ambiguity is detected rather than hidden.
14. GNSS is not immediately trusted when it returns.
15. GNSS is reintegrated only after a validation period.
16. Every exclusion, alarm, transition, and reintegration event is logged.
17. A performance report compares the fused position against ground truth.
18. The full system runs locally using Docker Compose.
19. Automated tests pass.
20. Setup and demo instructions are complete.

---

# 26. Performance Report

At the end of every scenario generate:

* scenario name;
* start and end time;
* total duration;
* GNSS outage duration;
* mean horizontal error;
* median horizontal error;
* RMS error;
* 95th percentile error;
* 99th percentile error;
* maximum error;
* percentage of time below 2 m;
* percentage of time integrity was assured;
* spoofing detection time;
* GNSS rejection time;
* false alarm count;
* time to GNSS recovery;
* sensor availability;
* mode duration;
* alarm count;
* requirement compliance result.

Add a clear distinction between:

* actual error measured against simulated ground truth;
* estimated error;
* protection level.

---

# 27. UI Design Direction

The interface should look like a professional maritime operations and navigation assurance system.

Design qualities:

* dark bridge-friendly interface;
* high contrast;
* minimal visual clutter;
* large status indicators;
* maritime terminology;
* clear alarm hierarchy;
* colour is not the only indicator;
* responsive layout;
* desktop-first;
* suitable for a large bridge monitor;
* no consumer-style decorative animation.

Main status banner example:

```text
TRUSTED NAVIGATION: AVAILABLE
MODE: RADAR-AIDED NAVIGATION
GNSS: REJECTED — GRADUAL SPOOFING DETECTED
HORIZONTAL PROTECTION LEVEL: 1.42 m
SAFEEN <2 m REQUIREMENT: MET
```

Critical status example:

```text
INTEGRITY NOT ASSURED
MODE: DEAD RECKONING
HORIZONTAL PROTECTION LEVEL: 3.75 m
SAFEEN <2 m REQUIREMENT: NOT MET
OPERATOR ACTION: VERIFY POSITION USING INDEPENDENT MEANS
```

---

# 28. Development Process

Follow this sequence:

## Stage 1: Architecture

* create architecture documentation;
* define data models;
* define state machine;
* define API contracts;
* define simulator structure;
* define assumptions and limitations.

## Stage 2: Skeleton Application

* create backend;
* create frontend;
* create Docker Compose;
* create health endpoints;
* create basic live dashboard.

## Stage 3: Simulation

* implement vessel ground truth;
* implement sensor simulators;
* implement scenarios;
* stream data through WebSocket.

## Stage 4: GNSS Integrity

* implement GNSS quality scoring;
* implement anomaly detection;
* add GNSS panel;
* add alarms.

## Stage 5: Navigation

* implement dead reckoning;
* implement simplified radar localization;
* implement bathymetric matching;
* implement optional INS adapter;
* implement EKF.

## Stage 6: Integrity

* implement residual monitoring;
* implement fault exclusion;
* implement protection-level calculation;
* implement requirement status.

## Stage 7: Analytics

* create performance charts;
* create scenario report;
* add data exports.

## Stage 8: Testing and Documentation

* automated tests;
* demo script;
* limitations;
* deployment guide;
* security notes;
* acceptance report.

Do not skip architecture and testing to create only a visual mock-up.

---

# 29. Required Deliverables

Deliver:

1. complete source code;
2. Docker Compose environment;
3. frontend dashboard;
4. backend services;
5. scenario simulator;
6. GNSS integrity engine;
7. dead-reckoning engine;
8. simplified radar localization;
9. simplified bathymetric matching;
10. optional INS adapter;
11. sensor-fusion engine;
12. integrity engine;
13. navigation-mode state machine;
14. performance analytics;
15. automated test suite;
16. sample data;
17. architecture documentation;
18. API documentation;
19. security documentation;
20. limitations documentation;
21. Safeen demonstration script;
22. future production roadmap.

---

# 30. Demonstration Script

Create a guided demonstration named:

`Safeen GNSS-Denied Survey Demonstration`

Sequence:

1. Start vessel with healthy GNSS.
2. Show GNSS agreeing with radar and DVL.
3. Confirm the 2 m requirement is met.
4. Activate gradual GNSS spoofing.
5. Show GNSS moving away from ground truth.
6. Show increasing residuals.
7. Show GNSS trust score decreasing.
8. Show spoofing alarm.
9. Show GNSS exclusion.
10. Continue navigation using radar, DVL, gyro, and bathymetry.
11. Show fused position remaining near ground truth.
12. Enter a feature-poor area.
13. Reduce radar confidence.
14. Make bathymetric terrain ambiguous.
15. Show uncertainty increasing.
16. Show requirement status changing to at risk.
17. Show protection level exceeding 2 m.
18. Show integrity not assured.
19. Restore radar features.
20. Show absolute position correction.
21. Restore GNSS.
22. Validate GNSS for 30 seconds.
23. Reintegrate GNSS.
24. Export the performance report.

---



State that final performance depends on:

* vessel type;
* sensor installation;
* gyro quality;
* DVL availability;
* bottom lock;
* radar field of view;
* map quality;
* bathymetric age;
* tide;
* sound velocity;
* seabed distinctiveness;
* weather;
* sea state;
* sensor latency;
* operating area;
* outage duration.

---

# 32. Stage 2 Roadmap Requirements

Document the next stages after the System:

## Phase 1: Offline System

* simulated data;
* replay;
* GNSS integrity;
* sensor fusion;
* UI;
* reporting.

## Phase 2: Safeen Recorded-Data Integration

* ingest real NMEA;
* ingest Sonardyne output;
* ingest radar-derived localization;
* ingest survey-system logs;
* compare against RTK ground truth.

## Phase 3: Vessel Shadow Mode

* read-only installation;
* no control outputs;
* live sensor monitoring;
* live integrity calculation;
* parallel comparison with existing navigation.

## Phase 4: Controlled Harbour Trial

* authorized GNSS outage simulation;
* cable-based GNSS simulation;
* controlled replay;
* surveyed reference truth;
* defined operating polygon.

## Phase 5: Pilot Vessel

* hardened hardware;
* redundant network interfaces;
* secure deployment;
* class and flag consultation;
* operational procedures;
* training.

## Phase 6: Fleet Platform

* vessel profiles;
* centralized monitoring;
* remote diagnostics;
* fleet analytics;
* configuration management;
* signed software updates.

---

# 33. Coding Instructions

While building:

* create working code, not pseudocode;
* keep modules small and testable;
* use type hints;
* validate all external data;
* include useful comments;
* include structured logging;
* avoid hidden global state;
* make thresholds configurable;
* write tests as features are created;
* document engineering assumptions;
* expose algorithm outputs for debugging;
* do not hide uncertainty;
* do not falsely label simulated results as field-proven;
* do not use proprietary vendor names as though official integration exists;
* represent Sonardyne, Kongsberg, Furuno, Exail, and other OEM interfaces as generic configurable adapters.

When an advanced feature cannot be implemented accurately within the system:

1. implement a simplified transparent version;
2. clearly label it;
3. define its input and output contracts;
4. add tests;
5. document how it would be replaced in production.

---

# 34. First Response Required from the Coding Agent

Before writing implementation code, produce:

1. proposed architecture;
2. component diagram;
3. data-flow diagram;
4. repository structure;
5. internal sensor message model;
6. navigation state machine;
7. fusion-state definition;
8. integrity calculation approach;
9. scenario definitions;
10. implementation milestones;
11. assumptions;
12. technical risks;
13. features intentionally deferred.
14. Create Required mockup data information for demo

After presenting this design, begin implementing the system without waiting for further confirmation.

---

# 35. Final Definition of Success

The system is successful when Safeen can see, during a simulated GNSS-denied survey:

* what position each sensor reports;
* which sensors are trusted;
* why GNSS was rejected;
* what alternative source is maintaining position;
* whether the current solution is within 2 m;
* how certain the system is;
* how long the system can continue;
* when the position can no longer be assured;
* what operational action is required;
* how GNSS is safely restored.

The key product message must be:

> iSpatialTec does not claim to create accurate position from unavailable information. The platform determines which navigation sources can be trusted, combines valid independent measurements, quantifies uncertainty, and warns Safeen before the less-than-2-metre requirement can no longer be assured.
