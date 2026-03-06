const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function runFullTest() {
    console.log("--- Starting Full End-to-End Test ---");
    
    // Adding a delay to allow the server to start up.
    console.log("Waiting 5 seconds for the server to initialize...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Using the user-provided test webhook URL
    const testWebhookUrl = "https://webhook.site/cc82f997-aa18-449c-a658-b2b92c406eb6";

    const orderPayload = {
        "order_id": `test-${Date.now()}`,
        "domain": testWebhookUrl,
        "order_items": [
            {
                "player_id": "2757423310", // Using a player ID from previous successful logs
                "items": [
                    {
                        "voucher_data": [
                            {
                                "voucher_value": "50", // Testing with a valid denomination
                                "voucher_codes": [
                                    "UPBD-R-S-00770031 8192-5342-2171-1311" // Correct format
                                ]
                            }
                        ]
                    }
                ]
            }
        ]
    };

    try {
        console.log("\n[Step 1] Sending order to the server...");
        console.log("Payload:", JSON.stringify(orderPayload, null, 2));

        const response = await fetch('http://localhost:4000/order', {
            method: 'POST',
            body: JSON.stringify(orderPayload),
            headers: { 'Content-Type': 'application/json' }
        });

        const responseData = await response.json();
        console.log("\n[Step 2] Received initial response from server:");
        console.log("Status:", response.status);
        console.log("Body:", JSON.stringify(responseData, null, 2));

        if (!response.ok) {
            throw new Error(`Server returned an error: ${responseData.message}`);
        }

        console.log("\n[Step 3] Order processing is now running in the background on the server.");
        console.log("Please monitor the server logs for the detailed automation process.");
        console.log(`A final result will be posted to: ${testWebhookUrl}`);
        console.log("\n--- Test Initiated Successfully ---");

    } catch (error) {
        console.error("\n--- TEST FAILED ---");
        console.error("An error occurred while initiating the test request.");
        console.error("Please ensure the main server is running with 'npm start' in a separate terminal.");
        console.error("Error details:", error.message);
    }
}

runFullTest(); 