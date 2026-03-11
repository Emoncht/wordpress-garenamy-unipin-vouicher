<?php
/**
 * Plugin Name: Topup Central API
 * Description: A centralized API backend to manage multi-server top-up queues with strict row-level locking. Dispatches final results back to the existing order plugin.
 * Version: 1.0.0
 * Author: Admin
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit; // Exit if accessed directly
}

define( 'TOPUP_CENTRAL_VERSION', '1.0.0' );
define( 'TOPUP_CENTRAL_DB_VERSION', '1.0.2' );

// ------------------------------------------------------------------
// 1. Database Installation
// ------------------------------------------------------------------
function topup_central_install() {
    global $wpdb;
    require_once( ABSPATH . 'wp-admin/includes/upgrade.php' );
    $charset_collate = $wpdb->get_charset_collate();

    // Table 1: topup_orders
    $table_orders = $wpdb->prefix . 'topup_orders';
    $sql_orders = "CREATE TABLE $table_orders (
        id mediumint(9) NOT NULL AUTO_INCREMENT,
        order_id varchar(50) NOT NULL,
        callback_url text NOT NULL,
        status varchar(30) DEFAULT 'pending' NOT NULL,
        priority int DEFAULT 0 NOT NULL,
        created_at datetime DEFAULT CURRENT_TIMESTAMP NOT NULL,
        completed_at datetime DEFAULT NULL,
        total_time_seconds int DEFAULT NULL,
        PRIMARY KEY  (id),
        UNIQUE KEY order_id (order_id)
    ) $charset_collate;";
    dbDelta( $sql_orders );

    // Table 2: topup_vouchers
    $table_vouchers = $wpdb->prefix . 'topup_vouchers';
    $sql_vouchers = "CREATE TABLE $table_vouchers (
        id mediumint(9) NOT NULL AUTO_INCREMENT,
        order_id varchar(50) NOT NULL,
        player_id varchar(100) NOT NULL,
        voucher_code varchar(150) NOT NULL,
        voucher_denomination varchar(50) NOT NULL,
        status varchar(30) DEFAULT 'pending' NOT NULL,
        locked_by varchar(100) DEFAULT NULL,
        locked_at datetime DEFAULT NULL,
        retry_count int DEFAULT 0 NOT NULL,
        max_retries int DEFAULT 5 NOT NULL,
        reason text DEFAULT NULL,
        transaction_id varchar(100) DEFAULT NULL,
        validated_uid varchar(200) DEFAULT NULL,
        screenshot_url text DEFAULT NULL,
        screenshot_base64 longtext DEFAULT NULL,
        processing_started_at datetime DEFAULT NULL,
        completed_at datetime DEFAULT NULL,
        failed_at datetime DEFAULT NULL,
        created_at datetime DEFAULT CURRENT_TIMESTAMP NOT NULL,
        PRIMARY KEY  (id),
        KEY order_id (order_id),
        KEY status (status)
    ) $charset_collate;";
    dbDelta( $sql_vouchers );

    // Table 3: topup_servers
    $table_servers = $wpdb->prefix . 'topup_servers';
    $sql_servers = "CREATE TABLE $table_servers (
        server_id varchar(100) NOT NULL,
        nickname varchar(100) DEFAULT NULL,
        label varchar(200) DEFAULT NULL,
        last_heartbeat datetime NOT NULL,
        is_active tinyint(1) DEFAULT 1 NOT NULL,
        ip_address varchar(100) DEFAULT NULL,
        uptime_seconds int DEFAULT 0 NOT NULL,
        active_voucher_ids text DEFAULT NULL,
        active_workers int DEFAULT 0 NOT NULL,
        total_completed int DEFAULT 0 NOT NULL,
        total_failed int DEFAULT 0 NOT NULL,
        registered_at datetime DEFAULT CURRENT_TIMESTAMP NOT NULL,
        PRIMARY KEY  (server_id)
    ) $charset_collate;";
    dbDelta( $sql_servers );

    // Table 4: topup_rate_limits
    $table_rate_limits = $wpdb->prefix . 'topup_rate_limits';
    $sql_rate_limits = "CREATE TABLE $table_rate_limits (
        id mediumint(9) NOT NULL AUTO_INCREMENT,
        triggered_by varchar(100) NOT NULL,
        reason text NOT NULL,
        active tinyint(1) DEFAULT 1 NOT NULL,
        expires_at datetime NOT NULL,
        created_at datetime DEFAULT CURRENT_TIMESTAMP NOT NULL,
        PRIMARY KEY  (id)
    ) $charset_collate;";
    dbDelta( $sql_rate_limits );

    update_option( 'topup_central_db_version', TOPUP_CENTRAL_DB_VERSION );
    
    // Default config
    add_option('topup_central_api_key', 'CHANGE_ME_IN_ADMIN_PANEL');
    
    // Guess default Node.js log path relative to WP standard structure if possible
    // Assumes WP is in htdocs/www and Node is parallel, adjust default as needed
    $default_log_path = dirname( ABSPATH, 2 ) . '/Logs'; 
    add_option('topup_nodejs_log_path', $default_log_path);
}
register_activation_hook( __FILE__, 'topup_central_install' );

add_action( 'plugins_loaded', function() {
    if ( get_option( 'topup_central_db_version' ) !== TOPUP_CENTRAL_DB_VERSION ) {
        topup_central_install();
    }
} );

// ------------------------------------------------------------------
// 2. Authentication Helper
// ------------------------------------------------------------------
function topup_central_api_auth( WP_REST_Request $request ) {
    $valid_key = get_option('topup_central_api_key', 'CHANGE_ME_IN_ADMIN_PANEL');
    $provided_key = $request->get_header('x-api-key');

    if ( $provided_key && hash_equals( $valid_key, $provided_key ) ) {
        return true;
    }

    return new WP_Error( 'rest_forbidden', __( 'Invalid API Key.' ), array( 'status' => 401 ) );
}

// ------------------------------------------------------------------
// 3. Register API Endpoints
// ------------------------------------------------------------------
add_action( 'rest_api_init', function () {
    // We will include the logic files here
    require_once plugin_dir_path( __FILE__ ) . 'endpoints/class-topup-api-orders.php';
    require_once plugin_dir_path( __FILE__ ) . 'endpoints/class-topup-api-vouchers.php';
    require_once plugin_dir_path( __FILE__ ) . 'endpoints/class-topup-api-servers.php';

    // POST /orders/register
    register_rest_route( 'topup-central/v1', '/orders/register', array(
        'methods'             => 'POST',
        'callback'            => array( 'Topup_API_Orders', 'register_order' ),
        'permission_callback' => '__return_true'
    ));

    // POST /vouchers/claim
    register_rest_route( 'topup-central/v1', '/vouchers/claim', array(
        'methods'             => 'POST',
        'callback'            => array( 'Topup_API_Vouchers', 'claim_vouchers' ),
        'permission_callback' => 'topup_central_api_auth'
    ));

    // POST /vouchers/update
    register_rest_route( 'topup-central/v1', '/vouchers/update', array(
        'methods'             => 'POST',
        'callback'            => array( 'Topup_API_Vouchers', 'update_voucher' ),
        'permission_callback' => 'topup_central_api_auth'
    ));

    // GET /vouchers/status/{order_id}
    register_rest_route( 'topup-central/v1', '/vouchers/status/(?P<order_id>[a-zA-Z0-9-]+)', array(
        'methods'             => 'GET',
        'callback'            => array( 'Topup_API_Vouchers', 'get_status' ),
        'permission_callback' => 'topup_central_api_auth'
    ));

    // POST /servers/heartbeat
    register_rest_route( 'topup-central/v1', '/servers/heartbeat', array(
        'methods'             => 'POST',
        'callback'            => array( 'Topup_API_Servers', 'heartbeat' ),
        'permission_callback' => 'topup_central_api_auth'
    ));

    // GET /servers/list
    register_rest_route( 'topup-central/v1', '/servers/list', array(
        'methods'             => 'GET',
        'callback'            => array( 'Topup_API_Servers', 'list_servers' ),
        'permission_callback' => 'topup_central_api_auth'
    ));

    // POST /settings/rate-limit
    register_rest_route( 'topup-central/v1', '/settings/rate-limit', array(
        'methods'             => 'POST',
        'callback'            => array( 'Topup_API_Servers', 'set_rate_limit' ),
        'permission_callback' => 'topup_central_api_auth'
    ));

    // POST /vouchers/release
    register_rest_route( 'topup-central/v1', '/vouchers/release', array(
        'methods'             => 'POST',
        'callback'            => array( 'Topup_API_Vouchers', 'release_vouchers' ),
        'permission_callback' => 'topup_central_api_auth'
    ));
});

// ------------------------------------------------------------------
// 5. Admin Dashboard
// ------------------------------------------------------------------
if ( is_admin() ) {
    require_once plugin_dir_path( __FILE__ ) . 'admin/class-topup-admin.php';
}

// ------------------------------------------------------------------
// 4. Dead-Lock Recovery Cron Job
// ------------------------------------------------------------------
function topup_central_deadlock_recovery() {
    require_once plugin_dir_path( __FILE__ ) . 'endpoints/class-topup-api-servers.php';
    Topup_API_Servers::sweep_dead_locks();
}
add_action( 'topup_central_deadlock_cron', 'topup_central_deadlock_recovery' );

if ( ! wp_next_scheduled( 'topup_central_deadlock_cron' ) ) {
    wp_schedule_event( time(), 'every_5_minutes', 'topup_central_deadlock_cron' );
}

// Add custom cron schedules if they don't exist
add_filter( 'cron_schedules', function ( $schedules ) {
    $schedules['every_2_minutes'] = array(
        'interval' => 120,
        'display'  => __( 'Every 2 Minutes' )
    );
    $schedules['every_5_minutes'] = array(
        'interval' => 300,
        'display'  => __( 'Every 5 Minutes' )
    );
    return $schedules;
});
