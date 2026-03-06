const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');
const { glob } = require('glob');
const { Semaphore } = require('async-mutex');

// Load environment variables
dotenv.config({ path: '../.env' });

// Configuration
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8015;

// Constants
const MAX_CONCURRENT_INSTANCES = 3;
const ORDERS_DIR = 'ORDERS_JS';
const OUTPUT_IMAGES_DIR = 'outputImages_JS';
const API_KEY = 'YOUR_SECRET_API_KEY';

// Default credentials if .env not found
const USERNAME = process.env.USERNAME || 'demo_user';
const PASSWORD = process.env.PASSWORD || 'demo_password';

// Global variables
const logBuffer = [];
const runningBrowsers = new Map(); // Use Map to track by browser process PID
const orderLogDetails = new Map();
let semaphoreCount = 0;
let rateLimitActive = false;

// Create directories if they don't exist
(async () => {
    try {
        await fs.mkdir(ORDERS_DIR, { recursive: true });
        await fs.mkdir(OUTPUT_IMAGES_DIR, { recursive: true });
    } catch (error) {
        console.error('Error creating directories:', error);
    }
})();

// Logging function
function log(message) {
    console.log(message);
    logBuffer.push(message);
    // Keep only last 10000 logs
    if (logBuffer.length > 10000) {
        logBuffer.shift();
    }
}

// Order file helpers
function getOrderFilePath(orderId) {
    return path.join(ORDERS_DIR, `${orderId}.json`);
}

async function loadOrderData(orderId) {
    const filePath = getOrderFilePath(orderId);
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            log(`[Order ${orderId}] Error reading order file: ${error.message}`);
        }
        return { vouchers: [] };
    }
}

async function updateOrderData(orderId, voucherInfo) {
    const data = await loadOrderData(orderId);
    const existing = data.vouchers.find(v => 
        v.voucher_code === voucherInfo.voucher_code && 
        ['completed', 'consumed'].includes(v.voucher_status)
    );
    
    if (existing) return;
    
    data.vouchers.push(voucherInfo);
    
    try {
        await fs.writeFile(getOrderFilePath(orderId), JSON.stringify(data, null, 4));
    } catch (error) {
        log(`[Order ${orderId}] Error writing order file: ${error.message}`);
    }
    
    await manageOrderFiles();
}

async function manageOrderFiles() {
    try {
        const files = await glob(path.join(ORDERS_DIR, "*.json"));
        if (files.length > 1000) {
            const sortedFiles = files.map(file => ({ file, mtime: fs.statSync(file).mtime }))
                .sort((a, b) => a.mtime - b.mtime);
            const files_to_delete = sortedFiles.slice(0, files.length - 1000);
            for (const fileObj of files_to_delete) {
                try {
                    await fs.unlink(fileObj.file);
                    log(`Deleted old order file: ${fileObj.file}`);
                } catch (e) {
                    log(`Error deleting file ${fileObj.file}: ${e}`);
                }
            }
        }
    } catch (error) {
        log(`Error managing order files: ${error}`);
    }
}

// Server order check helper
async function checkOrderOnServer(orderId, domain) {
    const endpoint = `${domain}/wp-json/custom-order-plugin/v1/check`;
    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
    };
    const payload = { order_id: orderId };
    
    try {
        const response = await axios.post(endpoint, payload, { headers });
        return response.data;
    } catch (error) {
        log(`[Order ${orderId}] Server check failed: ${error.message}`);
        return {};
    }
}

// Async post helper
async function postResultAsync(endpoint, result, order_id = "Unknown") {
    try {
        const response = await axios.post(endpoint, { result: result });
        log(`[Order ${order_id}] Final Response Code: ${response.status}`);
        log(`[Order ${order_id}] Final Response Content: ${JSON.stringify(response.data)}`);
    } catch (e) {
        log(`[Order ${order_id}] Error posting result: ${e}`);
    }
}

// Semaphore implementation
const semaphore = new Semaphore(MAX_CONCURRENT_INSTANCES);

// Monitor browsers task
async function monitor_browsers() {
    while (true) {
        const now = new Date();
        for (const [browserPid, info] of runningBrowsers.entries()) {
            const start_time = info.startTime;
            if ((now - start_time) > 15 * 60 * 1000) { // 15 minutes in milliseconds
                log(`[Order ${info.orderId}] Browser opened at ${start_time.toISOString()} timed out. Closing.`);
                try {
                    if (info.browser && info.browser.isConnected()) {
                        await info.browser.close();
                    }
                } catch (e) {
                    log(`[Order ${info.orderId}] Error closing browser: ${e}`);
                }
                runningBrowsers.delete(browserPid);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 60000)); // Sleep for 60 seconds
    }
}

// Start monitoring task
monitor_browsers().catch(error => {
    log(`Monitor browsers error: ${error.message}`);
});

// Retry helpers
async function retry_find(page, selector, retries = 5, delay = 1, timeout = 5000, order_id = "", element_name = null) {
    if (element_name === null) {
        element_name = selector;
    }
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const element = await page.waitForSelector(selector, { timeout: timeout });
            if (element) {
                return element;
            }
        } catch (e) {
            if (!["Success element", "Primary confirmation link", "Pop-over button"].includes(element_name)) {
                if (order_id) {
                    log(`[Order ${order_id}] Attempt ${attempt + 1} for element '${element_name}' failed: ${e.message.split('\n')[0]}`);
                } else {
                    log(`Attempt ${attempt + 1} for element '${element_name}' failed: ${e.message.split('\n')[0]}`);
                }
            }
        }
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
    }
    return null;
}

async function retry_find_xpath(page, xpath, retries = 5, delay = 1, timeout = 5000, order_id = "", element_name = null) {
    if (element_name === null) {
        element_name = xpath;
    }
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const element = await page.waitForSelector(`xpath/${xpath}`, { timeout: timeout });
            if (element) {
                return element;
            }
        } catch (e) {
            if (!["Success element", "Primary confirmation link", "Pop-over button"].includes(element_name)) {
                if (order_id) {
                    log(`[Order ${order_id}] Attempt ${attempt + 1} for element '${element_name}' (xpath) failed: ${e.message.split('\n')[0]}`);
                } else {
                    log(`Attempt ${attempt + 1} for element '${element_name}' (xpath) failed: ${e.message.split('\n')[0]}`);
                }
            }
        }
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
    }
    return null;
}

