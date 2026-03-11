# Dynamic Worker Scaling — Hybrid Implementation Plan

## Overview

Currently, each Node.js instance starts a **fixed number** of worker loops (`BROWSER_CONCURRENCY=5`) that run forever, even when the queue is empty. This wastes resources (CPU, memory, API calls) and provides no way to adjust concurrency without restarting the process.

**Goal**: Build a hybrid system where workers **auto-scale based on queue depth**, but the admin can **override the limits** from the WordPress dashboard at any time without touching code or restarting servers.

---

## Architecture Summary

```
┌──────────────────────────────────┐
│   WordPress (Topup Central)      │
│                                  │
│  ┌─────────────────────────┐     │
│  │ wp_options table         │     │
│  │  topup_min_workers = 1   │     │
│  │  topup_max_workers = 8   │     │
│  │  topup_scale_threshold=5 │     │
│  └─────────────┬───────────┘     │
│                │                 │
│  Heartbeat API returns these     │
│  values in config.scaling {}     │
└────────────────┬─────────────────┘
                 │  Every 30s
                 ▼
┌──────────────────────────────────┐
│   Node.js Worker Instance        │
│                                  │
│  ┌──────────────┐                │
│  │ ScaleManager  │               │
│  │  - reads config from heartbeat│
│  │  - reads pending count from   │
│  │    claim API response         │
│  │  - spawns/retires workers     │
│  └──────┬───────┘                │
│         │                        │
│  Worker 1 (baseline, immortal)   │
│  Worker 2 (burst, can retire)    │
│  Worker 3 (burst, can retire)    │
│  ...                             │
└──────────────────────────────────┘
```

---

## WORDPRESS SIDE — Changes

### 1. Add scaling options to `wp_options` (Settings page)

**File**: `admin/class-topup-admin.php` → `page_init()` + `page_settings()`

- Register three new settings fields:
  1. `topup_min_workers` — Minimum workers per server (default: `1`). This is the "always-on" baseline.
  2. `topup_max_workers` — Maximum workers per server (default: `8`). Hard cap so auto-scaling can't go crazy.
  3. `topup_scale_threshold` — Pending vouchers per worker before scaling up (default: `5`). If pending/active_workers > this, a new worker spawns.

- Add these inputs to the existing **Settings** page under a new section "**Auto-Scaling Configuration**":
  ```
  [Auto-Scaling Configuration]
  Minimum Workers per Server:   [ 1 ]   ← Always keep at least this many running
  Maximum Workers per Server:   [ 8 ]   ← Never exceed this, even under heavy load
  Scale-Up Threshold:           [ 5 ]   ← Spawn a new worker when (pending ÷ active_workers) > this
  ```

- Use `register_setting()` / `add_settings_field()` with appropriate sanitize callbacks (intval, min 1, max 20).

---

### 2. Return scaling config in heartbeat API response

**File**: `endpoints/class-topup-api-servers.php` → `heartbeat()`

- Read the three new options from `wp_options`:
  ```php
  $min_workers       = (int) get_option( 'topup_min_workers', 1 );
  $max_workers       = (int) get_option( 'topup_max_workers', 8 );
  $scale_threshold   = (int) get_option( 'topup_scale_threshold', 5 );
  ```

- Add a `scaling` block to the existing `config` response object:
  ```php
  'config' => array(
      'global_rate_limit_active' => $is_rate_limited,
      'min_delay_ms'             => $delay_ms,
      'claim_batch_size'         => 3,
      // NEW: Scaling directives
      'scaling' => array(
          'min_workers'      => $min_workers,
          'max_workers'      => $max_workers,
          'scale_threshold'  => $scale_threshold,
      ),
  ),
  ```

---

### 3. Return pending count in the claim API response

**File**: `endpoints/class-topup-api-vouchers.php` → `claim_vouchers()`

- After the existing claim logic, add a quick count of remaining pending vouchers:
  ```php
  $pending_count = (int) $wpdb->get_var(
      "SELECT COUNT(*) FROM $table_vouchers WHERE status = 'pending' AND locked_by IS NULL"
  );
  ```

- Include it in the response:
  ```php
  return new WP_REST_Response( array(
      'status'        => true,
      'vouchers'      => $vouchers ?: array(),
      'claimed_count' => ...,
      'pending_count' => $pending_count,   // NEW
      'message'       => ...
  ), 200 );
  ```

