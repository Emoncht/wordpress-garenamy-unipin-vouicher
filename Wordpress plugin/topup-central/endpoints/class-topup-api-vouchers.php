<?php
/**
 * Vouchers API Handlers
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit; // Exit if accessed directly
}

class Topup_API_Vouchers {

    /**
     * Endpoint: POST /vouchers/claim
     */
    public static function claim_vouchers( WP_REST_Request $request ) {
        global $wpdb;
        $table_vouchers = $wpdb->prefix . 'topup_vouchers';
        $table_orders   = $wpdb->prefix . 'topup_orders';

        $params     = $request->get_json_params();
        $server_id  = sanitize_text_field( $params['server_id'] ?? '' );
        $limit      = intval( $params['max_vouchers'] ?? 1 );

        if ( empty( $server_id ) ) {
            return new WP_Error( 'invalid_server_id', 'Missing server_id.', array( 'status' => 400 ) );
        }

        // Limit maximum claim size
        $limit = min( max( 1, $limit ), 10 );

        // Attempt atomic claim using FOR UPDATE SKIP LOCKED
        $wpdb->query( 'START TRANSACTION' );

        // 1. Find available vouchers (prioritizing order priority then created_at)
        // using SKIP LOCKED so concurrent server queries don't block and don't grab the same rows.
        $query = $wpdb->prepare(
            "SELECT v.id, v.order_id, v.voucher_code, v.voucher_denomination, v.player_id, v.retry_count, o.callback_url
             FROM $table_vouchers v
             INNER JOIN $table_orders o ON v.order_id = o.order_id
             WHERE v.status = 'pending'
               AND v.locked_by IS NULL
               AND v.retry_count < v.max_retries
             ORDER BY o.priority ASC, v.created_at ASC
             LIMIT %d
             FOR UPDATE SKIP LOCKED",
            $limit
        );

        $vouchers = $wpdb->get_results( $query, ARRAY_A );

        if ( ! empty( $vouchers ) ) {
            $claimed_ids = wp_list_pluck( $vouchers, 'id' );
            $ids_placeholder = implode( ',', array_fill( 0, count( $claimed_ids ), '%d' ) );

            // 2. Lock them immediately
            $update_query = $wpdb->prepare(
                "UPDATE $table_vouchers 
                 SET status = 'claimed', 
                     locked_by = %s, 
                     locked_at = NOW(),
                     processing_started_at = NOW()
                 WHERE id IN ( $ids_placeholder )",
                array_merge( array( $server_id ), $claimed_ids )
            );
            $wpdb->query( $update_query );
        }

        $wpdb->query( 'COMMIT' );

        return new WP_REST_Response( array(
            'status'        => true,
            'vouchers'      => $vouchers ?: array(),
            'claimed_count' => is_array( $vouchers ) ? count( $vouchers ) : 0,
            'message'       => empty( $vouchers ) ? 'No pending vouchers available.' : 'Vouchers claimed successfully.'
        ), 200 );
    }

    /**
     * Endpoint: POST /vouchers/update
     */
    public static function update_voucher( WP_REST_Request $request ) {
        global $wpdb;
        $table_vouchers = $wpdb->prefix . 'topup_vouchers';

        $params       = $request->get_json_params();
        $server_id    = sanitize_text_field( $params['server_id'] ?? '' );
        $voucher_id   = intval( $params['voucher_id'] ?? 0 );
        $order_id     = sanitize_text_field( $params['order_id'] ?? '' );
        $status       = sanitize_text_field( $params['status'] ?? 'failed' );
        $reason       = sanitize_text_field( $params['reason'] ?? '' );
        $transaction  = sanitize_text_field( $params['transaction_id'] ?? '' );
        $valid_uid    = sanitize_text_field( $params['validated_uid'] ?? '' );
        $screenshot   = isset( $params['screenshot_base64'] ) ? wp_unslash( $params['screenshot_base64'] ) : null;
        $retry        = isset( $params['retry'] ) ? (bool)$params['retry'] : false;

        if ( empty( $server_id ) || empty( $voucher_id ) || empty( $order_id ) ) {
            return new WP_Error( 'invalid_data', 'Missing required fields.', array( 'status' => 400 ) );
        }

        $wpdb->query( 'START TRANSACTION' );

        // Get the current voucher record securely
        $voucher = $wpdb->get_row( $wpdb->prepare(
            "SELECT id, status, locked_by, retry_count, max_retries FROM $table_vouchers WHERE id = %d AND order_id = %s FOR UPDATE",
            $voucher_id, $order_id
        ) );

        if ( ! $voucher ) {
            $wpdb->query( 'ROLLBACK' );
            return new WP_Error( 'not_found', 'Voucher not found.', array( 'status' => 404 ) );
        }

        // Must be locked by this exact server, or if it failed previously it might be unlocked (edge cases)
        // If it's already completed, ignore duplicated callbacks.
        if ( in_array( $voucher->status, array( 'completed', 'consumed' ) ) ) {
            $wpdb->query( 'COMMIT' );
            return new WP_REST_Response( array( 'status' => true, 'message' => 'Voucher already completed.', 'order_finalized' => false ), 200 );
        }

        $update_data = array(
            'transaction_id' => $transaction,
            'validated_uid'  => $valid_uid,
            'reason'         => $reason,
        );
        $format = array( '%s', '%s', '%s' );

        if ( ! empty( $screenshot ) ) {
            $update_data['screenshot_base64'] = $screenshot;
            $format[] = '%s';
        }

        if ( $status === 'failed' && $retry && $voucher->retry_count < $voucher->max_retries ) {
            // Re-queue the voucher
            $update_data['status']       = 'pending';
            $update_data['locked_by']    = null; // release lock
            $update_data['retry_count']  = $voucher->retry_count + 1;
            $update_data['failed_at']    = current_time( 'mysql' );
            $format[] = '%s'; $format[] = '%s'; $format[] = '%d'; $format[] = '%s';
        } else {
            // Terminal state or out of retries
            $final_status = $status;
            if ( $status === 'failed' && $voucher->retry_count >= $voucher->max_retries ) {
                $final_status = 'failed';
            }

            $update_data['status']       = $final_status;
            $update_data['completed_at'] = current_time( 'mysql' );
            $format[] = '%s'; $format[] = '%s';
        }

        $wpdb->update(
            $table_vouchers,
            $update_data,
            array( 'id' => $voucher_id ),
            $format,
            array( '%d' )
        );

        $wpdb->query( 'COMMIT' );

        // After updating the voucher, check if the entire Order is complete
        $order_finalized = self::check_and_finalize_order( $order_id );

        return new WP_REST_Response( array(
            'status'          => true,
            'message'         => "Voucher $voucher_id updated to '$status'.",
            'order_finalized' => $order_finalized
        ), 200 );
    }

    /**
     * Check if all vouchers for an order are finished, and dispatch the callback to existing WP endpoint.
     */
    private static function check_and_finalize_order( $order_id ) {
        global $wpdb;
        $table_vouchers = $wpdb->prefix . 'topup_vouchers';
        $table_orders   = $wpdb->prefix . 'topup_orders';

        // Check for any non-terminal vouchers
        $unprocessed = $wpdb->get_var( $wpdb->prepare(
            "SELECT COUNT(id) FROM $table_vouchers WHERE order_id = %s AND status IN ('pending', 'claimed', 'submitting')",
            $order_id
        ) );

        if ( $unprocessed > 0 ) return false;

        // Ensure we haven't already completed this order to prevent duplicate callbacks
        $order = $wpdb->get_row( $wpdb->prepare(
            "SELECT id, callback_url, created_at, status FROM $table_orders WHERE order_id = %s FOR UPDATE",
            $order_id
        ) );

        if ( ! $order || in_array( $order->status, array( 'completed', 'failed', 'invalid_id' ) ) ) {
             return false;
        }

        // All vouchers are terminal. Gather them.
        $all_vouchers = $wpdb->get_results( $wpdb->prepare(
            "SELECT * FROM $table_vouchers WHERE order_id = %s",
            $order_id
        ), ARRAY_A );

        $payload_vouchers = array();
        $has_invalid_id = false;
        $has_failed = false;

        foreach ( $all_vouchers as $v ) {
            $start = strtotime( $v['processing_started_at'] );
            $end   = strtotime( $v['completed_at'] );
            $time_taken = 'N/A';

            if ( $start && $end ) {
                $seconds = $end - $start;
                $time_taken = $seconds < 60 ? "{$seconds} seconds" : floor( $seconds / 60 ) . " minutes " . ( $seconds % 60 ) . " seconds";
            }

            if ( strpos( strtolower( $v['reason'] ), 'invalid player id' ) !== false || strpos( strtolower( $v['reason'] ), 'invalid_id' ) !== false ) {
                $has_invalid_id = true;
            }
            if ( $v['status'] === 'failed' ) {
                $has_failed = true;
            }

            $payload_vouchers[] = array(
                'uid'                  => $v['player_id'],
                'voucher_code'         => $v['voucher_code'],
                'voucher_denomination' => $v['voucher_denomination'],
                'status'               => $v['status'],
                'reason'               => $v['reason'],
                'screenshot'           => $v['screenshot_base64'], // Send raw base64. The existing wp plugin parses and saves it.
                'transaction_id'       => $v['transaction_id'],
                'validated_uid'        => $v['validated_uid'],
                'timetaken'            => $time_taken
            );
        }

        $order_status_payload = 'success';
        if ( $has_invalid_id ) $order_status_payload = 'invalid_id';
        elseif ( $has_failed ) $order_status_payload = 'failed';

        // Calculate total time
        $order_start = strtotime( $order->created_at );
        $order_end   = time();
        $total_sec   = $order_end - $order_start;
        $total_time  = $total_sec < 60 ? "{$total_sec} seconds" : floor( $total_sec / 60 ) . " minutes " . ( $total_sec % 60 ) . " seconds";

        // Build Payload (Mapping to exactly what the EXISTING /orders endpoint expects)
        $payload = array(
            'result' => array(
                'order_id'       => $order_id,
                'order_status'   => $order_status_payload,
                'totaltimetaken' => $total_time,
                'vouchers'       => $payload_vouchers
            )
        );

        // Mark local order completed and free up DB space from huge base64 strings
        $wpdb->update(
            $table_orders,
            array( 'status' => $order_status_payload, 'completed_at' => current_time( 'mysql' ), 'total_time_seconds' => $total_sec ),
            array( 'id' => $order->id )
        );

        foreach ( $all_vouchers as $v ) {
            $wpdb->update( $table_vouchers, array( 'screenshot_base64' => null ), array( 'id' => $v['id'] ) );
        }

        // Perform async background POST request to the existing webhook endpoint
        wp_remote_post( $order->callback_url, array(
            'method'      => 'POST',
            'timeout'     => 15,
            'redirection' => 5,
            'httpversion' => '1.0',
            'blocking'    => false, // Async, don't wait for WP to process
            'headers'     => array( 'Content-Type' => 'application/json' ),
            'body'        => wp_json_encode( $payload ),
            'cookies'     => array()
        ) );

        return true;
    }

    /**
     * Endpoint: GET /vouchers/status/{order_id}
     */
    public static function get_status( WP_REST_Request $request ) {
        $order_id = sanitize_text_field( $request->get_param( 'order_id' ) );
        if ( empty( $order_id ) ) {
            return new WP_Error( 'missing_id', 'Missing order_id.', array( 'status' => 400 ) );
        }

        global $wpdb;
        $table_orders   = $wpdb->prefix . 'topup_orders';
        $table_vouchers = $wpdb->prefix . 'topup_vouchers';

        $order = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $table_orders WHERE order_id = %s", $order_id ), ARRAY_A );
        if ( ! $order ) {
            return new WP_Error( 'not_found', 'Order not found in central DB.', array( 'status' => 404 ) );
        }

        $vouchers = $wpdb->get_results( $wpdb->prepare(
            "SELECT id as voucher_id, voucher_code, status, locked_by, transaction_id, validated_uid, retry_count, completed_at, reason 
             FROM $table_vouchers WHERE order_id = %s",
            $order_id
        ), ARRAY_A );

        $summary = Topup_API_Orders::get_order_summary( $order_id );

        return new WP_REST_Response( array(
            'status'       => true,
            'order_id'     => $order_id,
            'order_status' => $order['status'],
            'vouchers'     => $vouchers,
            'summary'      => $summary
        ), 200 );
    }

    /**
     * Endpoint: POST /vouchers/release
     * Used by Node.js for graceful shutdowns.
     */
    public static function release_vouchers( WP_REST_Request $request ) {
        global $wpdb;
        $table_vouchers = $wpdb->prefix . 'topup_vouchers';

        $params      = $request->get_json_params();
        $server_id   = sanitize_text_field( $params['server_id'] ?? '' );
        $voucher_ids = $params['voucher_ids'] ?? array();

        if ( empty( $server_id ) || empty( $voucher_ids ) || ! is_array( $voucher_ids ) ) {
            return new WP_Error( 'invalid_payload', 'Missing server_id or voucher_ids array.', array( 'status' => 400 ) );
        }

        $clean_ids = array_map( 'intval', $voucher_ids );
        $ids_placeholder = implode( ',', array_fill( 0, count( $clean_ids ), '%d' ) );

        $query = $wpdb->prepare(
            "UPDATE $table_vouchers SET status = 'pending', locked_by = NULL WHERE locked_by = %s AND id IN ( $ids_placeholder )",
            array_merge( array( $server_id ), $clean_ids )
        );

        $released = $wpdb->query( $query );

        return new WP_REST_Response( array(
            'status'   => true,
            'message'  => "Released $released vouchers back to pending queue.",
            'released' => $released
        ), 200 );
    }

}
