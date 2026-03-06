const { app, logToFile } = require("../session");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const axios = require("axios");
const querystring = require("querystring");
const otplib = require("otplib");
const { HttpsProxyAgent } = require("https-proxy-agent");
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
const moment = require("moment-timezone");

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

const request = async (
  method,
  url,
  data = null,
  headers = {},
  csrf = null,
  uid
) => {
  const resultdu = await getTableDataWithCriteria("garena", { uid });
  if (!resultdu.success) {
    // console.error(`No garena data found for UID: ${uid}. Skipping request.`);
    return { status: false, error: "no_garena_account" };
  }

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
      Cookie: `_ga=GA1.2.325429135.1717080814; _gid=GA1.2.1086323533.1725767898; source=pc; b.vnpopup.1=1; session_key=${
        resultdu.data[0].session_key
      }; datadome=${dataDome.clientId}; ${
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
    let agent = undefined;

    if (url === "https://bdgamesbazar.com/api/auth/player_id_login") {
      agent = new HttpsProxyAgent(resultdu.data[0].proxy);
    }

    const options = {
      method: method.toUpperCase(),
      headers,
      body: data ? data : undefined,
      agent,
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
    console.error(error.message || "Unknown error occurred");
    return {
      status: false,
      error: "failed",
    };
  }
};

const request2 = async (
  method,
  url,
  data = null,
  headers = {},
  csrf = null,
  uid
) => {
  const resultdu = await getTableDataWithCriteria("garena", { uid });
  if (!resultdu.success) {
    // console.error(`No garena data found for UID: ${uid}. Skipping request.`);
    return { status: false, error: "no_garena_account" };
  }
  if (data !== null) {
    data = typeof data === "object" ? JSON.stringify(data) : data;

    headers = {
      ...headers,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Cookie: `_ga=GA1.2.325429135.1717080814; _gid=GA1.2.1086323533.1725767898; source=pc; b.vnpopup.1=1; session_key=${resultdu.data[0].session_key};`,
    };
  } else {
    headers = {
      ...headers,
      Cookie: `_ga=GA1.2.325429135.1717080814; _gid=GA1.2.1086323533.1725767898; source=pc; b.vnpopup.1=1; session_key=${resultdu.data[0].session_key};`,
    };
  }

  try {
    const response = await axios({
      method: method.toUpperCase(),
      url,
      data,
      headers,
    });

    if (response.status >= 200 && response.status < 300) {
      return response;
    } else {
    }
  } catch (error) {
    console.error("Error during request:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
  }
};

async function login(game_id = null, uid) {
  if (game_id === null) return false;
  const url = "https://bdgamesbazar.com/api/auth/player_id_login";
  const result = await request(
    "POST",
    url,
    {
      app_id: app_id,
      login_id: String(game_id),
    },
    "",
    "",
    uid
  );
  if (result.error === "invalid_id") {
    return {
      status: false,
      error: "Invalid ID",
    };
  } else {
    return result;
  }
}

async function loginGarena(uid) {
  const sess = await request(
    "GET",
    "https://bdgamesbazar.com/api/auth/check_session",
    "",
    "",
    "",
    uid
  );
  const result = await loginSSO(sess.session_key, uid);
  result["session_key"] = sess.session_key;
  return result;
}

async function loginSSO(session_key, uid) {
  const result = await request(
    "POST",
    "https://bdgamesbazar.com/api/auth/sso",
    {
      session_key: session_key,
    },
    "",
    "",
    uid
  );
  return result;
}

async function getId(uid) {
  const result = await request(
    "GET",
    "https://bdgamesbazar.com/api/auth/get_user_info",
    {},
    "",
    "",
    uid
  );
  return result;
}

async function getRole() {
  const result = await request(
    "GET",
    `https://bdgamesbazar.com/api/shop/apps/roles?app_id=${app_id}`
  );
  return result[app_id][0];
}

async function generateOTP(secret) {
  const otp = otplib.authenticator.generate(secret);
  return otp;
}

async function buyDiamond(refid, garenaUID, OTP, itemID, uid) {
  const database = getTableDataWithCriteria("garena_history", {
    uid,
    refid,
    status: "Success",
  });

  if (database.success) {
    return {
      result: "success",
      display_id: database.data[0].order_id,
    };
  } else {
    const csrfResponse = await request2(
      "POST",
      "https://bdgamesbazar.com/api/preflight",
      {},
      "",
      "",
      uid
    );
    const csrfCookie = csrfResponse.headers["set-cookie"][0];
    const csrfToken = csrfCookie.split("; ")[0].split("=")[1];

    const data = {
      app_id: app_id,
      channel_id: 221070,
      channel_data: {
        otp_code: OTP,
        garena_uid: garenaUID,
      },
      item_id: parseFloat(itemID),
      packed_role_id: packed_role_id,
      service: "pc",
    };

    const result = await request(
      "POST",
      "https://bdgamesbazar.com/api/shop/pay/init?language=en&region=BD",
      data,
      {
        "X-Csrf-Token": csrfToken,
      },
      csrfToken,
      uid
    );

    return result;
  }
}

const ids = ["1706983935"];
let currentIdIndex = 0;

const executeTask = async (uid) => {
  const currentId = ids[currentIdIndex];

  const order = await getTableDataWithCriteria("garena_history", {
    status: "Processing",
    uid,
  });

  if (!order.success) {
    try {
      const refid = moment.tz("Asia/Jakarta").format("YYYY-MM-DD HH:mm:ss");
      await login(currentId, uid);
      const garena = await loginGarena(uid);
      const diamondbuy = await buyDiamond(
        refid,
        garena.uid,
        "000000",
        "4010",
        uid
      );
      await updateData(
        "garena",
        { uid },
        {
          update_at: moment.tz("Asia/Jakarta").format("YYYY-MM-DD HH:mm:ss"),
        }
      );
      console.log("Login tasks completed.");
    } catch (error) {
      console.error("Error during tasks execution:", error.message);
    }

    currentIdIndex = (currentIdIndex + 1) % ids.length;
  } else {
    setTimeout(executeTask, 10000);
  }
};

app.get("/garena/session", async (req, res) => {
  const timeInJakarta = moment.tz("Asia/Jakarta");

  const [rows] = await conn.promise().query("SELECT * FROM garena ORDER BY update_at ASC LIMIT 2");

  if (!rows || rows.length === 0) {
    return res.json({ message: "No accounts found in the garena table." });
  }

  const filteredOrders = rows.filter((deposit) => {
    const updateAt = moment.tz(deposit.update_at, "Asia/Jakarta");
    const thresholdTime = updateAt.add(20, "minutes");
    return timeInJakarta.isAfter(thresholdTime);
  });

  if (filteredOrders.length === 0) {
    return res.json({ message: "No accounts older than 20 minutes among the oldest 2." });
  }

  for (const deposit of filteredOrders) {
    executeTask(deposit.uid);
  }

  res.json({ message: "Tasks started for eligible orders." });
});
