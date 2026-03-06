const { app } = require("../session");
var fetch = require('node-fetch');
const axios = require("axios");
const querystring = require("querystring");
const otplib = require("otplib");
const HttpsProxyAgent = require("https-proxy-agent");
const {
  conn,
  createTable,
  insertData,
  getTableData,
  getTableDataWithCriteria,
  updateData,
  deleteData,
  deleteTable,
  truncateTable,
} = require("../db");

otplib.authenticator.options = {
  step: 180,
  digits: 6,
  algorithm: "sha1",
};

const gameid = {
  ff: {
    app_id: 100067,
    packed_role_id: 0,
    name: "Freefire",
  },
};

const game = "ff";
const app_id = gameid[game]["app_id"];
const packed_role_id = gameid[game]["packed_role_id"];

async function datadomeTest(url) {
  const randomIP = `${Math.floor(Math.random() * 256)}.${Math.floor(
    Math.random() * 256
  )}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;

  const data = {
    jsData: JSON.stringify({
      plg: 0,
      plgod: false,
      plgne: "NA",
      plgre: "NA",
      plgof: "NA",
      plggt: "NA",
      pltod: false,
      br_h: 667,
      br_w: 375,
      br_oh: 667,
      br_ow: 375,
      jsf: false,
      cvs: null,
      phe: false,
      nm: false,
      sln: null,
      lo: true,
      lb: true,
      mp_cx: null,
      mp_cy: null,
      mp_mx: null,
      mp_my: null,
      mp_sx: null,
      mp_sy: null,
      mp_tr: null,
      mm_md: null,
      hc: 4,
      rs_h: 667,
      rs_w: 375,
      rs_cd: 24,
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      lg: "id-ID",
      pr: 2,
      ars_h: 667,
      ars_w: 375,
      tz: -420,
      tzp: null,
      str_ss: true,
      str_ls: true,
      str_idb: true,
      str_odb: true,
      abk: null,
      ts_mtp: 1,
      ts_tec: true,
      ts_tsa: true,
      so: "portrait-primary",
      wo: null,
      sz: null,
      wbd: false,
      wbdm: true,
      wdif: false,
      wdifts: false,
      wdifrm: false,
      wdw: true,
      prm: null,
      lgs: true,
      lgsod: false,
      usb: null,
      vnd: "Google Inc.",
      bid: "NA",
      mmt: "empty",
      plu: "empty",
      hdn: false,
      awe: false,
      geb: false,
      dat: false,
      eva: 33,
      med: "defined",
      ocpt: false,
      aco: "probably",
      acmp: "probably",
      acw: "probably",
      acma: "maybe",
      acaa: "probably",
      ac3: "",
      acf: "probably",
      acmp4: "maybe",
      acmp3: "probably",
      acwm: "maybe",
      acots: false,
      acmpts: true,
      acwts: false,
      acmats: false,
      acaats: true,
      ac3ts: false,
      acfts: false,
      acmp4ts: false,
      acmp3ts: false,
      acwmts: false,
      vco: "probably",
      vch: "probably",
      vcw: "probably",
      vc3: "maybe",
      vcmp: "",
      vcq: "",
      vc1: "probably",
      vcots: false,
      vchts: true,
      vcwts: true,
      vc3ts: false,
      vcmpts: false,
      vcqts: false,
      vc1ts: false,
      glrd: null,
      glvd: null,
      cfpp: null,
      cfcpw: null,
      cffpw: null,
      cffrb: null,
      cfpfe: null,
      stcfp: null,
      dvm: 8,
      sqt: false,
      bgav: true,
      rri: true,
      idfr: true,
      ancs: true,
      inlc: true,
      cgca: true,
      inlf: true,
      tecd: true,
      sbct: true,
      aflt: true,
      rgp: true,
      bint: true,
      xr: true,
      vpbq: true,
      svde: false,
      slat: null,
      spwn: false,
      emt: false,
      bfr: false,
      ttst: 12.59999942779541,
      ewsi: null,
      wwsi: null,
      slmk: null,
      dbov: false,
      ifov: false,
      hcovdr: false,
      plovdr: false,
      ftsovdr: false,
      hcovdr2: false,
      plovdr2: false,
      ftsovdr2: false,
      cokys: "bG9hZFRpbWVzY3NpYXBwcnVudGltZQ==L=",
      tagpu: null,
      tbce: 0,
      ecpc: false,
      bcda: false,
      idn: true,
      capi: false,
      nddc: 2,
      nclad: null,
      haent: null,
      dcok: ".bdgamesbazar.com",
    }),
    events: JSON.stringify([]),
    eventCounters: JSON.stringify({
      "mouse move": 3,
      "mouse click": 3,
      scroll: 8,
      "touch start": 6,
      "touch end": 6,
      "touch move": 5,
      "key press": 0,
      "key down": 5,
      "key up": 4,
    }),
    jsType: "le",
    cid: "7wjS722f1LrDsyaQa9pBI2nWnmLK8ksSQvrb.ojDP83oOy~..jUPYAdXD7I823mKpXqXARYE8tBZzFr98tq3KQlH9JgTLC.XkWk~zt5U1X",
    ddk: "A513A9E66F1AD6FB8D0C1D9D9264A3",
    Referer: url,
    request: new URL(url).pathname,
    responsePage: "origin",
    ddv: "4.6.0",
  };

  try {
    const response = await axios.post(
      "https://api-js.datadome.co/js/",
      querystring.stringify(data),
      {
        headers: {
          "x-forwarded-for": randomIP,
          "Content-type": "application/x-www-form-urlencoded",
          Host: "api-js.datadome.co",
          Origin: url,
          Referer: url,
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "cross-site",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
      }
    );

    const cookies = response.data.cookie || [];
    let clientId = null;

    const cookiesArray = Array.isArray(cookies) ? cookies : [cookies];

    for (const cookie of cookiesArray) {
      if (cookie.includes("datadome")) {
        const cookieParts = cookie.split(";")[0];
        clientId = cookieParts.split("=")[1];
        break;
      }
    }
    return { cookies: cookiesArray.join("; "), clientId };
  } catch (error) {
    console.error("Request failed", error);
  }
}

const request = async (method, url, data = null, headers = {}, csrf = null, uid, checkid = false) => {
  const resultdu = await getTableDataWithCriteria("garena", { uid });

  if (data !== null) {
    const dataDome = await datadomeTest(
      "https://bdgamesbazar.com/api/auth/player_id_login"
    );
    data = typeof data === "object" ? JSON.stringify(data) : data;

    headers = {
      ...headers,
      Connection: "keep-alive",
      "Sec-Ch-Ua":
        '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      Accept: "application/json",
      "Content-Type": "application/json",
      "Sec-Ch-Ua-Mobile": "?1",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Sec-Ch-Ua-Platform": '"Android"',
      Origin: "https://bdgamesbazar.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "X-Csrf-Token": csrf,
      Referer: "https://bdgamesbazar.com/",
      "Accept-Language":
        "en-GB,en;q=0.9,zh-MO;q=0.8,zh;q=0.7,id-ID;q=0.6,id;q=0.5,en-US;q=0.4",
      Cookie: `_ga=GA1.2.325429135.1717080814; _gid=GA1.2.1086323533.1725767898; source=pc; b.vnpopup.1=1; session_key=aoy222at8oxr7z1somhf4kvfvh63pkvr; datadome=${dataDome.clientId}; ${
        csrf ? `__csrf__=${csrf}` : "_gat=1;"
      }`,
    };
  } else {
    headers = {
      ...headers,
      Cookie: `_ga=GA1.2.325429135.1717080814; _gid=GA1.2.1086323533.1725767898; source=pc; b.vnpopup.1=1; session_key=${resultdu.data[0].session_key};`,
    };
  }

  try {
    const options = {
      method: method.toUpperCase(),
      headers,
      body: data ? data : undefined,
      agent: new HttpsProxyAgent(resultdu.data[0].proxy, {
        rejectUnauthorized: false,  // Allow self-signed certificates
        secureProtocol: 'TLSv1_2_method',  // Force TLS 1.2
        timeout: 30000,  // 30 second timeout
      }),
    };

    const response = await fetch(url, options);

    if (response) {
      const result = await response.json();
      if (result && result.data) {
        data = result.data;
      }
      return result;
    } else {
      return {
        status: false,
        error: "failed",
      };
    }
  } catch (error) {
    console.error(`Request failed: ${error.message}`);
    if (error.code === 'EPROTO' || error.message.includes('SSL')) {
      return { status: false, error: 'ssl_error' };
    }
    return {
      status: false,
      error: "failed",
    };
  }
};

async function loginWithRetry(game_id, uid) {
  const maxRetries = 3; // 1 initial attempt + 2 retries
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`   [Attempt ${attempt}/${maxRetries}] Validating Game ID: ${game_id}`);
      const loginResult = await login(game_id, uid);

      if (!loginResult.error) {
        return loginResult;
      }
      
      const isSSLFailure = loginResult.error === 'ssl_error';
      if (!isSSLFailure) {
        // If it's a non-retriable error like "invalid_id", fail immediately.
        return loginResult;
      }

      console.log(`   Login validation attempt ${attempt} failed due to SSL error.`);

      if (attempt < maxRetries) {
        console.log(`   Waiting 2 seconds before retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.log(`   Max retries reached for Game ID validation.`);
        return { error: "sslfailed" }; // Return the specific error for the endpoint to handle
      }
    } catch (e) {
      console.error(`   Critical error during login validation attempt ${attempt}:`, e.message);
       if (attempt >= maxRetries) {
        return { error: "sslfailed", details: e.message };
      }
    }
  }
}