// Main process order function
async function processOrder(data) {
    const orderId = data.order_id || 'Unknown';
    log(`[Order ${orderId}] Processing Order ID: ${orderId}`);
    
    // IMMEDIATELY check if this order is already being processed
    // Check both real browser entries and temporary entries
    const alreadyProcessing = Array.from(runningBrowsers.values()).some(info => info.orderId === orderId);
    if (alreadyProcessing) {
        log(`[Order ${orderId}] Order already being processed, skipping duplicate.`);
        return {
            order_id: orderId,
            order_status: 'duplicate',
            message: `Order ${orderId} is already being processed`
        };
    }
    
    // IMMEDIATELY register this order as being processed to prevent duplicates
    // We'll use a temporary entry that will be updated with browser info later
    const tempKey = `temp_${orderId}_${Date.now()}`;
    runningBrowsers.set(tempKey, {
        startTime: new Date(),
        orderId,
        page: null,
        browser: null,
        isTemporary: true
    });
    
    // Calculate total vouchers
    let totalVouchers = 0;
    for (const orderItem of (data.order_items || [])) {
        for (const item of (orderItem.items || [])) {
            for (const voucherData of (item.voucher_data || [])) {
                totalVouchers += (voucherData.voucher_codes || []).length;
            }
        }
    }
    
    orderLogDetails.set(orderId, {
        totalVouchers,
        completedVouchers: 0
    });
    
    const responseDict = {
        order_id: orderId,
        order_status: 'processing',
        vouchers: [],
        invalid_ids: []
    };
    
    const responseEndpoint = `${data.domain}/wp-json/custom-order-plugin/v1/orders`;
    
    // Pre-check: remove already processed vouchers
    const domain = data.domain || '';
    if (!domain) {
        log(`[Order ${orderId}] Domain not provided in payload.`);
        responseDict.order_status = 'failed';
        responseDict.details = 'Domain not provided in payload.';
        runningBrowsers.delete(tempKey); // Clean up temp entry
        await postResultAsync(responseEndpoint, responseDict, orderId);
        return responseDict;
    }
    
    const existingOrder = await checkOrderOnServer(orderId, domain);
    
    // Filter out already processed vouchers
    for (const orderItem of (data.order_items || [])) {
        for (const item of (orderItem.items || [])) {
            for (const voucherData of (item.voucher_data || [])) {
                const newCodes = [];
                for (const code of (voucherData.voucher_codes || [])) {
                    const processed = existingOrder.vouchers && existingOrder.vouchers.find(v => 
                        v.voucher_code === code && ['completed', 'consumed'].includes(v.voucher_status)
                    );
                    
                    if (processed) {
                        log(`[Order ${orderId}] Voucher ${code} already processed. Skipping.`);
                        responseDict.vouchers.push(processed);
                    } else {
                        newCodes.push(code);
                    }
                }
                voucherData.voucher_codes = newCodes;
                voucherData.voucher_quantity = newCodes.length;
            }
        }
    }
    
    // Check if any vouchers left to process
    const vouchersLeft = data.order_items.some(orderItem =>
        orderItem.items.some(item =>
            item.voucher_data.some(voucherData => 
                voucherData.voucher_quantity > 0
            )
        )
    );
    
    if (!vouchersLeft) {
        log(`[Order ${orderId}] All vouchers already processed. Skipping browser launch.`);
        runningBrowsers.delete(tempKey); // Clean up temp entry
        await postResultAsync(responseEndpoint, responseDict, orderId);
        return responseDict;
    }
    
    let browser = null;
    let newBrowserPid = null; // Declare at function scope
    
    try {
        await semaphore.acquire();
        
        if (rateLimitActive) {
            await new Promise(resolve => {
                const checkInterval = setInterval(() => {
                    if (!rateLimitActive) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 1000);
            });
        }
        
        // Launch browser
        browser = await puppeteer.launch({
            headless: false,
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            args: [
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        });
        
        let page = await browser.newPage();
        newBrowserPid = browser.process().pid;
        
        // Remove the temporary entry
        runningBrowsers.delete(tempKey);
        
        // Add the real browser entry
        runningBrowsers.set(newBrowserPid, {
            startTime: new Date(),
            orderId,
            page,
            browser
        });
        
        // Auto-dismiss dialogs
        page.on('dialog', async dialog => {
            await dialog.dismiss();
        });
        
        // Hide webdriver flag
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        
        // Inject order ID display
        await page.evaluateOnNewDocument(orderId => {
            const injectOrderId = () => {
                if (!document.getElementById('order-id-display')) {
                    let div = document.createElement('div');
                    div.id = 'order-id-display';
                    div.style.position = 'fixed';
                    div.style.top = '0';
                    div.style.left = '0';
                    div.style.background = 'yellow';
                    div.style.color = 'black';
                    div.style.fontSize = '20px';
                    div.style.zIndex = '10000';
                    div.style.padding = '5px';
                    div.innerText = `Order ID: ${orderId}`;
                    if (document.body) {
                    document.body.appendChild(div);
                    } else {
                        const observer = new MutationObserver((mutationsList, observer) => {
                            if (document.body) {
                                document.body.appendChild(div);
                                observer.disconnect();
                            }
                        });
                        observer.observe(document.documentElement, { childList: true, subtree: true });
                    }
                }
            };
            document.addEventListener('DOMContentLoaded', injectOrderId);
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                injectOrderId();
            }
        }, orderId);
        
        await page.goto('https://shop.garena.my/?app=100067&channel=202953');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Process each order item
        for (const orderItem of (data.order_items || [])) {
            // Enter player ID
            const playerIdSelector = 'input[placeholder="Please enter player ID here"], input[name=playerId]';
            const playerIdInput = await retry_find(page, playerIdSelector, 5, 1, 5000, orderId, 'Player ID input');
            
            if (!playerIdInput) {
                log(`[Order ${orderId}] Player ID input not found.`);
                responseDict.order_status = 'failed';
                responseDict.details = 'Input field not found. Try again later';
                continue;
            }
            
            await playerIdInput.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type(playerIdSelector, String(orderItem.player_id));
            log(`[Order ${orderId}] Player ID entered: ${orderItem.player_id}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Click login button
            const loginBtnSelector = 'button[type="submit"].bg-primary-red, input[value=Login]';
            const loginBtn = await retry_find(page, loginBtnSelector, 5, 1, 5000, orderId, 'Login button');
            
            if (!loginBtn) {
                log(`[Order ${orderId}] Login button not found.`);
                responseDict.order_status = 'failed';
                responseDict.details = 'Login button not found. Try again later';
                continue;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            await loginBtn.click();
            log(`[Order ${orderId}] Login button clicked.`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // CHECK FOR CAPTCHA AFTER LOGIN
            const max_captcha_retries = 5;
            let current_captcha_attempt = 0;
            
            while (current_captcha_attempt < max_captcha_retries) {
                let captcha_detected = false;
                try {
                    // Check for captcha iframe
                    const captcha_iframe_xpath = '/html/body/div[5]/iframe';
                    const captcha_iframe = await page.waitForSelector(`xpath/${captcha_iframe_xpath}`, { timeout: 1000 });
                    if (captcha_iframe) {
                        captcha_detected = true;
                    }
                } catch (e) {
                    // Not found, which is expected
                }
                
                if (!captcha_detected) {
                    try {
                        // Alternative check for captcha container
                        const captcha_container = await page.waitForSelector('#ddv1-captcha-container', { timeout: 1000 });
                        if (captcha_container) {
                            captcha_detected = true;
                        }
                    } catch (e) {
                        // Not found, which is expected
                    }
                }
                
                if (captcha_detected) {
                    log(`[Order ${orderId}] Captcha detected on attempt ${current_captcha_attempt + 1}. Restarting browser...`);
                    // Take screenshot of captcha for debugging
                    try {
                        const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}_captcha_${current_captcha_attempt}.jpg`);
                        await page.screenshot({ path: filename });
                    } catch (e) {
                        log(`[Order ${orderId}] Failed to capture captcha screenshot: ${e.message}`);
                    }
                    
                    // Close the current browser
                    await browser.close();
                    runningBrowsers.delete(newBrowserPid);
                    
                    // Increment attempt counter
                    current_captcha_attempt += 1;
                    
                    // If we haven't reached max retries, launch a new browser
                    if (current_captcha_attempt < max_captcha_retries) {
                        log(`[Order ${orderId}] Retrying with new browser (attempt ${current_captcha_attempt + 1}/${max_captcha_retries})...`);
                        
                        // Wait a bit before launching a new browser
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        // Launch new browser
                        browser = await puppeteer.launch({
                            headless: false,
                            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                            args: [
                                '--no-sandbox',
                                '--disable-blink-features=AutomationControlled',
                                '--disable-infobars',
                                '--disable-background-timer-throttling',
                                '--disable-backgrounding-occluded-windows',
                                '--disable-renderer-backgrounding'
                            ]
                        });
                        
                        // Create a new page and store it in running_browsers
                        page = await browser.newPage();
                        const retryBrowserPid = browser.process().pid;
                        newBrowserPid = retryBrowserPid; // Update the browserPid variable
                        runningBrowsers.set(newBrowserPid, {
                            startTime: new Date(),
                            orderId,
                            page,
                            browser
                        });
                        
                        // Auto-dismiss any unexpected dialogs
                        page.on('dialog', async dialog => {
                            await dialog.dismiss();
                        });
                        
                        // Hide navigator.webdriver flag
                        await page.evaluateOnNewDocument(() => {
                            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                        });
                        
                        // Inject script to display order ID
                        await page.evaluateOnNewDocument(orderId => {
                            const injectOrderId = () => {
                                if (!document.getElementById('order-id-display')) {
                                    let div = document.createElement('div');
                                    div.id = 'order-id-display';
                                    div.style.position = 'fixed';
                                    div.style.top = '0';
                                    div.style.left = '0';
                                    div.style.background = 'yellow';
                                    div.style.color = 'black';
                                    div.style.fontSize = '20px';
                                    div.style.zIndex = '10000';
                                    div.style.padding = '5px';
                                    div.innerText = `Order ID: ${orderId}`;
                                    if (document.body) {
                                        document.body.appendChild(div);
                                    } else {
                                        const observer = new MutationObserver((mutationsList, observer) => {
                                            if (document.body) {
                                                document.body.appendChild(div);
                                                observer.disconnect();
                                            }
                                        });
                                        observer.observe(document.documentElement, { childList: true, subtree: true });
                                    }
                                }
                            };
                            document.addEventListener('DOMContentLoaded', injectOrderId);
                            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                                injectOrderId();
                            }
                        }, orderId);
                        
                        // Navigate to the site again
                        await page.goto('https://shop.garena.my/?app=100067&channel=202953');
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        
                        // Enter player ID
                        const playerIdInput2 = await retry_find(page, playerIdSelector, 5, 1, 3000, orderId, "Player ID input");
                        if (!playerIdInput2) {
                            log(`[Order ${orderId}] Player ID input not found on retry ${current_captcha_attempt}.`);
                            continue;
                        }
                        
                        await playerIdInput2.click({ clickCount: 3 });
                        await page.keyboard.press('Backspace');
                        await page.type(playerIdSelector, String(orderItem.player_id));
                        log(`[Order ${orderId}] Player ID entered on retry ${current_captcha_attempt}: ${orderItem.player_id}`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // Click login button
                        const loginBtn2 = await retry_find(page, loginBtnSelector, 5, 1, 3000, orderId, "Login button");
                        if (!loginBtn2) {
                            log(`[Order ${orderId}] Login button not found on retry ${current_captcha_attempt}.`);
                            continue;
                        }
                        
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        await loginBtn2.click();
                        log(`[Order ${orderId}] Login button clicked on retry ${current_captcha_attempt}.`);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        
                        // Continue to next iteration to check for captcha again
                        continue;
                    } else {
                        // If we've reached max retries, prepare failure response
                        log(`[Order ${orderId}] Max captcha retries reached (${max_captcha_retries}). Giving up.`);
                        
                        // Capture screenshot for the captcha failure response
                        let screenshot_base64 = "";
                        try {
                            const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}_captcha_max_retries.jpg`);
                            await page.screenshot({ path: filename });
                            const image_data = await fs.readFile(filename);
                            screenshot_base64 = image_data.toString('base64');
                        } catch (e) {
                            log(`[Order ${orderId}] Failed to capture final captcha screenshot: ${e.message}`);
                        }
                        
                        // Get first voucher code
                        let voucher_code_actual = "";
                        for (const oi of data.order_items || []) {
                            for (const it of oi.items || []) {
                                for (const vd of it.voucher_data || []) {
                                    const codes = vd.voucher_codes || [];
                                    if (codes.length > 0) {
                                        voucher_code_actual = codes[0];
                                        break;
                                    }
                                }
                                if (voucher_code_actual) break;
                            }
                            if (voucher_code_actual) break;
                        }
                        
                        const response = {
                            order_id: orderId,
                            order_status: "topupfailed",
                            vouchers: [{
                                status: "topupfailed",
                                voucher_code: voucher_code_actual,
                                used_time: new Date().toLocaleString('en-US', { 
                                    year: 'numeric', 
                                    month: '2-digit', 
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                    hour12: false
                                }).replace(',', ''),
                                transaction_id: "",
                                screenshot: screenshot_base64,
                                details: "Captcha detected, max retries reached"
                            }],
                            invalid_ids: []
                        };
                        await postResultAsync(responseEndpoint, response, orderId);
                        return response;
                    }
                } else {
                    // No captcha detected, proceed to check login success
                    log(`[Order ${orderId}] No captcha detected, checking login success.`);
                    break;
                }
            }
            
            // Check for server mismatch
            const serverMismatchXpath = '/html/body/div[1]/main/div/div[2]/div[2]/div/div[3]/div[2]/div[2]/div[2]';
            let serverMismatchElem = null;
            try {
                serverMismatchElem = await page.waitForSelector(`xpath/${serverMismatchXpath}`, { timeout: 2000 });
            } catch (e) {
                // Element not found, which is expected
            }
            
            if (serverMismatchElem) {
                log(`[Order ${orderId}] Server mismatch detected.`);
                let screenshotBase64 = '';
                try {
                    const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}_server_mismatch.jpg`);
                    await page.screenshot({ path: filename });
                    const imageData = await fs.readFile(filename);
                    screenshotBase64 = imageData.toString('base64');
                } catch (error) {
                    log(`[Order ${orderId}] Failed to capture screenshot for server mismatch: ${error.message}`);
                }
                
                // Get first voucher code
                let voucherCodeActual = '';
                for (const oi of data.order_items || []) {
                    for (const it of oi.items || []) {
                        for (const vd of it.voucher_data || []) {
                            const codes = vd.voucher_codes || [];
                            if (codes.length > 0) {
                                voucherCodeActual = codes[0];
                                break;
                            }
                        }
                        if (voucherCodeActual) break;
                    }
                    if (voucherCodeActual) break;
                }
                
                const response = {
                    order_id: orderId,
                    order_status: 'server-mismatch',
                    vouchers: [{
                        status: 'server-mismatch',
                        voucher_code: voucherCodeActual,
                        used_time: new Date().toLocaleString('en-US', { 
                            year: 'numeric', 
                            month: '2-digit', 
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: false
                        }).replace(',', ''),
                        transaction_id: '',
                        screenshot: screenshotBase64
                    }],
                    invalid_ids: []
                };
                
                await browser.close();
                runningBrowsers.delete(newBrowserPid);
                await postResultAsync(responseEndpoint, response, orderId);
                return response;
            }
            
            // Check for invalid ID
            const invalidIdXpath = '/html/body/div[1]/main/div/div[2]/div[2]/div/div[3]/div[2]/div[2]/div/form/div[2]';
            let invalidIdElement = null;
            try {
                invalidIdElement = await page.waitForSelector(`xpath/${invalidIdXpath}`, { timeout: 2000 });
            } catch (e) {
                // Element not found, which is expected
            }
            
            if (invalidIdElement) {
                log(`[Order ${orderId}] Invalid Player ID detected.`);
                let screenshotBase64 = '';
                try {
                    const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}_invalid_id.jpg`);
                    await page.screenshot({ path: filename });
                    const imageData = await fs.readFile(filename);
                    screenshotBase64 = imageData.toString('base64');
                } catch (error) {
                    log(`[Order ${orderId}] Failed to capture screenshot for invalid ID: ${error.message}`);
                }
                
                responseDict.order_status = 'failed';
                responseDict.invalid_ids.push(String(orderItem.player_id));
                responseDict.vouchers = [];
                
                await browser.close();
                runningBrowsers.delete(newBrowserPid);
                await postResultAsync(responseEndpoint, responseDict, orderId);
                return responseDict;
            }
            
            // Verify player ID after login
            let player_id_verified = false;
            const player_id_verification_xpath = '/html/body/div[1]/main/div/div[2]/div[2]/div/div[3]/div[2]/div[2]/div/div[2]/div[2]';
            try {
                const player_id_elem = await retry_find_xpath(
                    page, player_id_verification_xpath,
                    3, 1, 3000,
                    orderId, "Player ID verification element"
                );
                
                if (player_id_elem) {
                    const displayed_player_id_text = await page.evaluate(element => element.textContent, player_id_elem);
                    log(`[Order ${orderId}] [Browser ${newBrowserPid}] DEBUG - Displayed player ID text: '${displayed_player_id_text}'`);
                    
                    // Extract player ID from text like "Player ID: 7226087179"
                    if (displayed_player_id_text.includes("Player ID:")) {
                        const displayed_player_id = displayed_player_id_text.split("Player ID:")[1].trim();
                        log(`[Order ${orderId}] [Browser ${newBrowserPid}] DEBUG - Extracted player ID: '${displayed_player_id}' | Target: '${orderItem.player_id}'`);
                        
                        if (displayed_player_id === String(orderItem.player_id)) {
                            log(`[Order ${orderId}] [Browser ${newBrowserPid}] ✅ Player ID verification successful: ${displayed_player_id}`);
                            player_id_verified = true;
                        } else {
                            log(`[Order ${orderId}] [Browser ${newBrowserPid}] ❌ Player ID mismatch! Expected: ${orderItem.player_id}, Got: ${displayed_player_id}`);
                        }
                    } else {
                        log(`[Order ${orderId}] [Browser ${newBrowserPid}] Could not extract player ID from text: '${displayed_player_id_text}'`);
                    }
                } else {
                    log(`[Order ${orderId}] [Browser ${newBrowserPid}] Player ID verification element not found`);
                }
            } catch (error) {
                log(`[Order ${orderId}] [Browser ${newBrowserPid}] Player ID verification failed: ${error.message}`);
            }
            
            // If player ID was verified, consider it a successful login
            if (player_id_verified) {
                log(`[Order ${orderId}] Logged in successfully with verified player ID.`);
            } else {
                // Player ID verification failed, closing browser and returning topupfailed
                log(`[Order ${orderId}] Login verification failed, closing browser and returning topupfailed.`);
                
                let screenshotBase64 = '';
                try {
                    const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}_login_verification_failure.jpg`);
                    await page.screenshot({ path: filename });
                    const imageData = await fs.readFile(filename);
                    screenshotBase64 = imageData.toString('base64');
                } catch (error) {
                    log(`[Order ${orderId}] Failed to capture screenshot: ${error.message}`);
                }
                
                await browser.close();
                runningBrowsers.delete(newBrowserPid);
                
                // Retrieve the first voucher code available from the order payload
                let voucherCodeActual = '';
                for (const oi of data.order_items || []) {
                    for (const it of oi.items || []) {
                        for (const vd of it.voucher_data || []) {
                            const codes = vd.voucher_codes || [];
                            if (codes.length > 0) {
                                voucherCodeActual = codes[0];
                                break;
                            }
                        }
                        if (voucherCodeActual) break;
                    }
                    if (voucherCodeActual) break;
                }
                
                const response = {
                    order_id: orderId,
                    order_status: 'topupfailed',
                    vouchers: [{
                        status: 'topupfailed',
                        voucher_code: voucherCodeActual,
                        used_time: new Date().toLocaleString('en-US', { 
                            year: 'numeric', 
                            month: '2-digit', 
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: false
                        }).replace(',', ''),
                        transaction_id: '',
                        screenshot: screenshotBase64,
                        details: "Login verification failed"
                    }],
                    invalid_ids: []
                };
                
                await postResultAsync(responseEndpoint, response, orderId);
                return response;
            }
            
            // Process vouchers
            for (const item of (orderItem.items || [])) {
                for (const voucherData of (item.voucher_data || [])) {
                    for (const voucher of (voucherData.voucher_codes || [])) {
                        try {
                            // Load topup URL for each voucher
                            await page.goto('https://shop.garena.my/?app=100067&channel=202953');
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            
                            // // Try optional button -- LOGIC TO BE REMOVED
                            // const optionalButtonXpath = '/html/body/div[1]/main/div/div[2]/div[2]/div/div[3]/div[3]/div[2]/button[2]';
                            // const optionalButton = await retry_find_xpath(
                            //     page, optionalButtonXpath, 3, 1, 2000, orderId, 'Optional Pre-Proceed button'
                            // );
                            // 
                            // if (optionalButton) {
                            //     await optionalButton.click();
                            //     log(`[Order ${orderId}] Optional pre-proceed button clicked.`);
                            //     await new Promise(resolve => setTimeout(resolve, 1000));
                            // }
                            
                            // Find Proceed to Payment button
                            const proceedXpathText = "//button[contains(text(), 'Proceed to Payment')]";
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            
                            const proceedBtn = await retry_find_xpath(
                                page, proceedXpathText, 5, 1, 2000, orderId, 'Proceed to Payment button (by text)'
                            );
                            
                            if (!proceedBtn) {
                                log(`[Order ${orderId}] Proceed to Payment button not found.`);
                                const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}.jpg`);
                                await page.screenshot({ path: filename });
                                const imageData = await fs.readFile(filename);
                                const imageBase64 = imageData.toString('base64');
                                
                                responseDict.vouchers.push({
                                    status: 'topupfailed',
                                    voucher_code: voucher,
                                    used_time: new Date().toLocaleString('en-US', { 
                                        year: 'numeric', 
                                        month: '2-digit', 
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                        hour12: false
                                    }).replace(',', ''),
                                    transaction_id: '',
                                    screenshot: imageBase64
                                });
                                
                                await page.goto('https://shop.garena.my/?app=100067&channel=202953');
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                continue;
                            }
                            
                            await proceedBtn.click();
                            log(`[Order ${orderId}] Proceed to Payment clicked for voucher ${voucher}.`);
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            
                            // Handle service unavailable retries
                            let serviceRetryCount = 0;
                            while (serviceRetryCount < 7) {
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                try {
                                    const serviceUnavailable = await page.$("text='Sorry, service is not available now'");
                                    if (serviceUnavailable) {
                                        serviceRetryCount++;
                                        log(`[Order ${orderId}] Service unavailable retry ${serviceRetryCount}/7`);
                                        const proceedBtnAgain = await retry_find_xpath(
                                            page, proceedXpathText, 1, 1, 2000, orderId, 'Proceed to Payment button'
                                        );
                                        if (proceedBtnAgain) {
                                            await proceedBtnAgain.click();
                                        } else {
                                            break;
                                        }
                                    } else {
                                        break;
                                    }
                                } catch (e) {
                                    break;
                                }
                            }
                            
                            if (serviceRetryCount >= 7) {
                                const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}_server_error.jpg`);
                                await page.screenshot({ path: filename });
                                const imageData = await fs.readFile(filename);
                                const imageBase64 = imageData.toString('base64');
                                
                                responseDict.vouchers.push({
                                    status: 'server_error',
                                    voucher_code: voucher,
                                    used_time: new Date().toLocaleString('en-US', { 
                                        year: 'numeric', 
                                        month: '2-digit', 
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                        hour12: false
                                    }).replace(',', ''),
                                    transaction_id: '',
                                    screenshot: imageBase64
                                });
                                
                                await page.goto('https://shop.garena.my/?app=100067&channel=202953');
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                continue;
                            }
                            
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            await page.waitForFunction("document.readyState === 'complete'", { timeout: 30000 });
                            
                            // Wait a bit more for dynamic content to load
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            
                            // Select denomination by clicking on the button with matching text
                            const voucherValue = (voucherData.voucher_value || '').toLowerCase();
                            
                            // Map voucher values to the exact button text as shown in the UI
                            const denominationTextMap = {
                                '25': '25 Diamond',
                                '50': '50 Diamond', 
                                '115': '115 Diamond',
                                '240': '240 Diamond',
                                '610': '610 Diamond',
                                '1240': '1240 Diamond',
                                '2530': '2530 Diamond',
                                'weekly': 'Weekly Membership',
                                'monthly': 'Monthly Membership',
                                'level up pass': 'Level Up Pass'
                            };
                            
                            let denominationFound = false;
                            
                            // First, try to extract just the number from voucher value
                            const numberMatch = voucherValue.match(/(\d+)/);
                            const extractedNumber = numberMatch ? numberMatch[1] : null;
                            
                            // Important: First try exact match with the largest denominations first
                            // This prevents 1240 from matching 240
                            const sortedDenoms = Object.entries(denominationTextMap)
                                .filter(([key]) => !isNaN(parseInt(key)))
                                .sort((a, b) => parseInt(b[0]) - parseInt(a[0])); // Sort numerically in descending order
                            
                            // Add non-numeric keys at the end
                            Object.entries(denominationTextMap)
                                .filter(([key]) => isNaN(parseInt(key)))
                                .forEach(entry => sortedDenoms.push(entry));
                            
                            for (const [key, buttonText] of sortedDenoms) {
                                // 1. Check if extractedNumber exactly matches the key (best match)
                                // 2. For non-numeric keys (like 'weekly'), check if voucher value contains them
                                const isExactNumberMatch = extractedNumber && extractedNumber === key;
                                const isNonNumericKeyIncluded = isNaN(parseInt(key)) && voucherValue.includes(key);
                                
                                if (isExactNumberMatch || isNonNumericKeyIncluded) {
                                    try {
                                        // Try to find and click the button by its text content
                                        const denomBtn = await page.evaluate((text) => {
                                            const selectors = [
                                                'button',
                                                'div[role="button"]',
                                                'div[class*="diamond"]',
                                                'div[class*="Diamond"]',
                                                'div[class*="membership"]',
                                                'div[class*="item"]',
                                                'div[class*="denomination"]',
                                                'div[class*="price"]',
                                                'div[class*="package"]',
                                                'div[class*="option"]',
                                                'div[class*="select"]',
                                                'div[class*="choice"]',
                                                'li[class*="diamond"]',
                                                'li[class*="item"]',
                                                'span[class*="diamond"]',
                                                'a[class*="diamond"]',
                                                '[onclick]',
                                                '[data-value]',
                                                '[data-amount]'
                                            ];
                                            const buttons = Array.from(document.querySelectorAll(selectors.join(', ')));
                                            
                                            // Also check for any element that contains the target text
                                            const allElements = Array.from(document.querySelectorAll('*'));
                                            allElements.forEach(el => {
                                                const elText = (el.innerText || el.textContent || '').trim();
                                                if (elText === text || elText.toLowerCase() === text.toLowerCase()) {
                                                    if (!buttons.includes(el)) {
                                                        buttons.push(el);
                                                    }
                                                }
                                            });
                                            
                                            const button = buttons.find(btn => {
                                                const btnText = (btn.innerText || btn.textContent || '').trim();
                                                return btnText && btnText.toLowerCase() === text.toLowerCase();
                                            });
                                            if (button) {
                                                button.click();
                                                return true;
                                            }
                                            return false;
                                        }, buttonText);
                                        
                                        if (denomBtn) {
                                            denominationFound = true;
                                            log(`[Order ${orderId}] Selected denomination: ${buttonText}`);
                                            break;
                                        }
                                    } catch (e) {
                                        log(`[Order ${orderId}] Error selecting denomination ${buttonText}: ${e.message}`);
                                    }
                                }
                            }
                            
                            // If not found by exact match, try a more flexible approach
                            if (!denominationFound && extractedNumber) {
                                try {
                                    const flexibleMatch = await page.evaluate((targetNumber) => {
                                        const selectors = [
                                            'button',
                                            'div[role="button"]',
                                            'div[class*="diamond"]',
                                            'div[class*="Diamond"]',
                                            'div[class*="membership"]',
                                            'div[class*="item"]',
                                            'div[class*="denomination"]',
                                            'div[class*="price"]',
                                            'div[class*="package"]',
                                            'div[class*="option"]',
                                            'div[class*="select"]',
                                            'div[class*="choice"]',
                                            'li[class*="diamond"]',
                                            'li[class*="item"]',
                                            'span[class*="diamond"]',
                                            'a[class*="diamond"]',
                                            '[onclick]',
                                            '[data-value]',
                                            '[data-amount]'
                                        ];
                                        const buttons = Array.from(document.querySelectorAll(selectors.join(', ')));
                                        
                                        // Also check all elements that might contain diamond numbers
                                        const allElements = Array.from(document.querySelectorAll('*'));
                                        allElements.forEach(el => {
                                            const elText = (el.innerText || el.textContent || '').trim();
                                            if (elText && elText.includes(targetNumber)) {
                                                if (!buttons.includes(el)) {
                                                    buttons.push(el);
                                                }
                                            }
                                        });
                                        
                                        // Try to find exact match first
                                        for (const btn of buttons) {
                                            const btnText = (btn.innerText || btn.textContent || '').trim();
                                            // Check if the button text contains the target number EXACTLY (not as substring)
                                            if (btnText === targetNumber || btnText === `${targetNumber} Diamond` || 
                                                btnText === `${targetNumber} Diamonds` || btnText.toLowerCase() === `${targetNumber} diamond` ||
                                                btnText.toLowerCase() === `${targetNumber} diamonds`) {
                                                if (btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0) {
                                                    btn.click();
                                                    return btnText;
                                                }
                                            }
                                        }
                                        
                                        // If exact match not found, look for buttons where target number is a word boundary
                                        for (const btn of buttons) {
                                            const btnText = (btn.innerText || btn.textContent || '').trim();
                                            // Check if button text contains target number as a complete word (not part of another number)
                                            const regex = new RegExp(`\\b${targetNumber}\\b`);
                                            if (regex.test(btnText)) {
                                                if (btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0) {
                                                    btn.click();
                                                    return btnText;
                                                }
                                            }
                                        }
                                        
                                        return null;
                                    }, extractedNumber);
                                    
                                    if (flexibleMatch) {
                                        denominationFound = true;
                                        log(`[Order ${orderId}] Selected denomination: ${flexibleMatch}`);
                                    }
                                } catch (e) {
                                    log(`[Order ${orderId}] Error in flexible denomination match: ${e.message}`);
                                }
                            }
                            
                            if (!denominationFound) {
                                log(`[Order ${orderId}] Denomination not found for voucher value: ${voucherValue}`);
                                const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}_denomination_not_found.jpg`);
                                await page.screenshot({ path: filename });
                                const imageData = await fs.readFile(filename);
                                const imageBase64 = imageData.toString('base64');
                                
                                responseDict.vouchers.push({
                                    status: 'denomination_not_found',
                                    voucher_code: voucher,
                                    used_time: new Date().toLocaleString('en-US', { 
                                        year: 'numeric', 
                                        month: '2-digit', 
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                        hour12: false
                                    }).replace(',', ''),
                                    transaction_id: '',
                                    screenshot: imageBase64
                                });
                                continue;
                            }
                            
                            await new Promise(resolve => setTimeout(resolve, 500));
                            await page.waitForFunction("document.readyState === 'complete'", { timeout: 10000 });
                            
                            // Select payment channel
                            try {
                                const pvXpath = '/html/body/div[1]/div[1]/div/div[2]/div/div[1]/div[1]';
                                const paymentChannel = await retry_find_xpath(
                                    page, pvXpath, 5, 1, 2000, orderId, 'Payment channel element'
                                );
                                if (paymentChannel) {
                                    await new Promise(resolve => setTimeout(resolve, 500));
                                    await paymentChannel.click();
                                    log(`[Order ${orderId}] Payment channel selected.`);
                                    await new Promise(resolve => setTimeout(resolve, 500));
                                }
                            } catch (e) {
                                log(`[Order ${orderId}] Payment selection channel not found.`);
                            }
                            
                            // Select voucher platform
                            while (true) {
                                if (voucher.toLowerCase().includes('upbd')) {
                                    const upXpath = "//*[contains(text(), 'UP Gift Card')]";
                                    const voucherPlatform = await retry_find_xpath(
                                        page, upXpath, 5, 1, 2000, orderId, 'UP Gift Card voucher platform'
                                    );
                                    if (voucherPlatform) {
                                        await new Promise(resolve => setTimeout(resolve, 500));
                                        await voucherPlatform.click();
                                        log(`[Order ${orderId}] Voucher platform UP Gift Card selected.`);
                                        await new Promise(resolve => setTimeout(resolve, 500));
                                    } else {
                                        log(`[Order ${orderId}] Voucher platform for UP Gift Card not found after retries!`);
                                    }
                                } else if (voucher.toLowerCase().includes('bdmb')) {
                                    const bdXpath = '//*[@id="pc_div_659"]';
                                    const voucherPlatform2 = await retry_find_xpath(
                                        page, bdXpath, 5, 1, 2000, orderId, 'BDMB voucher platform'
                                    );
                                    if (voucherPlatform2) {
                                        await new Promise(resolve => setTimeout(resolve, 500));
                                        await voucherPlatform2.click();
                                        log(`[Order ${orderId}] Voucher platform BDMB selected.`);
                                        await new Promise(resolve => setTimeout(resolve, 500));
                                    } else {
                                        log(`[Order ${orderId}] Voucher platform for BDMB not found after retries!`);
                                    }
                                }
                                
                                try {
                                    const rateLimited = await page.$("text='You are being rate limited'");
                                    if (rateLimited) {
                                        log(`[Order ${orderId}] Rate limit detected. Waiting...`);
                                        await new Promise(resolve => setTimeout(resolve, 35000));
                                        await page.reload();
                                        continue;
                                    }
                                } catch (e) {
                                    // No rate limit
                                }
                                break;
                            }
                            
                            await page.waitForFunction("document.readyState === 'complete'", { timeout: 10000 });
                            
                            // Enter serial and PIN
                            try {
                                const parts = voucher.split(' ');
                                if (parts.length !== 2) {
                                    log(`[Order ${orderId}] Voucher format invalid for voucher ${voucher}.`);
                                    throw new Error('Invalid voucher format');
                                }
                                
                                const serial = parts[0];
                                const pinStr = parts[1];
                                const pins = pinStr.split('-');
                                
                                const serialInputSel = 'input[name=serial]';
                                const serialInput = await retry_find(page, serialInputSel, 5, 1, 2000, orderId, 'Serial number input');
                                if (serialInput) {
                                    await new Promise(resolve => setTimeout(resolve, 1000));
                                    await page.type(serialInputSel, serial);
                                } else {
                                    log(`[Order ${orderId}] Serial number entry not found for voucher ${voucher}.`);
                                    throw new Error('Serial number entry not found');
                                }
                                
                                for (let idx = 0; idx < pins.length; idx++) {
                                    const pinSelector = `input[name=pin_${idx + 1}]`;
                                    const pinInput = await retry_find(page, pinSelector, 5, 1, 1000, orderId, `PIN input block ${idx + 1}`);
                                    if (pinInput) {
                                        await new Promise(resolve => setTimeout(resolve, 200));
                                        await page.type(pinSelector, pins[idx]);
                                    } else {
                                        log(`[Order ${orderId}] PIN input for block ${idx + 1} not found for voucher ${voucher}.`);
                                        throw new Error('PIN input field not found');
                                    }
                                }
                                
                                const confirmXpath = '/html/body/div[1]/div[1]/div/div[2]/form/div[4]/div/input';
                                const confirmBtn = await retry_find_xpath(
                                    page, confirmXpath, 3, 1, 2000, orderId, 'Confirm button'
                                );
                                
                                if (confirmBtn) {
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                    await confirmBtn.click();
                                    log(`[Order ${orderId}] Confirm clicked for voucher ${voucher}.`);
                                    await new Promise(resolve => setTimeout(resolve, 300));
                                    await page.waitForFunction("document.readyState === 'complete'", { timeout: 10000 });
                                } else {
                                    log(`[Order ${orderId}] Confirm button not found for voucher ${voucher}.`);
                                    throw new Error('Confirm button not found');
                                }
                            } catch (error) {
                                log(`[Order ${orderId}] Error entering voucher ${voucher}: ${error.message}`);
                                const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}.jpg`);
                                await page.screenshot({ path: filename });
                                const imageData = await fs.readFile(filename);
                                const imageBase64 = imageData.toString('base64');
                                
                                responseDict.vouchers.push({
                                    status: 'topupfailed',
                                    voucher_code: voucher,
                                    used_time: new Date().toLocaleString('en-US', { 
                                        year: 'numeric', 
                                        month: '2-digit', 
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                        hour12: false
                                    }).replace(',', ''),
                                    transaction_id: '',
                                    screenshot: imageBase64
                                });
                                continue;
                            }
                            
                            await new Promise(resolve => setTimeout(resolve, 4000));
                            
                            // Check transaction status
                            let transactionSuccessful = false;
                            let transactionDate = '';
                            let transactionId = '';
                            let status = '';
                            
                            try {
                                const successXpath = '/html/body/div[1]/div[1]/div/div[1]/div[1]/div[1]/span';
                                const successElem = await retry_find_xpath(
                                    page, successXpath, 2, 1, 500, orderId, 'Success element'
                                );
                                
                                if (successElem) {
                                    transactionSuccessful = true;
                                    status = 'completed';
                                    
                                    const transactionIdXpath = '/html/body/div[1]/div[1]/div/div[1]/div[2]/div[4]/div[2]';
                                    const transactionIdElem = await retry_find_xpath(
                                        page, transactionIdXpath, 5, 1, 2000, orderId, 'Transaction ID element'
                                    );
                                    
                                    if (transactionIdElem) {
                                        transactionId = await page.evaluate(element => element.textContent, transactionIdElem);
                                    }
                                    
                                    transactionDate = new Date().toLocaleString('en-US', { 
                                        year: 'numeric', 
                                        month: '2-digit', 
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                        hour12: false
                                    }).replace(',', '');
                                } else {
                                    const currentUrl = page.url();
                                    if (currentUrl === 'https://www.unipin.com/unibox/error/Consumed%20Voucher') {
                                        transactionSuccessful = true;
                                        status = 'consumed';
                                        transactionId = '';
                                        transactionDate = new Date().toLocaleString('en-US', { 
                                            year: 'numeric', 
                                            month: '2-digit', 
                                            day: '2-digit',
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            second: '2-digit',
                                            hour12: false
                                        }).replace(',', '');
                                    }
                                }
                                
                                if (transactionSuccessful) {
                                    const clickXpath1 = '/html/body/div[1]/div[1]/div/div[2]/div/div/a';
                                    const clickBtn1 = await retry_find_xpath(
                                        page, clickXpath1, 1, 1, 500, orderId, 'Primary confirmation link'
                                    );
                                    if (clickBtn1) {
                                        await clickBtn1.click();
                                        await new Promise(resolve => setTimeout(resolve, 3000));
                                    }
                                    
                                    const clickXpath2 = '//*[@id="headlessui-popover-button-:r0:"]/div/div/img';
                                    const clickBtn2 = await retry_find_xpath(
                                        page, clickXpath2, 1, 1, 500, orderId, 'Pop-over button'
                                    );
                                    if (clickBtn2) {
                                        await clickBtn2.click();
                                        await new Promise(resolve => setTimeout(resolve, 2000));
                                    }
                                    
                                    const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}.jpg`);
                                    await page.screenshot({ path: filename });
                                    const imageData = await fs.readFile(filename);
                                    const imageBase64 = imageData.toString('base64');
                                    
                                    const voucherResult = {
                                        status,
                                        voucher_code: voucher,
                                        used_time: transactionDate,
                                        transaction_id: transactionId,
                                        screenshot: imageBase64
                                    };
                                    
                                    responseDict.vouchers.push(voucherResult);
                                    log(`[Order ${orderId}] Transaction successful for voucher ${voucher} with status: ${status}`);
                                    await updateOrderData(orderId, voucherResult);
                                    
                                    if (['completed', 'consumed'].includes(status)) {
                                        const details = orderLogDetails.get(orderId);
                                        details.completedVouchers++;
                                    }
                                } else {
                                    const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}.jpg`);
                                    await page.screenshot({ path: filename });
                                    const imageData = await fs.readFile(filename);
                                    const imageBase64 = imageData.toString('base64');
                                    
                                    responseDict.vouchers.push({
                                        status: 'failed',
                                        voucher_code: voucher,
                                        used_time: new Date().toLocaleString('en-US', { 
                                            year: 'numeric', 
                                            month: '2-digit', 
                                            day: '2-digit',
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            second: '2-digit',
                                            hour12: false
                                        }).replace(',', ''),
                                        transaction_id: '',
                                        screenshot: imageBase64
                                    });
                                    log(`[Order ${orderId}] Transaction failed for voucher ${voucher}.`);
                                }
                            } catch (error) {
                                log(`[Order ${orderId}] Transaction status check failed for voucher ${voucher}: ${error.message}`);
                                const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}.jpg`);
                                await page.screenshot({ path: filename });
                                const imageData = await fs.readFile(filename);
                                const imageBase64 = imageData.toString('base64');
                                
                                responseDict.vouchers.push({
                                    status: 'failed',
                                    voucher_code: voucher,
                                    used_time: new Date().toLocaleString('en-US', { 
                                        year: 'numeric', 
                                        month: '2-digit', 
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                        hour12: false
                                    }).replace(',', ''),
                                    transaction_id: '',
                                    screenshot: imageBase64
                                });
                                continue;
                            }
                            
                        } catch (error) {
                            log(`[Order ${orderId}] Error processing voucher ${voucher}: ${error.message}`);
                            const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}.jpg`);
                            await page.screenshot({ path: filename });
                            const imageData = await fs.readFile(filename);
                            const imageBase64 = imageData.toString('base64');
                            
                            responseDict.vouchers.push({
                                status: 'topupfailed',
                                voucher_code: voucher,
                                used_time: new Date().toLocaleString('en-US', { 
                                    year: 'numeric', 
                                    month: '2-digit', 
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                    hour12: false
                                }).replace(',', ''),
                                transaction_id: '',
                                screenshot: imageBase64
                            });
                            continue;
                        }
                    }
                }
            }
        }
        
        // Determine final order status
        if (responseDict.invalid_ids.length === (data.order_items || []).length) {
            responseDict.order_status = 'failed';
        } else if (responseDict.invalid_ids.length > 0) {
            responseDict.order_status = 'partial';
        } else {
            const successfulVouchers = responseDict.vouchers.filter(v => v.status === 'completed');
            if (successfulVouchers.length === responseDict.vouchers.length) {
                responseDict.order_status = 'done';
            } else if (successfulVouchers.length === 0) {
                responseDict.order_status = 'failed';
            } else {
                responseDict.order_status = 'partial';
            }
        }
        
        await postResultAsync(responseEndpoint, responseDict, orderId);
        return responseDict;
        
    } catch (error) {
        log(`[Order ${orderId}] An error occurred: ${error.message}`);
        const errorDict = {
            order_id: orderId,
            order_status: 'topupfailed',
            details: error.message
        };
        await postResultAsync(responseEndpoint, errorDict, orderId);
        return errorDict;
    } finally {
        // Clean up temp entry if it still exists
        runningBrowsers.delete(tempKey);
        
        if (browser) {
            try {
                await browser.close();
            } catch (error) {
                log(`[Order ${orderId}] Error stopping browser: ${error.message}`);
            }
            runningBrowsers.delete(newBrowserPid);
        }
        semaphore.release();
    }
}

