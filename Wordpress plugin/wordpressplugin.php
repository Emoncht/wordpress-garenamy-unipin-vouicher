<?php
/*
Plugin Name: Custom Order Plugin POSTAPI
Plugin URI: https://example.com/
Description: A plugin to handle custom order requests, update WooCommerce orders, and prevent re‐sending of completed/consumed vouchers.
Version: 2.3
Author: Your Name
Author URI: https://example.com/
*/

// Global variables for database version and table name
global $custom_order_plugin_db_version;
$custom_order_plugin_db_version = '1.0';
global $voucher_table_name;
global $wpdb;
if ( defined( 'ABSPATH' ) ) {
    $voucher_table_name = $wpdb->prefix . 'voucher_deails_resend';
}

/* -------------------------------------------------
   Plugin Activation: Create custom table
-------------------------------------------------- */
function custom_order_plugin_activate() {
    global $wpdb, $voucher_table_name, $custom_order_plugin_db_version;
    
    require_once( ABSPATH . 'wp-admin/includes/upgrade.php' );
    
    $charset_collate = $wpdb->get_charset_collate();
    
    $sql = "CREATE TABLE $voucher_table_name (
        id mediumint(9) NOT NULL AUTO_INCREMENT,
        order_id varchar(50) NOT NULL,
        voucher_code varchar(100) NOT NULL,
        voucher_status varchar(50) NOT NULL,
        used_time varchar(50) NOT NULL,
        transaction_id varchar(100) DEFAULT '',
        screenshot_url text,
        created_at datetime DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY  (id),
        KEY order_voucher (order_id, voucher_code)
    ) $charset_collate;";
    
    dbDelta( $sql );
    
    add_option( 'custom_order_plugin_db_version', $custom_order_plugin_db_version );
}
register_activation_hook( __FILE__, 'custom_order_plugin_activate' );

add_action('rest_api_init', function () {
    register_rest_route(
        'custom-order-plugin/v1', 
        '/check', 
        array(
            'methods'             => 'POST',
            'callback'            => 'custom_order_check_endpoint',
            'permission_callback' => 'custom_order_api_permission_check'
        )
    );
});

/**
 * Permission Callback 
 * Ensures the request has our custom x-api-key header
 */
function custom_order_api_permission_check(WP_REST_Request $request) {
    // The API key you expect the client to provide.
    $valid_api_key = 'YOUR_SECRET_API_KEY';  // Replace with your real key.

    // Retrieve the provided key from the "x-api-key" header.
    $provided_api_key = $request->get_header('x-api-key');
    if ($provided_api_key && $provided_api_key === $valid_api_key) {
        return true;
    }

    return new WP_Error(
        'rest_forbidden',
        __('You do not have permissions.'),
        array('status' => 401)
    );
}

/**
 * Callback function for handling the POST /check request
 */
function custom_order_check_endpoint(WP_REST_Request $request) {
    global $wpdb, $voucher_table_name;
    // Example: $voucher_table_name = $wpdb->prefix . 'my_voucher_table';
    // Make sure this variable is set correctly in your plugin code.

    // 1. Sanitize and retrieve the order_id parameter
    $order_id = sanitize_text_field($request->get_param('order_id'));
    if (empty($order_id)) {
        return new WP_Error(
            'missing_order_id',
            'Order ID is required.',
            array('status' => 400)
        );
    }

    // 2. Fetch records from the custom voucher table
    $results = $wpdb->get_results(
        $wpdb->prepare(
            "SELECT * FROM $voucher_table_name WHERE order_id = %s ORDER BY id DESC",
            $order_id
        ),
        ARRAY_A
    );


    // 3. If no rows are found, you can return a 404 or your preferred response
    if (empty($results)) {
        return new WP_Error(
            'order_not_found',
            "No vouchers found for order: {$order_id}",
            array('status' => 404)
        );
    }

    // 4. Return the data
    return array(
        'order_id' => $order_id,
        'vouchers' => $results
    );
}