async function login(game_id = null, uid) {
  if (game_id === null) return false;
  const url = "https://bdgamesbazar.com/api/auth/player_id_login";
  const result = await request("POST", url, {
    app_id: app_id,
    login_id: String(game_id),
  }, "", "", uid);
  if (result.error === "invalid_id") {
    return {
      status: false,
      error: "Invalid ID",
    };
  } else {
    return result;
  }
}

app.post("/garena/create", async (req, res) => {
  const { OrderID, uid, game_id, item, Quantity, session_key, fa_token, Proxy, callback_url } = req.body;

  // 1. INPUT VALIDATION
  if (!OrderID || !uid || !game_id || !item || !Quantity || !session_key || !fa_token || !Proxy) {
    return res.json({ success: false, message: "Parameter Not Found", required: ["OrderID", "uid", "game_id", "item", "Quantity", "session_key", "fa_token", "Proxy"] });
  }

  const itemsFromRequest = item.split(',').map(i => i.trim());
  
  try {
    // 2. VALIDATE ALL PRODUCTS EXIST
    const productDetails = [];
    for (const itemCode of itemsFromRequest) {
      const productData = await getTableDataWithCriteria("garena_product", { code: itemCode });
      if (!productData.success) {
        return res.json({ success: false, message: `Invalid item code in list: ${itemCode}` });
      }
      productDetails.push(productData.data[0]);
    }

    // 3. IDEMPOTENCY AND SAFETY CHECK
    const existingOrdersResult = await getTableDataWithCriteria("garena_history", { batch_id: String(OrderID) });
    const existingItems = existingOrdersResult.success ? existingOrdersResult.data : [];

    // If any items are currently processing, reject the request to avoid conflicts.
    const isProcessing = existingItems.some(item => item.status === 'Processing');
    if (isProcessing) {
      return res.json({
        success: false,
        message: `Your order is currently being processed. Please wait a moment before trying again.`,
        data: {
          batch_id: OrderID,
          status: 'Processing'
        }
      });
    }

    const completedRefids = new Set(
      existingItems
        .filter(item => item.status === 'Success')
        .map(item => item.refid)
    );

    const proposedItems = [];
    for (const product of productDetails) {
      for (let i = 1; i <= Quantity; i++) {
        proposedItems.push({
          product: product,
          refid: `${OrderID}_${product.code}_${i}`,
          productNameForHistory: Quantity > 1 ? `${product.name}_${i}` : product.name,
        });
      }
    }

    // Filter out items that are already successfully completed.
    const itemsToRetry = proposedItems.filter(item => !completedRefids.has(item.refid));

    if (itemsToRetry.length === 0 && proposedItems.length > 0) {
      return res.json({
        success: true,
        message: `All requested item(s) for OrderID '${OrderID}' are already completed. No new items were queued.`,
        data: {
          batch_id: OrderID,
          items_requested: proposedItems.length,
          items_already_completed: completedRefids.size,
          items_queued: 0,
        }
      });
    }

    // 4. INSERT/UPDATE GARENA ACCOUNT
    const existingUid = await getTableDataWithCriteria("garena", { uid });
    if (existingUid.success) {
      await updateData("garena", { uid }, { session_key, fa_token, proxy: Proxy, update_at: new Date() });
    } else {
      await insertData("garena", { uid, session_key, fa_token, proxy: Proxy });
    }

    // 5. VALIDATE GAME ID
    const checkid = await loginWithRetry(game_id, uid);
    if (checkid.error) {
        if (checkid.error === 'sslfailed') {
            return res.json({ success: false, message: "sslfailed" });
        }
        return res.json({ success: false, message: "Invalid Game ID" });
    }
    
    if (checkid.region !== "BD") {
      return res.json({ success: false, message: "Game ID Not Supported" });
    }
    
    // 6. CREATE/UPDATE BATCH ORDER IN `garena_history`
    const insertPromises = [];
    const updatePromises = [];
    
    // Build quick lookup of existing items by refid
    const existingByRefid = new Map(existingItems.map(i => [i.refid, i]));
    
    // Update any existing non-success items to use the new, valid player id and set to Processing
    for (const item of itemsToRetry) {
      const existing = existingByRefid.get(item.refid);
      if (existing && existing.status !== 'Success') {
        updatePromises.push(
          updateData("garena_history", { refid: item.refid }, {
            userid: game_id,
            nickname: checkid.nickname,
            status: "Processing",
            callback_url: callback_url || existing.callback_url || null
          })
        );
      }
    }
    
    // Determine which items are missing entirely and need to be inserted
    const missingItems = itemsToRetry.filter(item => !existingByRefid.has(item.refid));
    
    for (const item of missingItems) {
        insertPromises.push(
          insertData("garena_history", {
            uid,
            batch_id: OrderID,
            refid: item.refid, // Unique refid for each item
            userid: game_id,
            nickname: checkid.nickname,
            product: item.productNameForHistory, // Correctly formatted product name
            quantity: 1,
            callback_url: callback_url || null,
            status: "Processing",
          })
        );
    }

    await Promise.all([...updatePromises, ...insertPromises]);

    return res.json({
      success: true,
      message: `Batch order updated. ${updatePromises.length} item(s) updated, ${insertPromises.length} new item(s) queued for processing.`,
      data: {
        batch_id: OrderID,
        items_requested: proposedItems.length,
        items_already_completed_or_processing: completedRefids.size,
        items_updated: updatePromises.length,
        items_queued: insertPromises.length,
      }
    });

  } catch (error) {
    console.error("Error in /garena/create:", error);
    return res.json({ success: false, message: "Internal server error", error: error.message });
  }
});