// API Endpoints
app.post('/order/', async (req, res) => {
    try {
        const payload = req.body;
        const order_id = payload.order_id || "Unknown";
        
        log(`[Order ${order_id}] Received order with Order ID: ${order_id}`);
        
        // Start processing asynchronously
        processOrder(payload).catch(err => {
            log(`[Order ${order_id}] Error in background process_order: ${err.stack}`);
        });
        
        return res.status(200).json({ message: "Data received and is being processed" });
    } catch (e) {
        log(`[Order Unknown] Error adding task: ${e.stack}`);
        return res.status(500).json({ message: "An error occurred while processing the order" });
    }
});

app.post('/logs/', async (req, res) => {
    const payload = req.body;
    if (payload.command !== "Logs") {
        return res.status(400).json({ message: "Invalid command. Send {'command': 'Logs'}." });
    }
    
    const order_id = payload.order_id;
    if (order_id) {
        let active_time = null;
        let browser_info = Object.values(runningBrowsers).find(info => info.orderId === order_id);
        if (browser_info) {
            active_time = (new Date() - browser_info.startTime) / 1000; // in seconds
        }
        
        const details = orderLogDetails.get(order_id) || {};
        const total = details.totalVouchers !== undefined ? details.totalVouchers : "N/A";
        const completed = details.completedVouchers !== undefined ? details.completedVouchers : "N/A";
        const remaining = (typeof total === 'number' && typeof completed === 'number') ? total - completed : "N/A";
        
        const filtered_logs = logBuffer.filter(log_msg => log_msg.includes(`[Order ${order_id}]`));
        return res.json({
            order_id: order_id,
            active_time_seconds: active_time !== null ? active_time : "N/A",
            total_vouchers: total,
            completed_vouchers: completed,
            remaining_vouchers: remaining,
            console_logs: filtered_logs
        });
    } else {
        return res.json({ logs: logBuffer });
    }
});