/* -------------------------------------------------
   REST API Endpoint Registration
-------------------------------------------------- */
function custom_order_plugin_register_rest_route() {
    register_rest_route('custom-order-plugin/v1', '/orders', array(
        'methods'             => 'POST',
        'callback'            => 'custom_order_plugin_handle_order_request',
        'permission_callback' => '__return_true', // Adjust permissions as needed
    ));
}
add_action('rest_api_init', 'custom_order_plugin_register_rest_route');

/* -------------------------------------------------
   Handle incoming order request
-------------------------------------------------- */
function custom_order_plugin_handle_order_request(WP_REST_Request $request) {
    $response_data = $request->get_json_params();

    if (empty($response_data['result']) || empty($response_data['result']['order_id'])) {
        return new WP_REST_Response(array(
            'message' => 'Missing order ID',
        ), 400);
    }

    $order_data = $response_data['result'];
    $order_id = sanitize_text_field($order_data['order_id']);

    // Process the API response (including storing voucher details in custom table)
    try {
        custom_order_plugin_handle_api_response($order_id, $response_data);
    } catch (Exception $e) {
        error_log('Error processing API response for order ' . $order_id . ': ' . $e->getMessage());
        return new WP_REST_Response(array(
            'message' => 'Error processing order data',
        ), 500);
    }

    return new WP_REST_Response(array(
        'message'  => 'Order data processed successfully',
        'order_id' => $order_id,
    ), 200);
}






/* -------------------------------------------------
   Helper Functions: DB operations for Voucher Table
-------------------------------------------------- */
function custom_order_plugin_get_voucher_record($order_id, $voucher_code) {
    global $wpdb, $voucher_table_name;
    return $wpdb->get_row( $wpdb->prepare(
        "SELECT * FROM $voucher_table_name WHERE order_id = %s AND voucher_code = %s",
        $order_id, $voucher_code
    ) );
}

function custom_order_plugin_insert_voucher_record($order_id, $voucher_data) {
    global $wpdb, $voucher_table_name;
    $wpdb->insert(
        $voucher_table_name,
        array(
            'order_id'        => $order_id,
            'voucher_code'    => $voucher_data['voucher_code'],
            'voucher_status'  => $voucher_data['voucher_status'],
            'used_time'       => $voucher_data['used_time'],
            'transaction_id'  => $voucher_data['transaction_id'],
            'screenshot_url'  => $voucher_data['screenshot_url']
        ),
        array('%s', '%s', '%s', '%s', '%s', '%s')
    );
}