---

### 4. Show active worker count in dashboard Server Fleet card

**File**: `endpoints/class-topup-api-servers.php` → `heartbeat()`

- Accept a new field from Node.js heartbeat payload:
  ```php
  $active_workers = isset( $params['active_workers'] ) ? intval( $params['active_workers'] ) : 0;
  ```

- Store it in the server record (add column `active_workers INT DEFAULT 0` to `topup_servers` table):
  ```php
  $data['active_workers'] = $active_workers;
  ```

**File**: `topup-central.php` → `topup_central_install()`

- Add `active_workers int DEFAULT 0 NOT NULL` column to the `topup_servers` CREATE TABLE statement.

**File**: `admin/class-topup-admin.php` → Server Fleet JavaScript

- Display the `active_workers` count in each server card:
  ```
  ⚙️ Workers: 3 / 8 (min: 1)
  ```

---

## NODE.JS SIDE — Changes

### 5. Add scaling state variables

**File**: `state.js`

- Add new state variables for scaling:
  ```js
  let scalingConfig = {
      minWorkers: 1,
      maxWorkers: 8,
      scaleThreshold: 5
  };
  let activeWorkerCount = 0;
  let lastKnownPending = 0;
  ```

- Add getters/setters:
  ```js
  getScalingConfig: () => scalingConfig,
  setScalingConfig: (cfg) => { scalingConfig = { ...scalingConfig, ...cfg }; },
  getActiveWorkerCount: () => activeWorkerCount,
  incrementWorkerCount: () => ++activeWorkerCount,
  decrementWorkerCount: () => --activeWorkerCount,
  getLastKnownPending: () => lastKnownPending,
  setLastKnownPending: (n) => { lastKnownPending = n; },
  ```

---

### 6. Sync scaling config from heartbeat

**File**: `heartbeat.js` → `performHeartbeat()`

- Read the new `scaling` config from heartbeat response and push it to state:
  ```js
  if (response.config.scaling) {
      state.setScalingConfig({
          minWorkers: response.config.scaling.min_workers,
          maxWorkers: response.config.scaling.max_workers,
          scaleThreshold: response.config.scaling.scale_threshold
      });
  }
  ```

- Send current worker count in the heartbeat payload:
  ```js
  const payload = {
      ...existing fields...,
      active_workers: state.getActiveWorkerCount()
  };
  ```

---

### 7. Update worker loop to support retirement

**File**: `worker.js` → `browserWorkerLoop(browserId)`

- Accept a `isBaseline` parameter:
  ```js
  async function browserWorkerLoop(browserId, isBaseline = false)
  ```

- After claiming, update `lastKnownPending` on state:
  ```js
  if (response.pending_count !== undefined) {
      state.setLastKnownPending(response.pending_count);
  }
  ```

- **Retirement logic**: When a burst (non-baseline) worker finds the queue empty and stays idle for 60 seconds, it exits:
  ```js
  // Inside the "queue empty" branch:
  if (!isBaseline) {
      idleTime += 5000; // accumulate idle time
      if (idleTime >= 60000) {
          console.log(`[Worker ${browserId}] Burst worker retiring after 60s idle.`);
          state.decrementWorkerCount();
          return; // Exit the loop, worker dies gracefully
      }
  }
  ```

- Reset `idleTime = 0` whenever a voucher is successfully claimed.

---

### 8. Create a Scale Manager

**File**: `worker.js` → Replace `startWorkerLoops()` with `startScaleManager()`