app.post('/deleteOrders/', async (req, res) => {
    const payload = req.body;
    if (payload.command === "DELETE") {
        const order_id = payload.order_id;
        if (order_id) {
            const file_path = path.join(ORDERS_DIR, `${order_id}.json`);
            if (await fs.pathExists(file_path)) {
                try {
                    await fs.remove(file_path);
                    log(`Deleted order file for order id ${order_id}: ${file_path}`);
                    return res.json({ message: `Deleted order file for order id ${order_id}.` });
                } catch (e) {
                    log(`Error deleting order file ${file_path}: ${e}`);
                    return res.status(500).json({ message: `Error deleting order file for order id ${order_id}: ${e.message}` });
                }
                } else {
                return res.status(404).json({ message: `Order file for order id ${order_id} does not exist.` });
            }
        } else {
            try {
                const files = await glob(path.join(ORDERS_DIR, "*.json"));
                let deleted = 0;
                for (const file of files) {
                    try {
                        await fs.remove(file);
                        deleted++;
                    } catch (e) {
                        log(`Error deleting order file ${file}: ${e}`);
                    }
                }
                return res.json({ message: `Deleted ${deleted} order files.` });
            } catch (e) {
                log(`Error deleting order files: ${e}`);
                return res.status(500).json({ message: "An error occurred while deleting order files" });
            }
        }
    } else {
        return res.status(400).json({ message: "Invalid command. Send {'command': 'DELETE'}." });
    }
});