/* -------------------------------------------------
   Handle API Response from Backend and Build Order Note
-------------------------------------------------- */
function custom_order_plugin_handle_api_response($order_id, $response_data) {
    $order = wc_get_order($order_id);
    if (!$order) {
    //    error_log('Order not found with ID: ' . $order_id);
        return;
    }
//error_log('API Response for Order ID ' . $order_id . ': ' . json_encode($response_data, JSON_PRETTY_PRINT));

    $result = $response_data['result'];
    $response_order_id = isset($result['order_id']) ? sanitize_text_field($result['order_id']) : $order_id;
    $order_status = sanitize_text_field($result['order_status']);
    $vouchers = $result['vouchers'];
    $invalid_ids = isset($result['invalid_ids']) ? $result['invalid_ids'] : array();
    $total_time_taken = isset($result['totaltimetaken']) ? sanitize_text_field($result['totaltimetaken']) : 'N/A';
    
    
    
    
if (strtolower($order_status) === 'server-mismatch') {
    //error_log("Order ID $order_id: API order_status is 'server-mismatch', updating status to wrong-server.");
    $order->update_status('wrong-server', 'Order status updated to wrong server due to server mismatch.');
    
    // Add customer note in Bengali
    $customer_note = "আপনার অর্ডার নম্বর - $order_id\nঅর্ডার স্ট্যাটাস - Wrong server\nআপনার দেওয়া প্লেয়ার আইডি কোড টি ভুল, সঠিক আইডি কোড টি আমাদের হোয়াটসএপ হেল্পলাইনে দিন। এবং এই ইমেইল টির স্ক্রিনশট তুলে আমাদের সাপোর্ট এ দিন। নয়তো আপনার অর্ডার ডেলিভারি করা যাবেনা।";
    $order->add_order_note($customer_note, true);
    return;
}

if (strtolower($order_status) === 'invalid_id') {
    $order->update_status('vuul-uid', 'Order status updated to vuul uid due to invalid ID.');
    
    // Add customer note in Bengali
    $customer_note = "আপনার অর্ডার নম্বর - $order_id\nঅর্ডার স্ট্যাটাস - vuul uid\nআপনার দেওয়া প্লেয়ার আইডি কোড টি ভুল, সঠিক আইডি কোড টি আমাদের হোয়াটসএপ হেল্পলাইনে দিন। এবং এই ইমেইল টির স্ক্রিনশট তুলে আমাদের সাপোর্ট এ দিন। নয়তো আপনার অর্ডার ডেলিভারি করা যাবেনা।";
    $order->add_order_note($customer_note, true);
    return;
}

    
    
    
    
    
if (!empty($invalid_ids)) {
 //   error_log("Order ID $order_id is set to 'vuul-uid' due to invalid IDs: " . json_encode($invalid_ids));
    $order->update_status('vuul-uid', 'Order status updated to vuul uid due to invalid IDs.');
    
    // Add customer note in Bengali
    $customer_note = "আপনার অর্ডার নম্বর - $order_id\nঅর্ডার স্ট্যাটাস - vuul uid\nআপনার দেওয়া প্লেয়ার আইডি কোড টি ভুল, সঠিক আইডি কোড টি আমাদের হোয়াটসএপ হেল্পলাইনে দিন। এবং এই ইমেইল টির স্ক্রিনশট তুলে আমাদের সাপোর্ট এ দিন। নয়তো আপনার অর্ডার ডেলিভারি করা যাবেনা।";
    $order->add_order_note($customer_note, true);
    return;
}

    
    $note_content = "Order Update:\n===========\n\nOrder ID: $response_order_id\nOrder Status: $order_status\nTotal Time Taken: $total_time_taken\n\nVouchers:\n";
foreach ($vouchers as $index => $voucher) {
    $voucher_status   = strtolower(sanitize_text_field($voucher['status']));
    $voucher_code     = sanitize_text_field($voucher['voucher_code']);
    $used_time        = sanitize_text_field($voucher['used_time']);
    $transaction_id   = sanitize_text_field($voucher['transaction_id']);
    $screenshot       = sanitize_text_field($voucher['screenshot']);
    $time_taken       = isset($voucher['timetaken']) ? sanitize_text_field($voucher['timetaken']) : 'N/A';

    $existing = custom_order_plugin_get_voucher_record($order_id, $voucher_code);

    // Prepare new screenshot URL if provided
    $new_screenshot_url = '';
    if (!empty($screenshot)) {
        $upload_dir = wp_upload_dir();
        $orders_dir = $upload_dir['basedir'] . '/orders';
        if (!file_exists($orders_dir)) {
            mkdir($orders_dir, 0755, true);
        }
        $filename = 'screenshot_' . $response_order_id . '_' . uniqid() . '.jpg';
        $screenshot_path = $orders_dir . '/' . $filename;
        file_put_contents($screenshot_path, base64_decode($screenshot));
        $new_screenshot_url = $upload_dir['baseurl'] . '/orders/' . $filename;
    }

    if ($existing) {
        $stored_status           = $existing->voucher_status;
        $stored_used_time        = $existing->used_time;
        $stored_transaction_id   = $existing->transaction_id;
        $stored_screenshot_url   = $existing->screenshot_url;

        // Logic to determine if we should update the record
        $should_update = false;

        // 1. If existing is 'completed', it is final. Do not update.
        if ($stored_status === 'completed') {
            $should_update = false;
        }
        // 2. If existing is passed/consumed/final, do not revert to non-final status (like processing/failed)
        elseif (in_array($stored_status, array('consumed', 'success')) && !in_array($voucher_status, array('completed', 'consumed', 'success'))) {
            $should_update = false;
        }
        // 3. Otherwise, update (Processing -> Completed, Failed -> Processing, etc.)
        else {
            $should_update = true;
        }

        if ($should_update) {
            $update_data = array(
                'voucher_status' => $voucher_status,
                'used_time'      => $used_time,
                'transaction_id' => $transaction_id,
            );
            if ($new_screenshot_url) {
                $update_data['screenshot_url'] = $new_screenshot_url;
                $stored_screenshot_url = $new_screenshot_url;
            }

            global $wpdb, $voucher_table_name;
            $wpdb->update(
                $voucher_table_name,
                $update_data,
                array(
                    'order_id'     => $order_id,
                    'voucher_code' => $voucher_code,
                ),
                array('%s', '%s', '%s', '%s'),
                array('%s', '%s')
            );
            $stored_status         = $voucher_status;
            $stored_used_time      = $used_time;
            $stored_transaction_id = $transaction_id;
        }
    } else {
        // No existing record - Insert new record regardless of status
        if ($new_screenshot_url) {
            $stored_screenshot_url = $new_screenshot_url;
        } else {
            $stored_screenshot_url = ''; 
        }

        $voucher_data = array(
            'voucher_code'   => $voucher_code,
            'voucher_status' => $voucher_status,
            'used_time'      => $used_time,
            'transaction_id' => $transaction_id,
            'screenshot_url' => $stored_screenshot_url,
        );
        custom_order_plugin_insert_voucher_record($order_id, $voucher_data);
        $stored_status         = $voucher_status;
        $stored_used_time      = $used_time;
        $stored_transaction_id = $transaction_id;
    }

    // Append voucher details to the order note.
    $note_content .= "\nVoucher " . ($index + 1) . ":\n  Status: $stored_status\n  Voucher Code: `$voucher_code`\n  Time Taken: $time_taken\n  Used Time: $stored_used_time\n  Transaction ID: $stored_transaction_id\n  Screenshot: <a href='$stored_screenshot_url' target='_blank'>View Screenshot</a>\n";
}

// After processing each voucher and appending details to $note_content

// Determine voucher counts for order status logic.
$failed_vouchers            = false;
$topupfailed_vouchers       = false;
$captcha_vouchers           = false;
$consumed_or_complete_count = 0;
$total_vouchers = count(isset($vouchers) && is_array($vouchers) ? $vouchers : array());


foreach ($vouchers as $voucher) {
    $status = strtolower(sanitize_text_field($voucher['status']));
    if ($status === 'failed') {
        $failed_vouchers = true;
    } elseif ($status === 'captcha') {
        $captcha_vouchers = true;
    } elseif ($status === 'topupfailed') {
        $topupfailed_vouchers = true;
    } elseif ($status === 'completed' || $status === 'consumed') {
        $consumed_or_complete_count++;
    }
}

if ($total_vouchers > 0) {
    // Only update order status if at least one voucher is provided.
    if (
        $consumed_or_complete_count === $total_vouchers &&
        !$failed_vouchers &&
        !$captcha_vouchers &&
        !$topupfailed_vouchers
    ) {
        $order->update_status('completed', 'Order completed based on API response - all vouchers successfully processed.');
    } else {
        $msg = 'Order status not updated. ';
        if ($failed_vouchers) {
            $msg .= 'Failed vouchers detected. ';
        }
        if ($captcha_vouchers) {
            $msg .= 'Captcha required for some vouchers. ';
        }
        if ($topupfailed_vouchers) {
            $msg .= 'Top-up failed for some vouchers. ';
        }
        if ($consumed_or_complete_count < $total_vouchers) {
            $msg .= sprintf('Only %d out of %d vouchers completed successfully.', $consumed_or_complete_count, $total_vouchers);
        }
        $order->add_order_note($msg, false);
    }
} else {
    // No vouchers provided – add an order note with the raw JSON response.
    $raw_response = json_encode($response_data);
    $order->add_order_note("No vouchers provided in API response. Raw response: $raw_response", false);
}

// Clear previous "Order Update" notes to prevent clutter and keep only the latest snapshot
$existing_notes = get_comments(array(
    'post_id' => $order_id,
    'type'    => 'order_note',
));
foreach ($existing_notes as $note) {
    if (strpos($note->comment_content, "Order Update:\n===========") === 0) {
        wp_delete_comment($note->comment_ID, true);
    }
}

// Finally, add the detailed voucher note.
$order->add_order_note($note_content, false);

}

