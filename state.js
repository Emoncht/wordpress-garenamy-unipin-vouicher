// state.js
// Holds all global cross-module state

const orderRegistry = new Map();
// Key: orderId (string)
// Value: {
//   callbackUrl: string,
//   createdAt: Date,
//   vouchers: [{
//     id: string (uuid),
//     order_id: string,
//     uid: string,           // player ID
//     voucher_code: string,
//     voucher_denomination: string,
//     status: 'Pending' | 'Submitting' | 'completed' | 'consumed' | 'Failed',
//     reason: string | null,
//     retry_count: number,
//     screenshot_base64: string | null,
//     screenshot_url: string | null,
//     transaction_id: string | null,
//     validated_uid: string | null,
//     processing_started_at: Date | null,
//     completed_at: Date | null,
//     failed_at: Date | null,
//   }]
// }

let nextTopupAllowedAt = new Date(0);
let rateLimitActive = false;

module.exports = {
    orderRegistry,
    getNextTopupAllowedAt: () => nextTopupAllowedAt,
    setNextTopupAllowedAt: (date) => { nextTopupAllowedAt = date; },
    getRateLimitActive: () => rateLimitActive,
    setRateLimitActive: (isActive) => { rateLimitActive = isActive; }
};