app.get('/test/', async (req, res) => {
    return res.json([
        {
            status: "completed",
            order_id: "74",
            voucher_code: "ABC123",
            used_time: "2023-04-24 12:00:00",
            screenshot: "http://example.com/screenshot.jpg"
        },
        {
            status: "failed",
            order_id: "74",
            voucher_code: "ABC1234",
            used_time: "2023-04-24 12:02:00",
            screenshot: "http://example.com/screenshot2.jpg"
        },
        {
            status: "completed",
            order_id: "74",
            voucher_code: "ABC1235",
            used_time: "2023-04-24 12:09:00",
            screenshot: "http://example.com/screenshot3.jpg"
        }
    ]);
});

app.post('/activedetails/', async (req, res) => {
    const payload = req.body;
    if (payload.command === "DETAILS") {
        const details = [];
        for (const [pid, info] of runningBrowsers.entries()) {
            const start_time = info.startTime;
            const order_id = info.orderId;
            const active_duration = (new Date() - start_time) / 1000; // in seconds
            details.push({
                order_id: order_id,
                active_duration_seconds: active_duration,
                start_time: start_time.toISOString().replace('T', ' ').split('.')[0]
            });
        }
        return res.json({ active_instances: runningBrowsers.size, details: details });
    } else {
        return res.status(400).json({ message: "Invalid command. Send {'command': 'DETAILS'}." });
    }
});

