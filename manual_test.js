
require('dotenv').config();
const { paymentLink } = require('./paymentLink');
const logger = require('./logger');

const payload = {
    "domain": "https://gameheaven.net",
    "order_id": "301683",
    "order_items": [
        {
            "player_id": "3143726039",
            "items": [
                {
                    "product_id": 45,
                    "variation_id": 48,
                    "variation_name": "Monthly Membership",
                    "amount": "744BDT",
                    "quantity": 1,
                    "voucher_data": [
                        {
                            "voucher_value": "Monthly Membership",
                            "voucher_quantity": 1,
                            "voucher_codes": [
                                "UPBD-P-S-02964730 5553-6463-3476-3192"
                            ]
                        }
                    ]
                }
            ],
            "parent_product_id": 45,
            "topup_url": "https://shop.garena.my/app/100067/idlogin"
        }
    ],
    "status": "waiting",
    "trxid": "DCA4VW2WES"
};

async function runManualTest() {
    const orderId = payload.order_id;
    const playerId = payload.order_items[0].player_id;
    const proxy = "http://dba7e1b16f2dfe550878__cr.gb,us:74edbc782deb1b78@gw.dataimpulse.com:10000";

    console.log(`Starting manual test for Order: ${orderId}, Player: ${playerId}`);

    try {
        await logger.initializeOrderLog(orderId, {
            player_id: playerId,
            test: true
        });

        console.log("--- Calling paymentLink with new DataDome bypass logic ---");
        const result = await paymentLink(playerId, proxy, orderId);

        console.log("Result:", JSON.stringify(result, null, 2));

        if (result && result.url) {
            console.log("\nSUCCESS: Generated payment link URL!");
            console.log(result.url);
        } else {
            console.log("\nFAILED: No link generated.");
        }
    } catch (error) {
        console.error("Test failed with error:", error.message);
    }
}

runManualTest().then(() => process.exit(0));
