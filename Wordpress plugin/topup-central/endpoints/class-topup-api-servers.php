<?php
/**
 * Servers and Rate Limits API Handlers
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit; // Exit if accessed directly
}

class Topup_API_Servers {

    /**
     * Endpoint: POST /servers/heartbeat
     */
    public static function heartbeat( WP_REST_Request $request ) {
        global $wpdb;
        $table_servers     = $wpdb->prefix . 'topup_servers';
        $table_rate_limits = $wpdb->prefix . 'topup_rate_limits';

        $params             = $request->get_json_params();
        $server_id          = sanitize_text_field( $params['server_id'] ?? '' );
        $label              = sanitize_text_field( $params['label'] ?? '' );
        $uptime_seconds     = isset( $params['uptime_seconds'] ) ? intval( $params['uptime_seconds'] ) : 0;
        
        $active_voucher_ids = '';
        if ( isset( $params['active_voucher_ids'] ) && is_array( $params['active_voucher_ids'] ) ) {
            $active_voucher_ids = implode( ',', array_map( 'intval', $params['active_voucher_ids'] ) );
        }
        
        // Ensure accurate IP even through reverse proxies like Cloudflare/Hostinger
        $ip_address = $_SERVER['REMOTE_ADDR'] ?? '';
        if ( isset( $_SERVER['HTTP_X_FORWARDED_FOR'] ) ) {
            $ips = explode(',', sanitize_text_field( wp_unslash( $_SERVER['HTTP_X_FORWARDED_FOR'] ) ));
            $ip_address = trim($ips[0]);
        }

        if ( empty( $server_id ) ) {
            return new WP_Error( 'invalid_server_id', 'Missing server_id.', array( 'status' => 400 ) );
        }

        // Upsert Server Record
        $existing = $wpdb->get_row( $wpdb->prepare( "SELECT server_id FROM $table_servers WHERE server_id = %s", $server_id ) );

        $data = array(
            'last_heartbeat'     => current_time( 'mysql' ),
            'is_active'          => 1,
            'ip_address'         => $ip_address,
            'uptime_seconds'     => $uptime_seconds,
            'active_voucher_ids' => $active_voucher_ids
        );
        if ( ! empty( $label ) ) {
            $data['label'] = $label;
        }

        if ( $existing ) {
            $wpdb->update( $table_servers, $data, array( 'server_id' => $server_id ) );
        } else {
            $data['server_id']     = $server_id;
            $data['registered_at'] = current_time( 'mysql' );
            if ( empty( $label ) ) $data['label'] = $server_id;
            $wpdb->insert( $table_servers, $data );
        }

        // Check for active global rate limits
        $rate_limit = $wpdb->get_row(
            "SELECT active, expires_at FROM $table_rate_limits 
             WHERE active = 1 AND expires_at > NOW() 
             ORDER BY expires_at DESC LIMIT 1",
            ARRAY_A
        );

        $is_rate_limited = false;
        $delay_ms = 1000; // Default hardcoded 1s delay

        if ( $rate_limit ) {
            $is_rate_limited = true;
            // Provide how many seconds left so workers can sleep
            $expires_stamp = strtotime( $rate_limit['expires_at'] ) - current_time( 'timestamp' );
            $delay_ms      = max( 1000, $expires_stamp * 1000 ); 
        }

        return new WP_REST_Response( array(
            'status' => true,
            'config' => array(
                'global_rate_limit_active' => $is_rate_limited,
                'min_delay_ms'             => $delay_ms,
                'claim_batch_size'         => 3 // Can be moved to DB options later
            )
        ), 200 );
    }

    /**
     * Sweep Dead Locks (Cron Job)
     */
    public static function sweep_dead_locks() {
        global $wpdb;
        $table_servers  = $wpdb->prefix . 'topup_servers';
        $table_vouchers = $wpdb->prefix . 'topup_vouchers';

        // 1. Delete deeply stale servers (older than 1 day) to prevent table bloat
        $wpdb->query( "DELETE FROM $table_servers WHERE last_heartbeat < (NOW() - INTERVAL 1 DAY)" );

        // 1. Find all servers that haven't sent a heartbeat in 5 minutes
        $stale_servers = $wpdb->get_col( 
            "SELECT server_id FROM $table_servers 
             WHERE last_heartbeat < (NOW() - INTERVAL 5 MINUTE) AND is_active = 1" 
        );

        if ( empty( $stale_servers ) ) {
            return;
        }

        $server_placeholders = implode( ',', array_fill( 0, count( $stale_servers ), '%s' ) );

        // 2. Release any 'claimed' or 'submitting' vouchers held by those servers
        // or vouchers that have been locked for > 15 minutes by ANY server
        $query = $wpdb->prepare(
            "UPDATE $table_vouchers 
             SET status = 'pending', locked_by = NULL, reason = CONCAT(IFNULL(reason,''), '\n[Recovered from dead lock]') 
             WHERE status IN ('claimed', 'submitting') 
               AND (locked_by IN ( $server_placeholders ) OR locked_at < (NOW() - INTERVAL 15 MINUTE))",
            $stale_servers
        );

        $released_count = $wpdb->query( $query );

        // Mark stale servers inactive so we don't keep querying them (they reactivate on next heartbeat)
        $wpdb->query( $wpdb->prepare(
            "UPDATE $table_servers SET is_active = 0 WHERE server_id IN ( $server_placeholders )",
            $stale_servers
        ) );

        if ( $released_count > 0 ) {
            error_log( "[Topup Central] Recovered $released_count dead-locked vouchers." );
        }
    }

    /**
     * Endpoint: GET /servers/list
     */
    public static function list_servers( WP_REST_Request $request ) {
        global $wpdb;
        $table_servers = $wpdb->prefix . 'topup_servers';

        $servers = $wpdb->get_results( "SELECT * FROM $table_servers ORDER BY last_heartbeat DESC", ARRAY_A );

        return new WP_REST_Response( array(
            'status'  => true,
            'servers' => $servers ?: array()
        ), 200 );
    }

    /**
     * Endpoint: POST /settings/rate-limit
     */
    public static function set_rate_limit( WP_REST_Request $request ) {
        global $wpdb;
        $table_rate_limits = $wpdb->prefix . 'topup_rate_limits';

        $params   = $request->get_json_params();
        $server_id= sanitize_text_field( $params['server_id'] ?? '' );
        $active   = isset( $params['active'] ) ? (bool)$params['active'] : true;
        $seconds  = intval( $params['cooldown_seconds'] ?? 35 );
        $reason   = sanitize_text_field( $params['reason'] ?? 'Manual Rate Limit' );

        if ( empty( $server_id ) ) {
            return new WP_Error( 'invalid_server_id', 'Missing server_id.', array( 'status' => 400 ) );
        }

        if ( $active ) {
            $wpdb->insert(
                $table_rate_limits,
                array(
                    'triggered_by' => $server_id,
                    'reason'       => $reason,
                    'active'       => 1,
                    'expires_at'   => current_time( 'mysql', 1 ) // Note: We need to calculate future time correctly
                ),
                array( '%s', '%s', '%d', '%s' )
            );
            
            // Fix datetime
            $wpdb->query( $wpdb->prepare(
                "UPDATE $table_rate_limits SET expires_at = DATE_ADD(NOW(), INTERVAL %d SECOND) WHERE id = LAST_INSERT_ID()",
                $seconds
            ));
            
            $expires = $wpdb->get_var("SELECT expires_at FROM $table_rate_limits WHERE id = LAST_INSERT_ID()");

            return new WP_REST_Response( array(
                'status'     => true,
                'message'    => "Global rate limit activated for $seconds seconds.",
                'expires_at' => $expires
            ), 200 );
        } else {
            // Deactivate all active rate limits
            $wpdb->query( "UPDATE $table_rate_limits SET active = 0 WHERE active = 1" );
            
            return new WP_REST_Response( array(
                'status'  => true,
                'message' => "All global rate limits deactivated.",
            ), 200 );
        }
    }

}
