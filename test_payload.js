const axios = require('axios');

const payload = {
    "domain": "https://gameheaven.net",
    "order_id": "301076_TEST_10",
    "order_items": [
        {
            "player_id": "1957318275",
            "items": [
                {
                    "product_id": 45,
                    "variation_id": 55,
                    "variation_name": "1240 Diamonds",
                    "amount": "755BDT",
                    "quantity": 1,
                    "voucher_data": [
                        {
                            "voucher_value": "1240 Diamond",
                            "voucher_quantity": 1,
                            "voucher_codes": [
                                "UPBD-I-S-00679515 2545-5673-2746-5950"
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
    "trxid": "7519TWED"
};

async function testPush() {
    try {
        console.log("Pushing UPBD Order payload to http://localhost:4000/order...");
        const res = await axios.post('http://localhost:4000/order', payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        console.log("Server Response: ", res.data);
    } catch (error) {
        console.error("Error from server:", error.response ? error.response.data : error.message);
    }
}

testPush();