/* -------------------------------------------------
   Helper: Filter Payload for Resend based on Custom Table
-------------------------------------------------- */
function custom_order_plugin_filter_payload($order_id, $payload) {
    global $wpdb, $voucher_table_name;
    $filtered_payload = $payload;
    $already_processed = array();
    if (is_string($filtered_payload)) {
        $filtered_payload = json_decode($filtered_payload, true);
    }
    if (!isset($filtered_payload['order_items'])) {
        return array($payload, $already_processed);
    }
    foreach ($filtered_payload['order_items'] as &$order_item) {
        if (!isset($order_item['items'])) continue;
        foreach ($order_item['items'] as &$item) {
            if (!isset($item['voucher_data'])) continue;
            foreach ($item['voucher_data'] as &$voucher_data) {
                if (!isset($voucher_data['voucher_codes']) || !is_array($voucher_data['voucher_codes'])) continue;
                $new_codes = array();
                foreach ($voucher_data['voucher_codes'] as $code) {
                    $record = custom_order_plugin_get_voucher_record($order_id, $code);
                    if ($record && in_array($record->voucher_status, array('completed', 'consumed'))) {
                        $already_processed[] = array(
                            'voucher_code' => $code,
                            'voucher_status' => $record->voucher_status,
                            'used_time' => $record->used_time,
                            'transaction_id' => $record->transaction_id,
                            'screenshot_url' => $record->screenshot_url,
                        );
                    } else {
                        $new_codes[] = $code;
                    }
                }
                $voucher_data['voucher_codes'] = $new_codes;
                $voucher_data['voucher_quantity'] = count($new_codes);
            }
        }
    }
    return array($filtered_payload, $already_processed);
}

