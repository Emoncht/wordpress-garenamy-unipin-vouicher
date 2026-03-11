<?php
/**
 * Orders API Handlers
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit; // Exit if accessed directly
}

class Topup_API_Orders {

    /**
     * Endpoint: POST /orders/register
     */
    public static function register_order( WP_REST_Request $request ) {
        global $wpdb;
        $table_orders   = $wpdb->prefix . 'topup_orders';
        $table_vouchers = $wpdb->prefix . 'topup_vouchers';

        $order_id     = sanitize_text_field( $request->get_param('order_id') ?? '' );
        $domain       = sanitize_text_field( $request->get_param('domain') ?? '' );
        $callback_url = esc_url_raw( $request->get_param('callback_url') ?? '' );
        $priority     = intval( $request->get_param('priority') ?? 0 );

        // Robust parsing of order_items 
        // Handles both pure JSON objects and Postman raw strings/Form Data strings
        $raw_order_items = $request->get_param('order_items');
        if ( is_string( $raw_order_items ) ) {
            $parsed_items = json_decode( trim( stripslashes( $raw_order_items ) ), true );
            if ( is_array( $parsed_items ) ) {
                $order_items = $parsed_items;
            } else {
                $order_items = array();
            }
        } elseif ( is_array( $raw_order_items ) ) {
            $order_items = $raw_order_items;
        } else {
            $order_items = array();
        }

        // Legacy compatibility: use `domain` if `callback_url` is missing
        if ( empty( $callback_url ) && ! empty( $domain ) ) {
            $parsed_url = wp_parse_url( strpos( $domain, 'http' ) === 0 ? $domain : 'https://' . $domain );
            if ( $parsed_url ) {
                $path = $parsed_url['path'] ?? '/';
                if ( $path === '/' || $path === '' ) {
                    $scheme = ( isset( $parsed_url['host'] ) && strpos( $parsed_url['host'], 'localhost' ) !== false ) ? 'http://' : 'https://';
                    $callback_url = $scheme . $parsed_url['host'] . '/wp-json/custom-order-plugin/v1/orders';
                } else {
                    $callback_url = $domain;
                }
            } else {
                $callback_url = $domain;
            }
        }

        if ( empty( $order_id ) || empty( $callback_url ) || empty( $order_items ) || ! is_array( $order_items ) ) {
            return new WP_Error( 'invalid_payload', 'Missing required fields or invalid order_items array.', array( 'status' => 400 ) );
        }

        // 1. Check if order exists
        $existing_order = $wpdb->get_row( $wpdb->prepare( "SELECT id, status FROM $table_orders WHERE order_id = %s", $order_id ) );

        if ( $existing_order ) {
            // Return summary of existing
            $summary = self::get_order_summary( $order_id );
            
            // If the order is already in a terminal state, resend the callback
            $terminal_states = array( 'success', 'failed', 'invalid_id', 'consumed' );
            if ( in_array( $existing_order->status, $terminal_states ) ) {
                $all_vouchers = $wpdb->get_results( $wpdb->prepare(
                    "SELECT * FROM $table_vouchers WHERE order_id = %s",
                    $order_id
                ), ARRAY_A );

                $payload_vouchers = array();
                foreach ( $all_vouchers as $v ) {
                    $start = strtotime( $v['processing_started_at'] );
                    $end   = strtotime( $v['completed_at'] );
                    $time_taken = 'N/A';
                    if ( $start && $end ) {
                        $seconds = $end - $start;
                        $time_taken = $seconds < 60 ? "{$seconds} seconds" : floor( $seconds / 60 ) . " minutes " . ( $seconds % 60 ) . " seconds";
                    }

                    $payload_vouchers[] = array(
                        'uid'                  => $v['player_id'],
                        'voucher_code'         => $v['voucher_code'],
                        'voucher_denomination' => $v['voucher_denomination'],
                        'status'               => $v['status'],
                        'reason'               => $v['reason'],
                        'screenshot'           => $v['screenshot_base64'],
                        'transaction_id'       => $v['transaction_id'],
                        'validated_uid'        => $v['validated_uid'],
                        'timetaken'            => $time_taken
                    );
                }

                $payload = array(
                    'result' => array(
                        'order_id'       => $order_id,
                        'order_status'   => $existing_order->status,
                        // We use a simplified total time here as we don't store it explicitly if we don't want to recompute
                        'totaltimetaken' => 'Re-dispatched', 
                        'vouchers'       => $payload_vouchers
                    )
                );

                wp_remote_post( $callback_url, array(
                    'method'      => 'POST',
                    'timeout'     => 15,
                    'redirection' => 5,
                    'httpversion' => '1.0',
                    'blocking'    => false, // Async
                    'headers'     => array( 'Content-Type' => 'application/json' ),
                    'body'        => wp_json_encode( $payload ),
                    'cookies'     => array()
                ) );
            }

            return new WP_REST_Response( array(
                'status'   => true,
                'message'  => 'Order already exists.',
                'order_id' => $order_id,
                'summary'  => $summary
            ), 200 );
        }

        // 2. Start Transaction
        $wpdb->query( 'START TRANSACTION' );

        // Insert Order
        $inserted_order = $wpdb->insert(
            $table_orders,
            array(
                'order_id'     => $order_id,
                'callback_url' => $callback_url,
                'status'       => 'pending',
                'priority'     => $priority,
                'created_at'   => current_time( 'mysql', 1 )
            ),
            array( '%s', '%s', '%s', '%d', '%s' )
        );

        if ( ! $inserted_order ) {
            $wpdb->query( 'ROLLBACK' );
            return new WP_Error( 'db_error', 'Failed to insert order into database.', array( 'status' => 500 ) );
        }

        $total_vouchers = 0;

        // Insert Vouchers
        foreach ( $order_items as $order_item ) {
            $player_id = sanitize_text_field( $order_item['player_id'] ?? '' );

            if ( empty( $player_id ) || empty( $order_item['items'] ) ) continue;

            foreach ( $order_item['items'] as $item ) {
                if ( empty( $item['voucher_data'] ) ) continue;

                foreach ( $item['voucher_data'] as $v_data ) {
                    $denomination = sanitize_text_field( $v_data['voucher_value'] ?? '' );
                    $codes        = $v_data['voucher_codes'] ?? array();

                    foreach ( $codes as $code ) {
                        $code = sanitize_text_field( $code );
                        
                        // Deduplication Check
                        $is_duplicate = $wpdb->get_var( $wpdb->prepare(
                            "SELECT id FROM $table_vouchers WHERE voucher_code = %s",
                            $code
                        ) );

                        if ( $is_duplicate ) {
                            continue; // Skip duplicate codes entirely
                        }

                        $inserted_voucher = $wpdb->insert(
                            $table_vouchers,
                            array(
                                'order_id'             => $order_id,
                                'player_id'            => $player_id,
                                'voucher_code'         => $code,
                                'voucher_denomination' => $denomination,
                                'status'               => 'pending',
                                'created_at'           => current_time( 'mysql', 1 )
                            ),
                            array( '%s', '%s', '%s', '%s', '%s', '%s' )
                        );

                        if ( $inserted_voucher ) {
                            $total_vouchers++;
                        }
                    }
                }
            }
        }

        $wpdb->query( 'COMMIT' );

        return new WP_REST_Response( array(
            'status'                => true,
            'message'               => "Order registered. $total_vouchers vouchers queued.",
            'order_id'              => $order_id,
            'total_vouchers_queued' => $total_vouchers
        ), 201 );
    }

    /**
     * Helper to get order summary
     */
    public static function get_order_summary( $order_id ) {
        global $wpdb;
        $table_vouchers = $wpdb->prefix . 'topup_vouchers';

        $results = $wpdb->get_results( $wpdb->prepare(
            "SELECT status, COUNT(*) as count FROM $table_vouchers WHERE order_id = %s GROUP BY status",
            $order_id
        ), ARRAY_A );

        $summary = array(
            'total'     => 0,
            'completed' => 0,
            'consumed'  => 0,
            'pending'   => 0,
            'failed'    => 0,
            'claimed'   => 0,
            'submitting'=> 0,
        );

        if ( $results ) {
            foreach ( $results as $row ) {
                $status = $row['status'];
                $count  = intval( $row['count'] );
                if ( isset( $summary[ $status ] ) ) {
                    $summary[ $status ] = $count;
                }
                $summary['total'] += $count;
            }
        }

        return $summary;
    }

}
