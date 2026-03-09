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
        add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_scripts' ) );

        // Register AJAX handlers
        add_action( 'wp_ajax_topup_get_live_data', array( $this, 'ajax_get_live_data' ) );
        add_action( 'wp_ajax_topup_get_analytics', array( $this, 'ajax_get_analytics' ) );
        add_action( 'wp_ajax_topup_get_orders', array( $this, 'ajax_get_orders' ) );
        add_action( 'wp_ajax_topup_get_order_detail', array( $this, 'ajax_get_order_detail' ) );
        add_action( 'wp_ajax_topup_get_order_log', array( $this, 'ajax_get_order_log' ) );
        add_action( 'wp_ajax_topup_admin_control', array( $this, 'ajax_admin_control' ) );
    }

    public function enqueue_scripts( $hook ) {
        if ( strpos( $hook, 'topup-central' ) === false ) {
            return;
        }

        // Add some basic styles for the dashboard cards and layout
        wp_add_inline_style( 'wp-admin', '
            .tc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-top: 20px; box-sizing: border-box; }
            .tc-card { background: #fff; border: 1px solid #ccd0d4; border-radius: 4px; padding: 20px; box-shadow: 0 1px 1px rgba(0,0,0,.04); box-sizing: border-box; overflow: hidden; }
            .tc-card h3 { margin-top: 0; padding-bottom: 10px; border-bottom: 1px solid #eee; font-size: 16px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
            .tc-stat { font-size: 32px; font-weight: 600; line-height: 1.2; text-align: center; margin: 15px 0; }
            .tc-stat-label { text-align: center; color: #646970; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
            
            .tc-badge { display: inline-block; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
            .tc-badge.pending { background: #f0f0f1; color: #3c434a; }
            .tc-badge.claimed { background: #fff8e5; color: #8a6d3b; }
            .tc-badge.submitting { background: #e5f5fa; color: #2271b1; }
            .tc-badge.completed { background: #edfaef; color: #00a32a; }
            .tc-badge.consumed { background: #fef0cd; color: #b86200; }
            .tc-badge.failed, .tc-badge.invalid_id { background: #fcf0f1; color: #d63638; }
            .tc-badge.success { background: #edfaef; color: #00a32a; }
            
            .tc-feed-item { padding: 10px 0; border-bottom: 1px solid #f0f0f1; display: flex; justify-content: space-between; align-items: center; }
            .tc-feed-item:last-child { border-bottom: none; }
            .tc-feed-time { color: #8c8f94; font-size: 12px; width: 60px; }
            .tc-feed-uid { font-weight: 500; font-family: monospace; }
            
            .tc-server-online { border-top: 4px solid #00a32a; }
            .tc-server-stale { border-top: 4px solid #dba617; }
            .tc-server-dead { border-top: 4px solid #d63638; }
            
            .tc-alert { padding: 15px; margin-bottom: 20px; border-left: 4px solid; background: #fff; box-shadow: 0 1px 1px rgba(0,0,0,.04); }
            .tc-alert-danger { border-left-color: #d63638; }
            .tc-alert-warning { border-left-color: #dba617; }
            
            /* CSS Bar Chart */
            .tc-chart-container { height: 180px; display: flex; align-items: flex-end; gap: 4px; padding-top: 20px; margin-top: 20px; border-top: 1px solid #eee; overflow: hidden; width: 100%; box-sizing: border-box; }
            .tc-chart-bar { flex: 1; background: #2271b1; min-height: 2px; border-radius: 2px 2px 0 0; position: relative; transition: height 0.3s; min-width: 2px; }
            .tc-chart-bar:hover { background: #135e96; }
            .tc-chart-bar::after { content: attr(data-val); position: absolute; top: -20px; left: 50%; transform: translateX(-50%); font-size: 10px; color: #646970; opacity: 0; transition: opacity 0.2s; }
            .tc-chart-bar:hover::after { opacity: 1; }
            
            .tc-filters { margin-bottom: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
            .tc-pagination { margin-top: 15px; text-align: right; }
            
            /* Modal Styles */
            .tc-modal-backdrop { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 99999; justify-content: center; align-items: center; }
            .tc-modal { background: #1e1e1e; color: #d4d4d4; width: 90%; max-width: 900px; max-height: 85vh; border-radius: 8px; box-shadow: 0 5px 20px rgba(0,0,0,0.5); display: flex; flex-direction: column; font-family: Consolas, Monaco, monospace; }
            .tc-modal-header { padding: 15px 20px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; background: #252526; border-radius: 8px 8px 0 0; }
            .tc-modal-header h2 { margin: 0; color: #fff; font-size: 16px; font-weight: normal; }
            .tc-modal-close { cursor: pointer; color: #a5a5a5; font-size: 24px; line-height: 1; border: none; background: transparent; padding: 0; }
            .tc-modal-close:hover { color: #fff; }
            .tc-modal-body { padding: 20px; overflow-y: auto; flex: 1; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
            .tc-log-line { margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid #2d2d2d; }
            .tc-log-time { color: #569cd6; }
            .tc-log-lvl-info { color: #4ec9b0; font-weight: bold; }
            .tc-log-lvl-warn { color: #d7ba7d; font-weight: bold; }
            .tc-log-lvl-error { color: #f44747; font-weight: bold; }
            .tc-log-lvl-debug { color: #808080; }
            
            /* Mobile Responsiveness */
            .tc-table-wrapper { width: 100%; overflow-x: auto; border: 1px solid #ccd0d4; margin-top: 15px; }
            .tc-table-wrapper table { border: none; margin-top: 0 !important; }
            
            @media (max-width: 900px) {
                .tc-analytics-grid { grid-template-columns: 1fr !important; }
            }
            @media (max-width: 782px) {
                .tc-grid { grid-template-columns: 1fr !important; }
                .tc-card { padding: 15px; }
                .tc-filters input, .tc-filters select { width: 100% !important; max-width: none; }
                .tc-filters { flex-direction: column; }
            }
        ' );
    }

    public function add_plugin_pages() {
        add_menu_page( 'Topup Central', 'Topup Central', 'manage_options', 'topup-central', array( $this, 'page_dashboard' ), 'dashicons-networking', 30 );
        add_submenu_page( 'topup-central', 'Live Dashboard', 'Live Dashboard', 'manage_options', 'topup-central', array( $this, 'page_dashboard' ) );
        add_submenu_page( 'topup-central', 'Analytics', 'Analytics', 'manage_options', 'topup-central-analytics', array( $this, 'page_analytics' ) );
        add_submenu_page( 'topup-central', 'Order Explorer', 'Order Explorer', 'manage_options', 'topup-central-orders', array( $this, 'page_orders' ) );
        add_submenu_page( 'topup-central', 'Admin Controls', 'Controls', 'manage_options', 'topup-central-controls', array( $this, 'page_controls' ) );
        add_submenu_page( 'topup-central', 'Settings', 'Settings', 'manage_options', 'topup-central-settings', array( $this, 'page_settings' ) );
    }

    // ------------------------------------------------------------------
    // PAGE 1: Live Dashboard
    // ------------------------------------------------------------------
    public function page_dashboard() {
        ?>
        <div class="wrap">
            <h1>Topup Central Live Dashboard <span id="tc-live-indicator" style="font-size: 12px; color: #00a32a; font-weight: normal; margin-left: 10px; padding: 2px 6px; background: #eaffea; border-radius: 3px;">● Live</span></h1>
            
            <div id="tc-rate-limit-banner" style="display:none;" class="tc-alert tc-alert-danger">
                <h3 style="margin:0 0 5px 0;">GLOBAL RATE LIMIT ACTIVE</h3>
                <p style="margin:0;">Triggered by: <strong id="tc-rl-trigger"></strong> | Reason: <strong id="tc-rl-reason"></strong> | Expires in: <strong id="tc-rl-timer" style="font-size: 18px;">--</strong></p>
            </div>
            
            <div id="tc-queue-paused-banner" style="display: <?php echo get_option('topup_queue_paused', 'no') === 'yes' ? 'block' : 'none'; ?>" class="tc-alert tc-alert-warning">
                <h3 style="margin:0 0 5px 0;">QUEUE IS PAUSED</h3>
                <p style="margin:0;">Workers are currently blocked from claiming new vouchers. Go to Controls to resume.</p>
            </div>

            <div class="tc-grid" style="grid-template-columns: repeat(4, 1fr);">
                <div class="tc-card">
                    <h3 style="color:#646970;">Pending</h3>
                    <div class="tc-stat" id="stat-pending">--</div>
                    <div class="tc-stat-label">Awaiting Pickup</div>
                </div>
                <div class="tc-card">
                    <h3 style="color:#2271b1;">Processing</h3>
                    <div class="tc-stat" id="stat-processing" style="color:#2271b1;">--</div>
                    <div class="tc-stat-label">Claimed / Submitting</div>
                </div>
                <div class="tc-card">
                    <h3 style="color:#00a32a;">Completed Today</h3>
                    <div class="tc-stat" id="stat-completed" style="color:#00a32a;">--</div>
                    <div class="tc-stat-label">Success</div>
                </div>
                <div class="tc-card">
                    <h3 style="color:#d63638;">Failed Today</h3>
                    <div class="tc-stat" id="stat-failed" style="color:#d63638;">--</div>
                    <div class="tc-stat-label">Requires Attention</div>
                </div>
            </div>

            <div class="tc-grid" style="grid-template-columns: 2fr 1fr;">
                <!-- Activity Feed (wide, primary) -->
                <div class="tc-card">
                    <h3>Recent Activity</h3>
                    <table class="wp-list-table widefat" style="margin-top:5px;">
                        <thead>
                            <tr>
                                <th style="width:70px;">Claimed At</th>
                                <th>Order ID</th>
                                <th>Player ID</th>
                                <th>Denomination</th>
                                <th>Voucher Code</th>
                                <th>Server</th>
                                <th style="width:70px;">Duration</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody id="tc-activity-feed">
                            <tr><td colspan="8">Loading feed...</td></tr>
                        </tbody>
                    </table>
                </div>

                <!-- Server Fleet (narrow) -->
                <div class="tc-card">
                    <h3>Server Fleet</h3>
                    <div id="tc-server-list" style="display: flex; flex-direction: column; gap: 10px;">
                        Loading servers...
                    </div>
                </div>
            </div>
        </div>

        <script>
            jQuery(document).ready(function($) {
                let rlExpiresAt = 0;
                let timerInterval = null;

                function updateTimer() {
                    if (rlExpiresAt === 0) return;
                    const now = Math.floor(Date.now() / 1000);
                    const diff = rlExpiresAt - now;
                    if (diff <= 0) {
                        $('#tc-rate-limit-banner').hide();
                        rlExpiresAt = 0;
                        clearInterval(timerInterval);
                    } else {
                        const mins = Math.floor(diff / 60);
                        const secs = diff % 60;
                        $('#tc-rl-timer').text(`${mins}:${secs.toString().padStart(2, '0')}`);
                    }
                }

                function fetchLiveData() {
                    $.post(ajaxurl, { action: 'topup_get_live_data' }, function(res) {
                        if(res.success) {
                            // Update Stats
                            $('#stat-pending').text(res.data.stats.pending);
                            $('#stat-processing').text(res.data.stats.processing);
                            $('#stat-completed').text(res.data.stats.completed);
                            $('#stat-failed').text(res.data.stats.failed);

                            // Update Rate Limit
                            if (res.data.rate_limit && res.data.rate_limit.expires_timestamp) {
                                $('#tc-rate-limit-banner').show();
                                $('#tc-rl-trigger').text(res.data.rate_limit.triggered_by);
                                $('#tc-rl-reason').text(res.data.rate_limit.reason);
                                rlExpiresAt = res.data.rate_limit.expires_timestamp;
                                if (!timerInterval) timerInterval = setInterval(updateTimer, 1000);
                                updateTimer();
                            } else {
                                $('#tc-rate-limit-banner').hide();
                                rlExpiresAt = 0;
                            }

                            // Update Servers
                            let serverHtml = '';
                            if (res.data.servers.length === 0) {
                                serverHtml = '<p>No connected servers.</p>';
                            } else {
                                res.data.servers.forEach(s => {
                                    const activeCount = s.active_voucher_ids ? s.active_voucher_ids.split(',').length : 0;
                                    let cls = 'tc-server-online';
                                    let lbl = 'ONLINE';
                                    let col = '#00a32a';
                                    if (s.status === 'dead') { cls = 'tc-server-dead'; lbl = 'DEAD'; col = '#d63638'; }
                                    else if (s.status === 'stale') { cls = 'tc-server-stale'; lbl = 'STALE'; col = '#dba617'; }
                                    
                                    const nicknameText = s.nickname ? ` (<span style="color:#2271b1;font-weight:bold;">${s.nickname}</span>)` : '';
                                    serverHtml += `
                                        <div style="border:1px solid #eee; border-radius:4px; padding:10px;" class="${cls}">
                                            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                                                <strong style="font-size:13px; cursor:pointer;" class="tc-server-rename" data-id="${s.server_id}" data-nick="${s.nickname || ''}" title="Click to rename">${s.server_id}${nicknameText} ✏️</strong>
                                                <span style="font-size:11px; font-weight:bold; color:${col};">${lbl}</span>
                                            </div>
                                            <div style="font-size:12px; color:#646970;">
                                                <div>IP: ${s.ip_address || 'N/A'}</div>
                                                <div>Uptime: ${s.uptime_formatted}</div>
                                                <div>Active Tasks: <strong>${activeCount}</strong></div>
                                                <div style="font-size:10px; margin-top:5px;">Last HRB: ${s.last_heartbeat}</div>
                                            </div>
                                        </div>
                                    `;
                                });
                            }
                            $('#tc-server-list').html(serverHtml);

                            // Update Feed
                            let feedHtml = '';
                            if (res.data.feed.length === 0) {
                                feedHtml = '<tr><td colspan="8">No recent activity.</td></tr>';
                            } else {
                                res.data.feed.forEach(f => {
                                    // Claim time (processing_started_at)
                                    let claimStr = '--:--';
                                    if (f.processing_started_at) {
                                        const d = new Date(f.processing_started_at.replace(/-/g, '/'));
                                        if (!isNaN(d)) claimStr = d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
                                    }

                                    // Duration
                                    let durationStr = '-';
                                    if (f.duration_seconds !== null && f.duration_seconds !== '' && !isNaN(parseInt(f.duration_seconds))) {
                                        const s = parseInt(f.duration_seconds);
                                        const timeText = s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;
                                        
                                        if (f.status === 'claimed' || f.status === 'submitting') {
                                            durationStr = `Claimed ${timeText} ago`;
                                        } else {
                                            durationStr = timeText;
                                        }
                                    } else if (f.status === 'claimed' || f.status === 'submitting') {
                                        durationStr = 'Claimed just now';
                                    }

                                    // Server display — truncate long IDs
                                    const serverDisplay = f.locked_by ? f.locked_by.substring(0, 18) + (f.locked_by.length > 18 ? '…' : '') : '-';

                                    feedHtml += `
                                        <tr>
                                            <td style="font-size:11px; color:#8c8f94;">${claimStr}</td>
                                            <td style="font-size:11px; font-family:monospace;">${f.order_id || '-'}</td>
                                            <td style="font-family:monospace; font-size:12px;">${f.player_id || '-'}</td>
                                            <td style="font-size:12px;">${f.voucher_denomination || '-'}</td>
                                            <td style="font-size:11px; font-family:monospace;">${f.voucher_code || '-'}</td>
                                            <td style="font-size:11px; color:#646970;" title="${f.locked_by || ''}">${serverDisplay}</td>
                                            <td style="font-size:12px; font-weight:600;">${durationStr}</td>
                                            <td><span class="tc-badge ${f.status}">${f.status}</span></td>
                                        </tr>
                                    `;
                                });
                            }
                            $('#tc-activity-feed').html(feedHtml);

                            // Blink indicator
                            $('#tc-live-indicator').fadeOut(100).fadeIn(100);
                        }
                    });
                }

                fetchLiveData();
                setInterval(fetchLiveData, 10000); // UI polls every 10s
                
                // Rename server
                $(document).on('click', '.tc-server-rename', function() {
                    const sid = $(this).data('id');
                    const oldNick = $(this).data('nick');
                    const newNick = prompt(`Enter nickname for Server ${sid}:`, oldNick);
                    
                    if (newNick !== null) {
                        $.post(ajaxurl, {
                            action: 'topup_admin_control',
                            cmd: 'set_server_nickname',
                            server_id: sid,
                            nickname: newNick.trim()
                        }, function(res) {
                            if (!res.success) {
                                alert(res.data.message || 'Error renaming server.');
                            } else {
                                fetchLiveData(); // Force immediate refresh
                            }
                        });
                    }
                });
            });
        </script>
        <?php
    }


    // ------------------------------------------------------------------
    // PAGE 2: Analytics
    // ------------------------------------------------------------------
    public function page_analytics() {
        ?>
        <div class="wrap">
            <h1>Analytics</h1>
            
            <div class="tc-filters">
                <button class="button tc-time-filter button-primary" data-range="today">Today</button>
                <button class="button tc-time-filter" data-range="7days">Last 7 Days</button>
                <button class="button tc-time-filter" data-range="30days">Last 30 Days</button>
                <button class="button tc-time-filter" data-range="all">All Time</button>
            </div>

            <div class="tc-grid">
                <div class="tc-card">
                    <h3>Success Rate</h3>
                    <div class="tc-stat" id="stat-sr" style="color:#2271b1; font-size:48px;">--%</div>
                    <div class="tc-stat-label">Percent Completed</div>
                </div>
                <div class="tc-card">
                    <h3>Total Processed</h3>
                    <div class="tc-stat" id="stat-total">--</div>
                    <div class="tc-stat-label">Vouchers Attempted</div>
                </div>
                <div class="tc-card">
                    <h3>Avg Processing Time</h3>
                    <div class="tc-stat" id="stat-time">--s</div>
                    <div class="tc-stat-label">Per Voucher</div>
                </div>
            </div>

            <div class="tc-grid tc-analytics-grid" style="grid-template-columns: 2fr 1fr;">
                <div class="tc-card">
                    <h3>Hourly Throughput</h3>
                    <div class="tc-chart-container" id="tc-throughput-chart">
                        <!-- Bars injected here -->
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-top:5px; font-size:11px; color:#646970;">
                        <span>24h Ago</span>
                        <span>Now</span>
                    </div>
                </div>
                
                <div class="tc-card">
                    <h3>Failure Breakdown</h3>
                    <table class="wp-list-table widefat striped" style="margin-top:10px;">
                        <thead><tr><th>Reason</th><th>Count</th></tr></thead>
                        <tbody id="tc-fail-table">
                            <tr><td colspan="2">Loading...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <script>
            jQuery(document).ready(function($) {
                let currentRange = 'today';

                $('.tc-time-filter').click(function(e) {
                    $('.tc-time-filter').removeClass('button-primary');
                    $(this).addClass('button-primary');
                    currentRange = $(this).data('range');
                    loadAnalytics();
                });

                function loadAnalytics() {
                    $('#stat-sr, #stat-total, #stat-time').css('opacity', '0.5');
                    $.post(ajaxurl, { action: 'topup_get_analytics', range: currentRange }, function(res) {
                        if(res.success) {
                            $('#stat-sr').text(res.data.success_rate + '%');
                            $('#stat-total').text(res.data.total);
                            $('#stat-time').text(res.data.avg_time + 's');
                            
                            // Failures
                            let fHtml = '';
                            if(res.data.failures.length === 0) fHtml = '<tr><td colspan="2">No failures recorded.</td></tr>';
                            else {
                                res.data.failures.forEach(f => {
                                    // truncate reason
                                    let reason = f.reason ? f.reason.substring(0, 30) + (f.reason.length>30?'...':'') : 'Unknown';
                                    fHtml += `<tr><td title="${f.reason}">${reason}</td><td>${f.count}</td></tr>`;
                                });
                            }
                            $('#tc-fail-table').html(fHtml);

                            // Chart
                            let cHtml = '';
                            let max = 1;
                            res.data.chart.forEach(c => { if(c.count > max) max = c.count; });
                            res.data.chart.forEach(c => {
                                const h = (c.count / max) * 100;
                                cHtml += `<div class="tc-chart-bar" style="height:${h}%;" data-val="${c.count}" title="${c.hour}: ${c.count} vouchers"></div>`;
                            });
                            $('#tc-throughput-chart').html(cHtml);

                            $('#stat-sr, #stat-total, #stat-time').css('opacity', '1');
                        }
                    });
                }
                loadAnalytics();
            });
        </script>
        <?php
    }

    // ------------------------------------------------------------------
    // PAGE 3: Order Explorer
    // ------------------------------------------------------------------
    public function page_orders() {
        ?>
        <div class="wrap">
            <h1>Order Explorer</h1>
            
            <div style="background:#fff; padding:15px; border:1px solid #ccd0d4; margin-bottom:20px; border-radius:4px; display:flex; gap:10px; align-items:center;">
                <input type="text" id="order-search" placeholder="Search Order ID..." style="width:250px;">
                <select id="order-status">
                    <option value="all">All Statuses</option>
                    <option value="pending">Pending</option>
                    <option value="success">Success</option>
                    <option value="failed">Failed</option>
                    <option value="invalid_id">Invalid ID</option>
                </select>
                <button class="button" id="btn-search">Search</button>
            </div>

            <div class="tc-table-wrapper">
                <table class="wp-list-table widefat striped">
                    <thead>
                        <tr>
                            <th>Order ID</th>
                            <th>Created At</th>
                            <th>Status</th>
                            <th>Vouchers</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="orders-tbody">
                        <tr><td colspan="5">Loading orders...</td></tr>
                    </tbody>
                </table>
            </div>
            
            <div class="tc-pagination" id="orders-pagination"></div>

            <!-- Modal for Log Drilldown -->
            <div class="tc-modal-backdrop" id="tc-log-modal">
                <div class="tc-modal">
                    <div class="tc-modal-header">
                        <h2 id="tc-log-title">Logs: Order #...</h2>
                        <button class="tc-modal-close" id="tc-log-close">&times;</button>
                    </div>
                    <div class="tc-modal-body" id="tc-log-content">Loading...</div>
                </div>
            </div>
        </div>

        <script>
            jQuery(document).ready(function($) {
                let page = 1;

                $('#btn-search').click(function() { page = 1; loadOrders(); });
                $(document).on('click', '.page-btn', function() { page = $(this).data('page'); loadOrders(); });

                function loadOrders() {
                    $('#orders-tbody').html('<tr><td colspan="5">Loading orders...</td></tr>');
                    $.post(ajaxurl, { 
                        action: 'topup_get_orders', 
                        page: page, 
                        search: $('#order-search').val(),
                        status: $('#order-status').val()
                    }, function(res) {
                        if(res.success) {
                            let html = '';
                            if(res.data.orders.length === 0) {
                                html = '<tr><td colspan="5">No orders found.</td></tr>';
                            } else {
                                res.data.orders.forEach(o => {
                                    html += `
                                        <tr>
                                            <td><strong>${o.order_id}</strong></td>
                                            <td>${o.created_at}</td>
                                            <td><span class="tc-badge ${o.status}">${o.status}</span></td>
                                            <td>
                                                <button class="button button-small btn-view" data-id="${o.order_id}">View Vouchers</button>
                                                <button class="button button-small btn-log" data-id="${o.order_id}" style="margin-left:4px;">View Log</button>
                                                <button class="button button-small btn-delete" data-id="${o.order_id}" style="color:#d63638; border-color:#d63638; margin-left:4px;">Delete</button>
                                            </td>
                                        </tr>
                                        <tr id="details-${o.order_id}" style="display:none; background:#f6f7f7;">
                                            <td colspan="5" class="details-cell" style="padding:15px;">Loading details...</td>
                                        </tr>
                                    `;
                                });
                            }
                            $('#orders-tbody').html(html);

                            // Pagination
                            let p = '';
                            if (page > 1) p += `<button class="button page-btn" data-page="${page-1}">&laquo; Prev</button> `;
                            p += `<span style="display:inline-block; padding:0 10px;">Page ${page} of ${res.data.total_pages}</span>`;
                            if (page < res.data.total_pages) p += `<button class="button page-btn" data-page="${page+1}">Next &raquo;</button>`;
                            $('#orders-pagination').html(p);
                        }
                    });
                }

                $(document).on('click', '.btn-view', function() {
                    const id = $(this).data('id');
                    const row = $(`#details-${id}`);
                    if(row.is(':visible')) { row.hide(); return; }
                    row.show();
                    
                    $.post(ajaxurl, { action: 'topup_get_order_detail', order_id: id }, function(res) {
                        if(res.success) {
                            let dHtml = '<table class="wp-list-table widefat" style="margin:0;"><thead><tr><th>ID</th><th>Player ID</th><th>Code</th><th>Denom</th><th>Status</th><th>Reason</th><th>Retries</th></tr></thead><tbody>';
                            res.data.forEach(v => {
                                dHtml += `<tr>
                                    <td>#${v.id}</td>
                                    <td>${v.player_id}</td>
                                    <td><code>${v.voucher_code}</code></td>
                                    <td>${v.voucher_denomination}</td>
                                    <td><span class="tc-badge ${v.status}">${v.status}</span></td>
                                    <td style="max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${v.reason}">${v.reason || '-'}</td>
                                    <td>${v.retry_count}</td>
                                </tr>`;
                            });
                            dHtml += '</tbody></table>';
                            row.find('.details-cell').html(dHtml);
                             row.find('.details-cell').html(dHtml);
                        }
                    });
                });

                // JSON Log Viewer logic
                $(document).on('click', '.btn-log', function() {
                    const id = $(this).data('id');
                    const modal = $('#tc-log-modal');
                    const content = $('#tc-log-content');
                    
                    $('#tc-log-title').text(`Logs: Order ${id}`);
                    content.html('Loading log file remotely...');
                    modal.css('display', 'flex');
                    
                    $.post(ajaxurl, { action: 'topup_get_order_log', order_id: id }, function(res) {
                        if(res.success && res.data) {
                            try {
                                const logData = res.data;
                                let out = `<div style="color:#a5a5a5; margin-bottom:15px;">Target: ${logData.order_data?.player_id || 'Unknown UID'} | Created at: ${logData.created_at}</div>`;
                                
                                if (logData.logs && logData.logs.length > 0) {
                                    logData.logs.forEach(l => {
                                        const lvlStr = (l.level || 'INFO').toLowerCase();
                                        const timeStr = l.timestamp ? l.timestamp.replace('T', ' ').substring(0, 19) : '';
                                        let metaStr = '';
                                        
                                        // Inline metadata cleanly
                                        if (l.data && typeof l.data === 'object' && Object.keys(l.data).length > 0) {
                                            metaStr = ` <span style="color:#9cdcfe;">${JSON.stringify(l.data)}</span>`;
                                        }
                                        
                                        out += `<div class="tc-log-line">
                                            <span class="tc-log-time">[${timeStr}]</span> 
                                            <span class="tc-log-lvl-${lvlStr}">[${l.level}]</span> 
                                            ${l.message}${metaStr}
                                        </div>`;
                                    });
                                } else {
                                    out += '<div>No log entries found.</div>';
                                }
                                content.html(out);
                            } catch(e) {
                                content.html(`<div style="color:#f44747;">Parse Error: ${e.message}</div>`);
                            }
                        } else {
                            content.html(`<div style="color:#d7ba7d;">${res.data?.message || 'Error occurred while fetching logs.'}</div>`);
                        }
                    });
                });

                $('#tc-log-close').click(() => $('#tc-log-modal').hide());
                $('#tc-log-modal').click((e) => { if(e.target === e.currentTarget) $('#tc-log-modal').hide(); });

                $(document).on('click', '.btn-delete', function() {
                    const id = $(this).data('id');
                    if(confirm(`WARNING: This will permanently delete Order ${id} and all associated vouchers. Are you sure?`)) {
                        const btn = $(this);
                        btn.prop('disabled', true).text('Deleting...');
                        $.post(ajaxurl, { action: 'topup_admin_control', cmd: 'delete_order', order_id: id }, function(res) {
                            if(res.success) {
                                loadOrders();
                            } else {
                                alert(res.data.message || 'Error deleting order.');
                                btn.prop('disabled', false).text('Delete');
                            }
                        });
                    }
                });

                loadOrders();
            });
        </script>
        <?php
    }

    // ------------------------------------------------------------------
    // PAGE 4: Controls
    // ------------------------------------------------------------------
    public function page_controls() {
        $is_paused = get_option('topup_queue_paused', 'no') === 'yes';
        ?>
        <div class="wrap">
            <h1>Admin Controls</h1>
            <p>Direct intervention tools for queue management.</p>

            <div class="tc-grid" style="grid-template-columns: 1fr 1fr;">
                
                <!-- Queue Pause -->
                <div class="tc-card">
                    <h3>Master Queue Switch</h3>
                    <p>Pausing the queue prevents any Node.js worker from claiming new vouchers. Current processing will finish gracefully.</p>
                    <div style="margin-top:20px;">
                        <?php if ($is_paused): ?>
                            <button class="button button-primary tc-action" data-action="resume_queue" style="background:#00a32a; border-color:#00a32a;">▶ Resume Queue</button>
                            <span style="color:#d63638; font-weight:bold; margin-left:10px;">Queue is currently PAUSED</span>
                        <?php else: ?>
                            <button class="button tc-action" data-action="pause_queue" style="color:#d63638; border-color:#d63638;">⏸ Pause Queue</button>
                            <span style="color:#00a32a; margin-left:10px;">Queue is running normally</span>
                        <?php endif; ?>
                    </div>
                </div>

                <!-- Rate Limit -->
                <div class="tc-card">
                    <h3>Manual Rate Limit</h3>
                    <p>Force all servers to pause API calls instantly. Useful if you notice IP bans starting to occur.</p>
                    <div style="display:flex; gap:10px; margin-top:15px; align-items:center;">
                        <input type="number" id="rl-seconds" value="60" style="width:70px;"> seconds
                        <button class="button button-secondary tc-action" data-action="set_rl">Trigger Limit</button>
                        <button class="button tc-action" data-action="clear_rl">Clear Active Limits</button>
                    </div>
                </div>

                <!-- Retry Vouchers -->
                <div class="tc-card">
                    <h3>Mass Retry</h3>
                    <p>Reset failed vouchers back to pending queue. <strong>WARNING: Only do this if the failure was a transient error.</strong></p>
                    <div style="margin-top:15px;">
                        <button class="button button-secondary tc-action" data-action="retry_failed" onclick="return confirm('Are you sure? This will reset ALL currently failed vouchers to pending state.');">↻ Retry ALL Failed Vouchers (Today)</button>
                    </div>
                </div>

                <!-- Purge Data -->
                <div class="tc-card">
                    <h3>Data Purge</h3>
                    <p>Delete old completed orders and vouchers to free up database space safely.</p>
                    <div style="display:flex; gap:10px; margin-top:15px; align-items:center;">
                        Older than <input type="number" id="purge-days" value="30" style="width:60px;"> days
                        <button class="button tc-action" data-action="purge_data" style="color:#d63638; border-color:#d63638;">🗑 Purge Now</button>
                    </div>
                </div>

            </div>
        </div>

        <script>
            jQuery(document).ready(function($) {
                $('.tc-action').click(function() {
                    const btn = $(this);
                    const action = btn.data('action');
                    let data = { action: 'topup_admin_control', cmd: action };
                    
                    if (action === 'set_rl') data.seconds = $('#rl-seconds').val();
                    if (action === 'purge_data') {
                        data.days = $('#purge-days').val();
                        if(!confirm(`WARNING: This will permanently delete data older than ${data.days} days. Proceed?`)) return;
                    }

                    btn.prop('disabled', true);
                    $.post(ajaxurl, data, function(res) {
                        alert(res.data.message || 'Complete');
                        if (['pause_queue', 'resume_queue'].includes(action)) {
                            location.reload(); // Reload to update UI
                        }
                        btn.prop('disabled', false);
                    }).fail(function() {
                        alert('Request failed.');
                        btn.prop('disabled', false);
                    });
                });
            });
        </script>
        <?php
    }

    // ------------------------------------------------------------------
    // PAGE 5: Settings (Legacy)
    // ------------------------------------------------------------------
    public function page_settings() {
        ?>
        <div class="wrap">
            <h1>Settings</h1>
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
        register_setting( 'topup_central_option_group', 'topup_central_api_key' );
        add_settings_section( 'topup_central_setting_section', 'API Authentication', function(){ echo 'Enter the secret key that all Node.js worker servers must include in the <code>x-api-key</code> HTTP header.'; }, 'topup-central-admin' );
        add_settings_field( 'api_key', 'Worker API Key (x-api-key)', function(){
            $val = esc_attr( get_option( 'topup_central_api_key', 'CHANGE_ME_IN_ADMIN_PANEL' ) );
            echo "<input type='text' id='api_key' name='topup_central_api_key' value='{$val}' size='50' autocomplete='off' />";
        }, 'topup-central-admin', 'topup_central_setting_section' );
    }

    // ------------------------------------------------------------------
    // AJAX HANDLERS
    // ------------------------------------------------------------------

    public function ajax_get_live_data() {
        if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error();
        global $wpdb;
        $tv  = $wpdb->prefix . 'topup_vouchers';
        $ts  = $wpdb->prefix . 'topup_servers';
        $trl = $wpdb->prefix . 'topup_rate_limits';

        // Queue stats for today
        $raw = $wpdb->get_results( "SELECT status, COUNT(*) as c FROM $tv WHERE created_at >= CURDATE() GROUP BY status", ARRAY_A );
        $s   = array( 'pending' => 0, 'processing' => 0, 'completed' => 0, 'failed' => 0 );
        foreach ( $raw as $r ) {
            if ( $r['status'] === 'pending' ) $s['pending'] = (int) $r['c'];
            elseif ( in_array( $r['status'], array( 'claimed', 'submitting' ) ) ) $s['processing'] += (int) $r['c'];
            elseif ( in_array( $r['status'], array( 'completed', 'consumed' ) ) ) $s['completed']  += (int) $r['c'];
            elseif ( in_array( $r['status'], array( 'failed', 'invalid_id' ) ) )  $s['failed']     += (int) $r['c'];
        }

        // Servers
        $servers = $wpdb->get_results( "SELECT * FROM $ts ORDER BY last_heartbeat DESC", ARRAY_A );
        $now_ts  = current_time( 'timestamp' );
        foreach ( $servers as &$srv ) {
            $srv['nickname'] = sanitize_text_field( $srv['nickname'] ?? '' );
            $srv['uptime_formatted'] = gmdate( 'H:i:s', (int) $srv['uptime_seconds'] );
            $stale = strtotime( $srv['last_heartbeat'] ) < ( $now_ts - 300 );
            if ( ! $srv['is_active'] )  $srv['status'] = 'dead';
            elseif ( $stale )           $srv['status'] = 'stale';
            else                        $srv['status'] = 'online';
        }

        // Recent activity feed (last 20 vouchers touched)
        $feed = $wpdb->get_results(
            "SELECT order_id, player_id, voucher_denomination, voucher_code, status, locked_by,
                    processing_started_at,
                    CASE
                        WHEN completed_at IS NOT NULL AND processing_started_at IS NOT NULL
                             THEN TIMESTAMPDIFF(SECOND, processing_started_at, completed_at)
                        WHEN failed_at IS NOT NULL AND processing_started_at IS NOT NULL
                             THEN TIMESTAMPDIFF(SECOND, processing_started_at, failed_at)
                        WHEN processing_started_at IS NOT NULL
                             THEN TIMESTAMPDIFF(SECOND, processing_started_at, NOW())
                        ELSE NULL
                    END AS duration_seconds
             FROM $tv
             ORDER BY COALESCE(completed_at, failed_at, processing_started_at, created_at) DESC
             LIMIT 20",
            ARRAY_A
        );

        // Active rate limit
        $rl = $wpdb->get_row( "SELECT * FROM $trl WHERE active = 1 AND expires_at > NOW() ORDER BY expires_at DESC LIMIT 1", ARRAY_A );
        if ( $rl ) {
            $rl['expires_timestamp'] = strtotime( $rl['expires_at'] );
        }

        wp_send_json_success( array(
            'stats'      => $s,
            'servers'    => $servers,
            'feed'       => $feed,
            'rate_limit' => $rl,
        ) );
    }

    public function ajax_get_analytics() {
        if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error();
        global $wpdb;
        $tv = $wpdb->prefix . 'topup_vouchers';

        $range = isset( $_POST['range'] ) ? sanitize_text_field( $_POST['range'] ) : 'today';
        $where = '';
        if ( $range === 'today' )   $where = 'WHERE created_at >= CURDATE()';
        elseif ( $range === '7days' )  $where = 'WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
        elseif ( $range === '30days' ) $where = 'WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';

        $and = $where ? ' AND ' : ' WHERE ';

        $total   = (int) $wpdb->get_var( "SELECT COUNT(*) FROM $tv $where" );
        $success = (int) $wpdb->get_var( "SELECT COUNT(*) FROM $tv {$where}{$and}status IN ('completed','consumed')" );
        $avg     = (float) $wpdb->get_var( "SELECT AVG(TIMESTAMPDIFF(SECOND, processing_started_at, completed_at)) FROM $tv {$where}{$and}status = 'completed' AND processing_started_at IS NOT NULL" );
        $fails   = $wpdb->get_results(
            "SELECT reason, COUNT(*) as count FROM $tv {$where}{$and}status IN ('failed','invalid_id') GROUP BY reason ORDER BY count DESC LIMIT 10",
            ARRAY_A
        );

        // Chart: last 24 h by hour
        $chart = $wpdb->get_results(
            "SELECT DATE_FORMAT(created_at,'%H:00') as hour, COUNT(*) as count
             FROM $tv
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
             GROUP BY HOUR(created_at)
             ORDER BY created_at ASC",
            ARRAY_A
        );

        wp_send_json_success( array(
            'total'        => $total,
            'success_rate' => $total > 0 ? round( ( $success / $total ) * 100, 1 ) : 0,
            'avg_time'     => round( $avg, 1 ),
            'failures'     => $fails ?: array(),
            'chart'        => $chart ?: array(),
        ) );
    }

    public function ajax_get_orders() {
        if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error();
        global $wpdb;
        $to = $wpdb->prefix . 'topup_orders';
        $tv = $wpdb->prefix . 'topup_vouchers';

        $page   = max( 1, (int) ( $_POST['page'] ?? 1 ) );
        $search = sanitize_text_field( $_POST['search'] ?? '' );
        $status = sanitize_text_field( $_POST['status'] ?? 'all' );
        $limit  = 20;
        $offset = ( $page - 1 ) * $limit;

        $where_parts = array();
        if ( $search ) $where_parts[] = $wpdb->prepare( 'order_id LIKE %s', '%' . $wpdb->esc_like( $search ) . '%' );
        if ( $status !== 'all' ) $where_parts[] = $wpdb->prepare( 'status = %s', $status );
        $where = $where_parts ? 'WHERE ' . implode( ' AND ', $where_parts ) : '';

        $total  = (int) $wpdb->get_var( "SELECT COUNT(*) FROM $to $where" );
        $pages  = max( 1, (int) ceil( $total / $limit ) );
        $orders = $wpdb->get_results(
            "SELECT o.order_id, o.created_at, o.status,
                    (SELECT COUNT(*) FROM $tv v WHERE v.order_id = o.order_id) AS v_count
             FROM $to o $where
             ORDER BY o.created_at DESC
             LIMIT $limit OFFSET $offset",
            ARRAY_A
        );

        wp_send_json_success( array( 'orders' => $orders ?: array(), 'total_pages' => $pages ) );
    }

    public function ajax_get_order_detail() {
        if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error();
        global $wpdb;
        $tv       = $wpdb->prefix . 'topup_vouchers';
        $order_id = sanitize_text_field( $_POST['order_id'] ?? '' );
        $vouchers = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT id, player_id, voucher_code, voucher_denomination, status, reason, retry_count FROM $tv WHERE order_id = %s",
                $order_id
            ),
            ARRAY_A
        );
        wp_send_json_success( $vouchers ?: array() );
    }

    public function ajax_get_order_log() {
        if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error();
        
        $order_id = sanitize_text_field( $_POST['order_id'] ?? '' );
        if ( empty( $order_id ) ) wp_send_json_error( array( 'message' => 'Missing Order ID.' ) );
        
        // Use path from settings
        $log_dir = get_option( 'topup_nodejs_log_path', dirname( ABSPATH, 2 ) . '/Logs' );
        $log_file = rtrim( $log_dir, '/\\' ) . '/' . $order_id . '.json';
        
        if ( ! file_exists( $log_file ) ) {
            wp_send_json_error( array( 'message' => "Log file not found on disk. Expected at:\n" . $log_file ) );
        }
        
        $json_data = file_get_contents( $log_file );
        $decoded = json_decode( $json_data, true );
        
        if ( json_last_error() !== JSON_ERROR_NONE ) {
            wp_send_json_error( array( 'message' => "Log file exists but contains invalid or corrupted JSON." ) );
        }
        
        wp_send_json_success( $decoded );
    }

    public function ajax_admin_control() {
        if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error();
        global $wpdb;
        $cmd = sanitize_text_field( $_POST['cmd'] ?? '' );

        if ( $cmd === 'pause_queue' ) {
            update_option( 'topup_queue_paused', 'yes' );
            wp_send_json_success( array( 'message' => 'Queue paused. Workers will stop picking up new vouchers.' ) );
        }
        elseif ( $cmd === 'resume_queue' ) {
            update_option( 'topup_queue_paused', 'no' );
            wp_send_json_success( array( 'message' => 'Queue resumed.' ) );
        }
        elseif ( $cmd === 'set_rl' ) {
            $sec = max( 1, (int) ( $_POST['seconds'] ?? 60 ) );
            $trl = $wpdb->prefix . 'topup_rate_limits';
            $wpdb->insert( $trl, array(
                'triggered_by' => 'ADMIN',
                'reason'       => 'Manual pause via WordPress dashboard',
                'active'       => 1,
                'expires_at'   => gmdate( 'Y-m-d H:i:s', time() + $sec ),
            ) );
            wp_send_json_success( array( 'message' => "Rate limit activated for {$sec} seconds." ) );
        }
        elseif ( $cmd === 'clear_rl' ) {
            $trl = $wpdb->prefix . 'topup_rate_limits';
            $wpdb->query( "UPDATE $trl SET active = 0 WHERE active = 1" );
            wp_send_json_success( array( 'message' => 'All active rate limits cleared.' ) );
        }
        elseif ( $cmd === 'retry_failed' ) {
            $tv    = $wpdb->prefix . 'topup_vouchers';
            $count = $wpdb->query(
                "UPDATE $tv SET status = 'pending', locked_by = NULL, retry_count = 0, reason = '[Admin Manual Retry]'
                 WHERE status IN ('failed','invalid_id') AND created_at >= CURDATE()"
            );
            wp_send_json_success( array( 'message' => "Reset {$count} failed vouchers to pending." ) );
        }
        elseif ( $cmd === 'purge_data' ) {
            $days = max( 1, (int) ( $_POST['days'] ?? 30 ) );
            $to   = $wpdb->prefix . 'topup_orders';
            $tv   = $wpdb->prefix . 'topup_vouchers';

            $old_ids = $wpdb->get_col(
                $wpdb->prepare( "SELECT order_id FROM $to WHERE created_at < DATE_SUB(NOW(), INTERVAL %d DAY)", $days )
            );

            if ( empty( $old_ids ) ) {
                wp_send_json_success( array( 'message' => 'No old data found to purge.' ) );
            }

            $placeholders = implode( ',', array_fill( 0, count( $old_ids ), '%s' ) );
            $wpdb->query( $wpdb->prepare( "DELETE FROM $tv WHERE order_id IN ($placeholders)", $old_ids ) );
            $del = $wpdb->query( $wpdb->prepare( "DELETE FROM $to WHERE order_id IN ($placeholders)", $old_ids ) );
            wp_send_json_success( array( 'message' => "Purged {$del} orders and all associated vouchers." ) );
        }
        elseif ( $cmd === 'set_server_nickname' ) {
            $server_id = sanitize_text_field( $_POST['server_id'] ?? '' );
            $nickname  = sanitize_text_field( $_POST['nickname'] ?? '' );
            $ts        = $wpdb->prefix . 'topup_servers';
            
            if ( empty( $server_id ) ) wp_send_json_error( array( 'message' => 'Missing server ID.' ) );
            
            $wpdb->update( $ts, array( 'nickname' => $nickname ), array( 'server_id' => $server_id ) );
            wp_send_json_success( array( 'message' => 'Nickname updated successfully.' ) );
        }
        elseif ( $cmd === 'delete_order' ) {
            $order_id = sanitize_text_field( $_POST['order_id'] ?? '' );
            if ( empty( $order_id ) ) wp_send_json_error( array( 'message' => 'Missing Order ID.' ) );
            
            $to   = $wpdb->prefix . 'topup_orders';
            $tv   = $wpdb->prefix . 'topup_vouchers';
            $wpdb->delete( $tv, array( 'order_id' => $order_id ) );
            $deleted = $wpdb->delete( $to, array( 'order_id' => $order_id ) );
            
            if ( $deleted ) {
                wp_send_json_success( array( 'message' => "Order $order_id and its vouchers were permanently deleted." ) );
            } else {
                wp_send_json_error( array( 'message' => "Order not found or could not be deleted." ) );
            }
        }
        else {
            wp_send_json_error( array( 'message' => 'Unknown command.' ) );
        }
    }

}

if ( is_admin() ) {
    new Topup_Central_Admin();
}