/* -------------------------------------------------
   Resend Payload Function – used for bulk action and scheduled calls
-------------------------------------------------- */
function custom_order_plugin_resend_payload($order_id, $is_bulk = false) {
    // Limit resend attempts to a maximum of 10 per order, but only for scheduled (non-bulk) resends.
    if (!$is_bulk) {
        $resend_attempts = get_post_meta($order_id, '_resend_attempts', true);
        $resend_attempts = empty($resend_attempts) ? 0 : intval($resend_attempts);
        if ($resend_attempts >= 10) {
            $order = wc_get_order($order_id);
            $order->add_order_note('Maximum resend attempts reached for this order.');
            return;
        }
    }
    
    // Check if this order is already being processed.
    if ( get_post_meta($order_id, '_resend_processing', true) === '1' ) {
        return;
    }
    update_post_meta($order_id, '_resend_processing', '1');
    
    $stored_payload = get_post_meta($order_id, '_unipin_order_payload', true);
    if (empty($stored_payload)) {
        delete_post_meta($order_id, '_resend_processing');
        return;
    }
    
    // Retrieve server URLs.
    $server_url_1 = get_option('unipin_voucher_server_url_1', '');
    $server_url_2 = get_option('unipin_voucher_server_url_2', '');
    
    list($filtered_payload, $already_processed) = custom_order_plugin_filter_payload($order_id, $stored_payload);
    $order = wc_get_order($order_id);
    
    // Check if all vouchers have been processed.
    $all_vouchers = true;
    if (isset($filtered_payload['order_items'])) {
        foreach ($filtered_payload['order_items'] as $order_item) {
            if (isset($order_item['items'])) {
                foreach ($order_item['items'] as $item) {
                    foreach ($item['voucher_data'] as $voucher_data) {
                        if (!empty($voucher_data['voucher_codes'])) {
                            $all_vouchers = false;
                            break 3;
                        }
                    }
                }
            }
        }
    }
    
    if ($all_vouchers) {
        $note_content = "Resend Skipped: All the vouchers are already completed.\n\n";
        foreach ($already_processed as $index => $voucher) {
            $note_content .= "Voucher " . ($index + 1) . ":\n  Voucher Code: `" . $voucher['voucher_code'] . "`\n  Status: " . $voucher['voucher_status'] . "\n  Used Time: " . $voucher['used_time'] . "\n  Transaction ID: " . $voucher['transaction_id'] . "\n  Screenshot: <a href='" . $voucher['screenshot_url'] . "' target='_blank'>View Screenshot</a>\n\n";
        }
        $order->add_order_note($note_content, false);
        // Update order status as completed if all vouchers are processed.
        $order->update_status('completed', 'Order status updated to completed as all vouchers are processed.');
        delete_post_meta($order_id, '_resend_processing');
        return;
    } else {
        if (!empty($already_processed)) {
            $note_content = "Partial vouchers are already completed. These vouchers will not be resent:\n\n";
            foreach ($already_processed as $index => $voucher) {
                $note_content .= "Voucher " . ($index + 1) . ":\n  Voucher Code: `" . $voucher['voucher_code'] . "`\n  Status: " . $voucher['voucher_status'] . "\n  Used Time: " . $voucher['used_time'] . "\n  Transaction ID: " . $voucher['transaction_id'] . "\n  Screenshot: <a href='" . $voucher['screenshot_url'] . "' target='_blank'>View Screenshot</a>\n\n";
            }
            $order->add_order_note($note_content, false);
        }
        
        
        
        
        
        
        
        
        
        
        
        
        
  // Determine which server URL to use.
    if ($is_bulk) {
        // Bulk action always uses server_url_1 (if available).
        $server_url = !empty($server_url_1) ? $server_url_1 : $server_url_2;
    } else {
        // Scheduled action: Round-robin between available servers
        $available_servers = array();
        if (!empty($server_url_1)) {
            $available_servers[] = 'server1';
        }
        if (!empty($server_url_2)) {
            $available_servers[] = 'server2';
        }

        if (empty($available_servers)) {
            // Log error and exit if no servers are available
            $order->add_order_note('Error: No server URLs configured for resending payload.');
            delete_post_meta($order_id, '_resend_processing');
            return;
        }

        // Get the last used server from the option
        $last_server = get_option('custom_order_last_server', end($available_servers)); // Default to last to start with first

        // Determine the next server in round-robin
        $last_index = array_search($last_server, $available_servers);
        $next_index = ($last_index === false) ? 0 : ($last_index + 1) % count($available_servers);
        $selected_server = $available_servers[$next_index];

        // Update the last server used
        update_option('custom_order_last_server', $selected_server);

        // Set the server URL based on selection
        $server_url = ($selected_server === 'server1') ? $server_url_1 : $server_url_2;
    }
        
        
        
        
        
        
        $filtered_payload_json = json_encode($filtered_payload);
        $response = wp_remote_post($server_url, array(
            'body'       => $filtered_payload_json,
            'headers'    => array('Content-Type' => 'application/json'),
            'blocking'   => false,
        ));
        if ( is_wp_error($response) ) {
            $alternative_url = ($server_url === $server_url_1) ? $server_url_2 : $server_url_1;
            if ( !empty($alternative_url) ) {
                $response = wp_remote_post($alternative_url, array(
                    'body'       => $filtered_payload_json,
                    'headers'    => array('Content-Type' => 'application/json'),
                    'blocking'   => false,
                ));
                $server_url = $alternative_url;
            }
        }
        $order->add_order_note('Payload automatically resent to Unipin server. HTTP code: ' . wp_remote_retrieve_response_code($response) . ', POST URL: ' . $server_url);
        $response_body = wp_remote_retrieve_body($response);
        if ($response_body) {
            custom_order_plugin_handle_api_response($order_id, json_decode($response_body, true));
        }
    }
    
    // Only track resend attempts for scheduled (non-bulk) resends.
    if (!$is_bulk) {
        $resend_attempts++;
        update_post_meta($order_id, '_resend_attempts', $resend_attempts);
    }
    // Clear the processing flag.
    delete_post_meta($order_id, '_resend_processing');
}

