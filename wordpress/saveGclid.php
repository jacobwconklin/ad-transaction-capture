<?php
/**
 * saveGclid.php
 *
 * Paste into WPCode as a PHP snippet (type: PHP, insert: Run Everywhere).
 *
 * What this does:
 *  1. Registers a WordPress REST endpoint at /wp-json/gclid/v1/save that
 *     proxies { gclid } to the mapping API using a server-side API key —
 *     the key is never exposed in page source.
 *  2. Passes the returned ref_id to Authorize.net as the invoice number.
 *
 * Before activating, replace every UPPER_CASE placeholder in this file.
 */

// ── 1. REST proxy endpoint ────────────────────────────────────────────────

add_action( 'rest_api_init', function () {
    register_rest_route( 'gclid/v1', '/save', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $request ) {
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
                'body'    => wp_json_encode( [ 'gclid' => $gclid ] ),
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

}, 10, 3 );
