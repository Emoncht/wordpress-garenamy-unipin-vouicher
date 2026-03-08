<?php
/**
 * Admin Settings & Dashboards for Topup Central
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class Topup_Central_Admin {

    public function __construct() {
        add_action( 'admin_menu', array( $this, 'add_plugin_pages' ) );
        add_action( 'admin_init', array( $this, 'page_init' ) );
    }

    public function add_plugin_pages() {
        // Main Menu - Topup Central (Defaults to Settings)
        add_menu_page(
            'Topup Central', 
            'Topup Central', 
            'manage_options', 
            'topup-central', 
            array( $this, 'page_settings' ),
            'dashicons-networking', // Icon
            30 // Position
        );

        // Submenu: Settings
        add_submenu_page(
            'topup-central', 
            'Topup Central Settings', 
            'Settings', 
            'manage_options', 
            'topup-central', 
            array( $this, 'page_settings' )
        );

        // Submenu: Analytics
        add_submenu_page(
            'topup-central', 
            'Topup Central Analytics', 
            'Analytics', 
            'manage_options', 
            'topup-central-analytics', 
            array( $this, 'page_analytics' )
        );

        // Submenu: Queue & Servers
        add_submenu_page(
            'topup-central', 
            'Queue & Servers', 
            'Queue & Servers', 
            'manage_options', 
            'topup-central-queue', 
            array( $this, 'page_queue' )
        );
    }

    /**
     * Page 1: Settings
     */
    public function page_settings() {
        ?>
        <div class="wrap">
            <h1>Topup Central Settings</h1>
            <p>Configure the authentication parameters used by your remote Node.js worker servers.</p>
            <form method="post" action="options.php">
                <?php
                    settings_fields( 'topup_central_option_group' );
                    do_settings_sections( 'topup-central-admin' );
                    submit_button();
                ?>
            </form>
        </div>
        <?php
    }

    public function page_init() {
        register_setting(
            'topup_central_option_group',
            'topup_central_api_key'
        );

        add_settings_section(
            'topup_central_setting_section',
            'API Authentication',
            array( $this, 'section_info' ),
            'topup-central-admin'
        );

        add_settings_field(
            'api_key',
            'Worker API Key (x-api-key)',
            array( $this, 'api_key_callback' ),
            'topup-central-admin',
            'topup_central_setting_section'
        );
    }

    public function section_info() {
        echo 'Enter the secret key that all Node.js worker servers must include in the <code>x-api-key</code> HTTP header.';
    }

    public function api_key_callback() {
        $val = esc_attr( get_option( 'topup_central_api_key', 'CHANGE_ME_IN_ADMIN_PANEL' ) );
        echo "<input type='text' id='api_key' name='topup_central_api_key' value='{$val}' size='50' autocomplete='off' />";
    }


    /**
     * Page 2: Analytics
     */
    public function page_analytics() {
        global $wpdb;
        $table_orders = $wpdb->prefix . 'topup_orders';
        $table_vouchers = $wpdb->prefix . 'topup_vouchers';

        // Lifetime stats
        $lifetime_orders = $wpdb->get_var("SELECT COUNT(*) FROM $table_orders");
        
        $status_breakdown = $wpdb->get_results("SELECT status, COUNT(*) as count FROM $table_vouchers GROUP BY status", ARRAY_A);
        
        $total_vouchers = 0;
        $completed_vouchers = 0;
        $failed_vouchers = 0;
        foreach ($status_breakdown as $row) {
            $total_vouchers += $row['count'];
            if (in_array($row['status'], ['completed', 'consumed'])) {
                $completed_vouchers += $row['count'];
            }
            if ($row['status'] === 'failed' || strpos($row['status'], 'max_retries') !== false) {
                $failed_vouchers += $row['count'];
            }
        }

        $success_rate = $total_vouchers > 0 ? round(($completed_vouchers / $total_vouchers) * 100, 2) : 0;

        ?>
        <div class="wrap">
            <h1>Topup Central Analytics</h1>
            <p>Lifetime performance and throughput metrics.</p>

            <div style="display:flex; gap: 20px; margin-top: 20px;">
                <div style="flex:1; background:#fff; border:1px solid #ccd0d4; padding:20px; text-align:center;">
                    <h3 style="margin-top:0;">Lifetime Orders</h3>
                    <div style="font-size:36px; font-weight:bold; color:#2271b1;"><?php echo esc_html($lifetime_orders); ?></div>
                </div>
                <div style="flex:1; background:#fff; border:1px solid #ccd0d4; padding:20px; text-align:center;">
                    <h3 style="margin-top:0;">Vouchers Processed</h3>
                    <div style="font-size:36px; font-weight:bold; color:#00a32a;"><?php echo esc_html($completed_vouchers); ?></div>
                </div>
                <div style="flex:1; background:#fff; border:1px solid #ccd0d4; padding:20px; text-align:center;">
                    <h3 style="margin-top:0;">Success Rate</h3>
                    <div style="font-size:36px; font-weight:bold; color:#dba617;"><?php echo esc_html($success_rate); ?>%</div>
                </div>
            </div>

            <div style="margin-top:20px; background:#fff; border:1px solid #ccd0d4; padding:15px;">
                <h3>Status Breakdown (Lifetime Vouchers)</h3>
                <table class="wp-list-table widefat striped">
                    <thead><tr><th>Status</th><th>Count</th></tr></thead>
                    <tbody>
                    <?php if (empty($status_breakdown)): ?>
                        <tr><td colspan="2">No data available.</td></tr>
                    <?php else: ?>
                        <?php foreach($status_breakdown as $row): ?>
                        <tr>
                            <td><strong><?php echo esc_html(ucfirst($row['status'])); ?></strong></td>
                            <td><?php echo esc_html($row['count']); ?></td>
                        </tr>
                        <?php endforeach; ?>
                    <?php endif; ?>
                    </tbody>
                </table>
            </div>

        </div>
        <?php
    }

    /**
     * Page 3: Queue & Servers
     */
    public function page_queue() {
        global $wpdb;
        $table_servers     = $wpdb->prefix . 'topup_servers';
        $table_rate_limits = $wpdb->prefix . 'topup_rate_limits';
        $table_vouchers    = $wpdb->prefix . 'topup_vouchers';

        // 1. Get Servers
        $servers = $wpdb->get_results( "SELECT * FROM $table_servers ORDER BY last_heartbeat DESC" );

        // 2. Get Global Rate Limit
        $rate_limit = $wpdb->get_row("SELECT * FROM $table_rate_limits WHERE active = 1 AND expires_at > NOW() ORDER BY expires_at DESC LIMIT 1");

        // 3. Get Queue Status (Today)
        $queue_counts = $wpdb->get_results("SELECT status, COUNT(*) as count FROM $table_vouchers WHERE created_at >= CURDATE() GROUP BY status", ARRAY_A);
        $counts = array('pending'=>0, 'claimed'=>0, 'submitting'=>0, 'completed'=>0, 'consumed'=>0, 'failed'=>0);
        if ($queue_counts) {
            foreach ($queue_counts as $row) {
                if (isset($counts[$row['status']])) $counts[$row['status']] = $row['count'];
            }
        }
        ?>
        <div class="wrap">
            <h1>Queue & Connected Servers</h1>
            <p>Real-time monitoring of the distributed top-up queue and worker server health.</p>
            
            <div style="display:flex; gap: 20px; margin-top:20px;">
                <!-- Queue Stats -->
                <div style="flex:1; background:#fff; border:1px solid #ccd0d4; padding:15px;">
                    <h3 style="margin-top:0;">Queue Status (Today)</h3>
                    <ul>
                        <li><strong>Pending (Awaiting Pickup):</strong> <?php echo esc_html($counts['pending']); ?></li>
                        <li><strong>Claimed/Locked:</strong> <?php echo esc_html($counts['claimed']); ?></li>
                        <li><strong>Submitting:</strong> <?php echo esc_html($counts['submitting']); ?></li>
                        <li><strong style="color:green;">Completed:</strong> <?php echo esc_html($counts['completed']); ?></li>
                        <li><strong style="color:orange;">Consumed:</strong> <?php echo esc_html($counts['consumed']); ?></li>
                        <li><strong style="color:red;">Failed/Retrying:</strong> <?php echo esc_html($counts['failed']); ?></li>
                    </ul>
                </div>

                <!-- Global Limits -->
                <div style="flex:1; background:#fff; border:1px solid #ccd0d4; padding:15px;">
                    <h3 style="margin-top:0;">Global Rate Limits</h3>
                    <?php if ($rate_limit): ?>
                        <div style="padding:10px; background:#fbeaea; border-left:4px solid #dc3232;">
                            <strong>ACTIVE RATE LIMIT DETECTED</strong><br>
                            Reason: <?php echo esc_html($rate_limit->reason); ?><br>
                            Triggered By: <?php echo esc_html($rate_limit->triggered_by); ?><br>
                            Expires At: <?php echo esc_html($rate_limit->expires_at); ?> (Server Time)
                        </div>
                    <?php else: ?>
                        <p style="color:green; margin: 0; padding:10px; background:#eaffea; border-left:4px solid green;">
                            <strong>No active global rate limits.</strong> Servers are processing normally.
                        </p>
                    <?php endif; ?>
                </div>
            </div>

            <!-- Connected Servers -->
            <div style="margin-top:20px; background:#fff; border:1px solid #ccd0d4; padding:15px;">
                <h3 style="margin-top:0;">Connected Worker Servers</h3>
                <table class="wp-list-table widefat striped table-view-list">
                    <thead>
                        <tr>
                            <th>Server</th>
                            <th>Status</th>
                            <th>Telemetry</th>
                            <th>Last Heartbeat</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php if (empty($servers)): ?>
                            <tr><td colspan="4">No servers registered yet. Node.js workers auto-register via heartbeat.</td></tr>
                        <?php else: ?>
                            <?php foreach($servers as $s): 
                                $is_active = $s->is_active;
                                $stale = strtotime($s->last_heartbeat) < (time() - 300); // STALE IF > 5 MINS
                                
                                if (!$is_active) {
                                    $status_text = 'Dead (Locks swept)';
                                    $status_color = 'red';
                                } elseif ($stale) {
                                    $status_text = 'Offline (Stale heartbeat)';
                                    $status_color = 'orange';
                                } else {
                                    $status_text = 'Online (Healthy)';
                                    $status_color = 'green';
                                }
                            ?>
                            <tr>
                                <td><strong><?php echo esc_html($s->server_id); ?></strong> <br><small><?php echo esc_html($s->label); ?></small></td>
                                <td style="color: <?php echo $status_color; ?>; font-weight:bold;"><?php echo $status_text; ?></td>
                                <td>
                                    <?php if (!empty($s->ip_address)): ?>IP: <?php echo esc_html($s->ip_address); ?><br><?php endif; ?>
                                    <?php if (!empty($s->uptime_seconds)): ?>Uptime: <?php echo esc_html(gmdate("H:i:s", $s->uptime_seconds)); ?><br><?php endif; ?>
                                    <?php if (!empty($s->active_voucher_ids)): ?><small>Task IDs: <?php echo esc_html($s->active_voucher_ids); ?></small><?php endif; ?>
                                </td>
                                <td><?php echo esc_html($s->last_heartbeat); ?></td>
                            </tr>
                            <?php endforeach; ?>
                        <?php endif; ?>
                    </tbody>
                </table>
            </div>
        </div>
        <?php
    }
}

if ( is_admin() ) {
    new Topup_Central_Admin();
}