/* -------------------------------------------------
   Bulk Resend Payload Action
-------------------------------------------------- */
function custom_order_plugin_add_resend_payload_bulk_action($bulk_actions) {
    $bulk_actions['resend_payload'] = __('Resend Payload', 'custom-order-plugin');
    return $bulk_actions;
}
add_filter('bulk_actions-edit-shop_order', 'custom_order_plugin_add_resend_payload_bulk_action');

function custom_order_plugin_handle_resend_payload_bulk_action($redirect_to, $action, $post_ids) {
    if ($action !== 'resend_payload') {
        return $redirect_to;
    }
    foreach ($post_ids as $order_id) {
        custom_order_plugin_resend_payload($order_id, true);
    }
    $redirect_to = add_query_arg('resent_payload', count($post_ids), $redirect_to);
    return $redirect_to;
}
add_filter('handle_bulk_actions-edit-shop_order', 'custom_order_plugin_handle_resend_payload_bulk_action', 10, 3);

function custom_order_plugin_display_resend_payload_notice() {
    if (!empty($_REQUEST['resent_payload'])) {
        $count = intval($_REQUEST['resent_payload']);
        printf('<div id="message" class="updated notice is-dismissible"><p>' . _n('Payload resent for %d order.', 'Payload resent for %d orders.', $count, 'custom-order-plugin') . '</p></div>', $count);
    }
}
add_action('admin_notices', 'custom_order_plugin_display_resend_payload_notice');