app.post('/stopprocess/', async (req, res) => {
    const payload = req.body;
    if (payload.command === "STOP") {
        const order_id = payload.order_id;
        if (order_id) {
            if (order_id === "ALL") {
                const responses = [];
                for (const [pid, info] of runningBrowsers.entries()) {
                    let screenshot_base64 = "";
                    try {
                        const page = info.page;
                        if (page) {
                            const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}_stop.jpg`);
                            await page.screenshot({ path: filename });
                            const image_data = await fs.readFile(filename);
                            screenshot_base64 = image_data.toString('base64');
                        }
                        await info.browser.close();
                        log("Browser instance stopped.");
                    } catch (e) {
                        log(`Error stopping browser: ${e.message}`);
                    }
                    const response_struct = {
                        order_id: info.orderId,
                        order_status: "topupfailed",
                        vouchers: [{
                            status: "topupfailed",
                            voucher_code: "",
                            used_time: new Date().toLocaleString('en-US', { 
                                year: 'numeric', 
                                month: '2-digit', 
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: false
                            }).replace(',', ''),
                            transaction_id: "",
                            screenshot: screenshot_base64
                        }],
                        invalid_ids: []
                    };
                    responses.push(response_struct);
                    runningBrowsers.delete(pid);
                }
                return res.json({ message: "All running browsers have been stopped.", responses: responses });
            } else {
                let stopped = false;
                let response_struct = null;
                for (const [pid, info] of runningBrowsers.entries()) {
                    if (info.orderId === order_id) {
                        let screenshot_base64 = "";
                        try {
                            const page = info.page;
                            if (page) {
                                const filename = path.join(OUTPUT_IMAGES_DIR, `${new Date().toISOString().replace(/:/g, '-').split('.')[0]}_stop.jpg`);
                                await page.screenshot({ path: filename });
                                const image_data = await fs.readFile(filename);
                                screenshot_base64 = image_data.toString('base64');
                            }
                            await info.browser.close();
                            log(`Browser instance for order ${order_id} stopped.`);
                            stopped = true;
                        } catch (e) {
                            log(`Error stopping browser for order ${order_id}: ${e.message}`);
                        }
                        response_struct = {
                            order_id: order_id,
                            order_status: "topupfailed",
                            vouchers: [{
                                status: "topupfailed",
                                voucher_code: "",
                                used_time: new Date().toLocaleString('en-US', { 
                                    year: 'numeric', 
                                    month: '2-digit', 
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                    hour12: false
                                }).replace(',', ''),
                                transaction_id: "",
                                screenshot: screenshot_base64
                            }],
                            invalid_ids: []
                        };
                        runningBrowsers.delete(pid);
                        break;
                    }
                }
                if (stopped) {
                    return res.json(response_struct);
                } else {
                    return res.json({ message: `No running browser instance found for order ${order_id}.` });
                }
            }
        } else {
            return res.json({ message: "Order id not provided. To stop all instances, send {'command': 'STOP', 'order_id': 'ALL'}." });
        }
    } else {
        return res.status(400).json({ message: "Invalid command. Send {'command': 'STOP'}." });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
