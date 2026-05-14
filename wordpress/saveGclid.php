<?php
/**
 * saveGclid.php
 *
 * Paste into WPCode as a PHP snippet (type: PHP, insert: Run Everywhere).
 *
 * What this does:
 *  1. Registers a WordPress REST endpoint at /wp-json/gclid/v1/save that
 *     proxies { gclid, currency, conversion_action_id, customer_id } to the
 *     mapping API using a server-side API key — the key is never exposed in
 *     page source. The server stores the per-site config so webhooks can look
 *     it up later without needing it passed at payment time.
 *  2. Passes the returned ref_id to Authorize.net as the invoice number.
 *
 * Before activating, replace every UPPER_CASE placeholder in this file.
 */

// ── Site config (hardcoded per installation) ──────────────────────────────
// Find these values in Google Ads for this specific client site.
// currency:             billing currency code, e.g. 'USD', 'CAD', 'EUR'
// conversion_action_id: Goals → Conversions → click the action → numeric ID in URL
// customer_id:          10-digit Google Ads account ID shown top-right (no dashes)
$GCLID_SITE_CONFIG = [
    'currency'             => 'YOUR_CURRENCY',
    'conversion_action_id' => 'YOUR_CONVERSION_ACTION_ID',
    'customer_id'          => 'YOUR_CUSTOMER_ID',
];

// ── 1. REST proxy endpoint ────────────────────────────────────────────────

/*
 * Registers POST /wp-json/gclid/v1/save.
 *
 * add_action('rest_api_init', ...) is WordPress's pub/sub: the callback fires
 * when WordPress boots its REST layer, which is when routes must be registered.
 * 'wp-json' is WordPress's fixed REST root; 'gclid/v1/save' is our path.
 * permission_callback => '__return_true' means no auth — the gclid value itself
 * is not sensitive, and the API key never leaves the server.
 *
 * The 'use ($GCLID_SITE_CONFIG)' clause explicitly imports the outer variable
 * into the closure. Unlike JS, PHP closures do not capture outer scope
 * automatically — omitting 'use' would make the variable undefined inside.
 *
 * On each request the callback:
 *   1. Reads and sanitizes 'gclid' from the POST body.
 *   2. Makes a server-side POST to the mapping API (key stays in PHP, never
 *      visible in browser source), merging the gclid with the hardcoded site
 *      config so the server can upsert the domains row and create a
 *      refid_gclid_mapping row in one call.
 *   3. wp_remote_post is WordPress's HTTP client (wraps cURL).
 *      is_wp_error() catches transport-level failures (DNS, timeout) only —
 *      not HTTP error status codes.
 *   4. Returns the upstream response body and status directly to the caller,
 *      so the browser JS receives { ref_id: <number> } and can write it into
 *      the hidden WPForms field before the user submits the form.
 */
add_action( 'rest_api_init', function () use ( $GCLID_SITE_CONFIG ) {
    register_rest_route( 'gclid/v1', '/save', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $request ) use ( $GCLID_SITE_CONFIG ) {
            $gclid = sanitize_text_field( $request->get_param( 'gclid' ) );

            if ( ! $gclid ) {
                return new WP_Error( 'missing_gclid', 'Missing gclid', [ 'status' => 400 ] );
            }

            $api_key = 'YOUR_MAPPING_API_KEY';
            $api_url = 'YOUR_MAPPING_API_URL';

            $response = wp_remote_post( $api_url, [
                'headers' => [
                    'Content-Type'  => 'application/json',
                    'Authorization' => 'Bearer ' . $api_key,
                ],
                'body'    => wp_json_encode( array_merge(
                    [ 'gclid' => $gclid ],
                    $GCLID_SITE_CONFIG
                ) ),
                'timeout' => 10,
            ] );

            if ( is_wp_error( $response ) ) {
                return new WP_Error( 'upstream_error', $response->get_error_message(), [ 'status' => 502 ] );
            }

            $code = wp_remote_retrieve_response_code( $response );
            $body = wp_remote_retrieve_body( $response );

            return new WP_REST_Response( json_decode( $body ), $code );
        },
    ] );
} );

// ── 2. WPForms → Authorize.net: pass ref_id as invoice number ────────────

/*
 * Intercepts the Authorize.net transaction args just before WPForms sends the
 * payment request, and injects the ref_id (populated into the hidden field by
 * captureGclid.js) as the Authorize.net invoiceNumber.
 *
 * add_filter is like add_action but for data transformation: the callback
 * receives $args, modifies it, and returns it. WordPress pipes $args through
 * all registered filters on this hook before using the final value.
 *
 * 'wpforms_authorize_net_process_payment_single_args' is a hook fired by the
 * WPForms Authorize.net add-on. It passes the transaction parameter array
 * ($args) and the submitted form field values ($fields).
 *
 * Priority 20 (third argument) means this filter runs after others on the same
 * hook (default is 10), so nothing registered later will overwrite invoiceNumber.
 * The '3' (fourth argument) tells WordPress to pass all three parameters
 * ($args, $fields, $form_data) to the callback — by default only one is passed.
 *
 * The callback reads the hidden Ref ID field by its numeric WPForms field ID,
 * then sets $args['invoiceNumber'] to that value. Authorize.net stores this on
 * the transaction; the webhook handler later reads it back as merchantReferenceId
 * to look up the original gclid and upload the offline conversion to Google Ads.
 */
add_filter( 'wpforms_authorize_net_process_payment_single_args', function ( $args, $fields, $form_data ) {

    // Replace with the numeric ID of the hidden Ref ID field from Step 1.
    $ref_id_field_id = YOUR_REF_ID_FIELD_ID;

    $ref_id = isset( $fields[ $ref_id_field_id ]['value'] )
        ? sanitize_text_field( $fields[ $ref_id_field_id ]['value'] )
        : '';

    if ( $ref_id ) {
        $args['invoiceNumber'] = $ref_id;
    }

    return $args;

}, 20, 3 );