function custom_order_plugin_resend_payload_cron() {
    // Use a transient lock to ensure only one instance runs at a time.
    if ( get_transient('custom_order_plugin_resend_lock') ) {
        return; // Another cron run is already processing
    }
    // Set the lock for slightly longer than your cron interval (5 minutes)
    set_transient('custom_order_plugin_resend_lock', true, 6 * 60);

    // Build a WP_Query to grab the oldest 5 orders matching your criteria:
    $args = array(
        'post_type'      => 'shop_order',
        'post_status'    => array('wc-loading', 'loading', 'wc-resending', 'resending'),
        'date_query'     => array(
            array(
                'before' => '5 minutes ago',
            ),
        ),
        'meta_query'     => array(
            'relation' => 'AND',
            array(
                'key'     => '_unipin_order_payload',
                'compare' => 'EXISTS',
            ),
            array(
                'relation' => 'OR',
                array(
                    'key'     => '_resend_processing',
                    'compare' => 'NOT EXISTS',
                ),
                array(
                    'key'     => '_resend_processing',
                    'value'   => '0',
                    'compare' => '=',
                ),
            ),
        ),
        'posts_per_page' => 5,  // Only grab the oldest 5 orders
        'orderby'        => 'date',
        'order'          => 'ASC',
    );

    $query = new WP_Query($args);

    // Process each matching order.
    if ($query->have_posts()) {
        while ($query->have_posts()) {
            $query->the_post();
            $order_id = get_the_ID();
            custom_order_plugin_resend_payload($order_id, false);
        }
        wp_reset_postdata();
    }

    // Release the transient lock so next cron run can proceed.
    delete_transient('custom_order_plugin_resend_lock');
}







function custom_order_plugin_schedule_resend_payload() {
    if (!wp_next_scheduled('custom_order_plugin_resend_payload_event')) {
        wp_schedule_event(time(), 'every_5_minutes', 'custom_order_plugin_resend_payload_event');
    }
}
add_action('wp', 'custom_order_plugin_schedule_resend_payload');

function custom_order_plugin_cron_schedules($schedules) {
    $schedules['every_5_minutes'] = array(
        'interval' => 5 * 60,
        'display' => __('Every 5 Minutes'),
    );
    return $schedules;
}
add_filter('cron_schedules', 'custom_order_plugin_cron_schedules');

add_action('custom_order_plugin_resend_payload_event', 'custom_order_plugin_resend_payload_cron');

?>
