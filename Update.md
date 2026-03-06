# System Update Plan: Real-Time Voucher Synchronization

## Problem Statement
Currently, the Order Processing System suffers from a **Race Condition/Congestion** issue when handling large orders (>5 minutes processing time).

1.  **Trigger**: An order is sent to Server 1. Processing takes ~30s per voucher. A 50-voucher order takes 25 minutes.
2.  **Retry Logic**: The WordPress plugin has a failsafe: if an order isn't "Completed" in 5 minutes, it resends the *entire* payload to Server 2.
3.  **Conflict**: Server 1 is still processing (e.g., Voucher #10 of 50). Server 2 receives the full order and begins processing from Voucher #1.
4.  **Result**: Double spending/processing, wasted resources, and API congestion.

## Solution Overview
We will implement an **Incremental Synchronization Mechanism**. Instead of waiting for the entire order to finish, the NodeJS Worker will notify the WordPress backend immediately after *each* individual voucher is processed.

This allows the WordPress backend to maintain a real-time list of "Completed" vouchers. When the 5-minute retry logic triggers, the `filter_payload` function in the WordPress plugin will see the completed vouchers and **exclude** them from the payload sent to Server 2.

### Goals
-   **Eliminate Duplicate Processing**: Server 2 will only receive vouchers that are truly pending.
-   **Maintain Order Integrity**: Ensure the WordPress Order Status remains "Processing" until the *very last* voucher is done.
-   **No WordPress Code Changes Required**: Leverage existing logic in `wordpressplugin.php` that filters payloads based on the `voucher_details_resend` table.

---

## Technical Implementation Plan

### 1. NodeJS Worker Modification (`worker.js`)

We need to introduce a new function `sendProgressCallback` and integrate it into the processing loop.

#### A. New Function: `sendProgressCallback(orderId)`
This function will:
1.  Fetch **ALL** vouchers for the given `orderId` from the local database.
    *   *Why all vouchers?* The WordPress plugin calculates order completion based on the ratio of `completed` vs `total` vouchers in the payload. If we send only 1 voucher, WordPress will think `1/1` are done and mark the Order as `Completed` prematurely. Sending the full snapshot ensures the count (`10/50 completed`) is correct, keeping the order in "Processing" state.
2.  Construct the payload in the format expected by the WordPress endpoint.
3.  Send the payload to the Order's `callback_url`.

#### B. Integration in `browserWorkerLoop`
Inside the main processing loop in `worker.js`:
-   **Current Behavior**: Logs info after `runAutomation` returns. Check `checkAndFinalizeOrder` (which only sends callback if *fully* complete).
-   **New Behavior**: Immediately after a voucher status is updated to `success`, `completed`, or `consumed` (and DB updated), call `sendProgressCallback`.

### 2. Logic Validation (WordPress Side)

We have analyzed `wordpressplugin.php` to ensure compatibility:

-   **Updating specific vouchers**: The plugin iterates through the `vouchers` array in the JSON payload.
    -   It calls `custom_order_plugin_insert_voucher_record` or updates existing records for any voucher with status `completed` or `consumed` (Lines 279, 322).
    -   **Result**: The local WordPress DB (`voucher_details_resend`) is updated in real-time.
-   **Preventing Premature Completion**:
    -   The plugin calculates `total_vouchers` from the payload count.
    -   It compares `consumed_or_complete_count` against `total_vouchers`.
    -   **Result**: By sending the full list (e.g., 50 items) in our progress update, the plugin sees `1 completed`, `49 pending`. The condition `1 === 50` fails, so the "Completed" status is **NOT** triggered. Safe.
-   **Resend Filtering**:
    -   The `custom_order_plugin_resend_payload` function uses `custom_order_plugin_filter_payload`.
    -   This filter checks `voucher_details_resend`.
    -   **Result**: When the 5-minute retry fires, it sees vouchers 1-10 are already in the DB. It removes them. Server 2 receives a payload with only vouchers 11-50.

---

## Action Items

1.  **Modify `worker.js`**: Implement `sendProgressCallback` and call it within the loop.
2.  **Deploy**: Restart the NodeJS service.
3.  **Monitor**: Watch a large order. Verify that WP receives intermediate updates and the `voucher_details_resend` table populates incrementally.

## Proposed Code Changes

### Add to `worker.js`

```javascript
async function sendProgressCallback(orderId, updatedVoucherId) {
    // 1. Get Callback URL
    const [[order]] = await db.execute("SELECT callback_url FROM orders WHERE order_id = ?", [orderId]);
    if (!order || !order.callback_url) return;

    // 2. Get ALL vouchers for this order (Snapshot)
    const [orderVouchers] = await db.execute("SELECT * FROM vouchers WHERE order_id = ?", [orderId]);

    // 3. Construct Payload
    const payload = {
        order_id: orderId,
        order_status: 'processing', // Explicitly state processing
        vouchers: orderVouchers.map(v => ({
            uid: v.uid,
            voucher_code: v.voucher_code,
            voucher_denomination: v.voucher_denomination,
            status: v.status, // e.g., 'completed', 'Pending'
            reason: v.reason,
            screenshot: screenshotCache.get(v.id) || null,
            transaction_id: v.transaction_id,
            validated_uid: v.validated_uid,
            timetaken: 'N/A' // Opsional calculation
        }))
    };

    // 4. Send Update
    try {
        await axios.post(order.callback_url, { result: payload });
        await logger.logInfo(orderId, 'Sent progress update to WP', { 
            voucher_id: updatedVoucherId,
            completed_count: orderVouchers.filter(v => ['completed', 'success', 'consumed'].includes(v.status)).length
        });
    } catch (error) {
        console.error("Failed to send progress update", error.message);
    }
}
```

### Call in `browserWorkerLoop`

```javascript
// Inside browserWorkerLoop, after DB update for success/completed:
if (result && (result.status === 'completed' || result.status === 'consumed' || result.status === 'success')) {
    // ... existing logging ...
    
    // NEW: Send incremental update
    await sendProgressCallback(voucher.order_id, voucher.id);
    
    // ... existing cooldown ...
}
```