- Start only `minWorkers` initially (default 1), tagged as `isBaseline = true`.
- Run a **scaling check every 10 seconds** (piggybacks on the claim response `pending_count`):

  ```js
  async function startScaleManager() {
      const cfg = state.getScalingConfig();
      console.log(`[ScaleManager] Starting with min=${cfg.minWorkers}, max=${cfg.maxWorkers}`);

      // Initialize browser pool with max capacity
      if (!isBrowserPoolInitialized) {
          await initializeBrowserPool();
          isBrowserPoolInitialized = true;
      }

      // Start baseline workers (immortal, never retire)
      for (let i = 0; i < cfg.minWorkers; i++) {
          spawnWorker(true); // isBaseline = true
          await sleep(2000);
      }

      // Scaling loop — runs every 10s
      setInterval(() => {
          const pending = state.getLastKnownPending();
          const active  = state.getActiveWorkerCount();
          const config  = state.getScalingConfig();

          // Scale UP: if pending/active > threshold AND we're below max
          if (active > 0 && pending / active > config.scaleThreshold && active < config.maxWorkers) {
              const toSpawn = Math.min(
                  Math.ceil(pending / config.scaleThreshold) - active,
                  config.maxWorkers - active
              );
              for (let i = 0; i < toSpawn; i++) {
                  spawnWorker(false); // burst worker
              }
              console.log(`[ScaleManager] Scaled UP: ${active} → ${active + toSpawn} workers (${pending} pending)`);
          }

          // Scale DOWN is handled by workers self-retiring (see step 7)
      }, 10000);
  }

  let nextWorkerId = 0;
  function spawnWorker(isBaseline) {
      nextWorkerId++;
      state.incrementWorkerCount();
      browserWorkerLoop(nextWorkerId, isBaseline).catch(err => {
          console.error(`Worker ${nextWorkerId} crashed:`, err);
          state.decrementWorkerCount();
      });
  }
  ```

---

### 9. Update virtual pool to be dynamic

**File**: `topup.js` → `initializeBrowserPool()`

- Change the pool to initialize with `maxWorkers` capacity instead of `BROWSER_CONCURRENCY`:
  ```js
  const MAX_CONCURRENT_WORKERS = parseInt(process.env.MAX_WORKERS || '8', 10);
  ```

- The pool is just slot-tracking. It should support the maximum possible workers.

---

### 10. Update server.js entry point

**File**: `server.js`

- Replace `startWorkerLoops()` with `startScaleManager()`:
  ```js
  const { startScaleManager } = require('./worker');
  // ...
  startScaleManager().catch(console.error);
  ```

---

### 11. Update ecosystem.config.js

**File**: `ecosystem.config.js`

- Replace `BROWSER_CONCURRENCY` with the new env var (or remove it, since scaling is now dynamic):
  ```js
  env: {
      NODE_ENV: 'production',
      PORT: 4000,
      MAX_WORKERS: '8',       // Hard cap, also configurable from WP dashboard
      NODE_OPTIONS: '--max-old-space-size=512'
  }
  ```

---

## How It All Works Together

| Scenario | What Happens |
|---|---|
| **No orders** | Only 1 baseline worker runs, polling every 5s. Minimal resource usage. |
| **5 orders come in** | Baseline worker picks up first voucher. ScaleManager sees `pending=4, active=1, ratio=4 < 5`. No scale-up yet. |
| **20 orders come in** | ScaleManager sees `pending=19, active=1, ratio=19 > 5`. Spawns 3 more workers (up to 4 total). |
| **50 orders come in** | ScaleManager scales to `max_workers` (8). All 8 workers process in parallel. |
| **Queue drains** | Burst workers idle for 60s and self-retire one by one. Eventually only 1 baseline remains. |
| **Admin sets max_workers=2** | Next heartbeat (30s) syncs new config. ScaleManager won't spawn beyond 2. Existing excess workers retire naturally as they idle. |
| **Admin sets min_workers=4** | Heartbeat syncs. ScaleManager detects `active < minWorkers` and spawns new baseline workers. |

---

## Summary of Files Changed

| File | Side | What Changes |
|---|---|---|
| `topup-central.php` | WordPress | Add `active_workers` column to `topup_servers` table |
| `endpoints/class-topup-api-servers.php` | WordPress | Read scaling options, return in heartbeat `config.scaling`, accept `active_workers` |
| `endpoints/class-topup-api-vouchers.php` | WordPress | Return `pending_count` in claim response |
| `admin/class-topup-admin.php` | WordPress | Add scaling settings UI + show worker count in Server Fleet |
| `state.js` | Node.js | Add scaling config state, worker counter, pending tracker |
| `heartbeat.js` | Node.js | Sync scaling config, report `active_workers` |
| `worker.js` | Node.js | Replace `startWorkerLoops()` with `startScaleManager()`, add retirement logic |
| `topup.js` | Node.js | Use `MAX_WORKERS` env for pool capacity |
| `server.js` | Node.js | Call `startScaleManager()` instead of `startWorkerLoops()` |
| `ecosystem.config.js` | Node.js | Replace `BROWSER_CONCURRENCY` with `MAX_WORKERS` |
