const express = require("express");

const DEFAULT_BUSINESS_CODE = String(process.env.DEFAULT_BUSINESS || "default").trim().toLowerCase() || "default";

const DEFAULT_MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY || "",
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || "",
  shortCode: process.env.MPESA_SHORTCODE || 174379,
  passkey: process.env.MPESA_PASSKEY || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
  callbackUrl: process.env.MPESA_CALLBACK_URL || "https://api.yelivate.top/api/mpesa/callback",
  baseUrl: process.env.MPESA_BASE_URL || "https://sandbox.safaricom.co.ke",
};

function normalizeBusinessCode(value) {
  const businessCode = String(value || "").trim().toLowerCase();
  return businessCode || DEFAULT_BUSINESS_CODE;
}

function getBusinessEnvPrefix(businessCode) {
  const normalized = normalizeBusinessCode(businessCode);
  return normalized === "default" ? "" : `${normalized.toUpperCase()}_`;
}

function getBusinessMpesaConfig(businessCode = DEFAULT_BUSINESS_CODE) {
  const normalized = normalizeBusinessCode(businessCode);
  const prefix = getBusinessEnvPrefix(normalized);

  return {
    businessCode: normalized,
    consumerKey: process.env[`${prefix}MPESA_CONSUMER_KEY`] || process.env.MPESA_CONSUMER_KEY || "",
    consumerSecret: process.env[`${prefix}MPESA_CONSUMER_SECRET`] || process.env.MPESA_CONSUMER_SECRET || "",
    shortCode: process.env[`${prefix}MPESA_SHORTCODE`] || process.env.MPESA_SHORTCODE || DEFAULT_MPESA_CONFIG.shortCode,
    passkey: process.env[`${prefix}MPESA_PASSKEY`] || process.env.MPESA_PASSKEY || "",
    callbackUrl: process.env[`${prefix}MPESA_CALLBACK_URL`] || process.env.MPESA_CALLBACK_URL || DEFAULT_MPESA_CONFIG.callbackUrl,
    baseUrl: process.env[`${prefix}MPESA_BASE_URL`] || process.env.MPESA_BASE_URL || DEFAULT_MPESA_CONFIG.baseUrl,
  };
}

function resolveMpesaConfigForRequest(req, fallbackConfig = {}) {
  const businessCode = normalizeBusinessCode(
    req?.params?.businessCode || req?.query?.business || req?.headers?.["x-business-code"] || req?.businessCode || DEFAULT_BUSINESS_CODE,
  );

  return {
    ...DEFAULT_MPESA_CONFIG,
    ...fallbackConfig,
    ...getBusinessMpesaConfig(businessCode),
  };
}

function createDefaultMpesaStore() {
  const payments = new Map();

  return {
    create(payment) {
      const checkoutRequestId = payment.checkoutRequestId || payment.CheckoutRequestID || `mpesa:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      const record = { ...payment, checkoutRequestId };
      payments.set(checkoutRequestId, record);
      return record;
    },
    get(checkoutRequestId) {
      const payment = payments.get(checkoutRequestId);
      if (!payment) {
        const error = new Error("M-PESA payment not found");
        error.status = 404;
        throw error;
      }
      return payment;
    },
    update(checkoutRequestId, updates) {
      const existing = this.get(checkoutRequestId);
      const next = { ...existing, ...updates, checkoutRequestId };
      payments.set(checkoutRequestId, next);
      return next;
    },
  };
}

function getMpesaTimestamp() {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

async function getMpesaAccessToken(config = DEFAULT_MPESA_CONFIG) {
  const consumerKey = String(config.consumerKey || "").trim();
  const consumerSecret = String(config.consumerSecret || "").trim();

  if (!consumerKey || !consumerSecret) {
    throw new Error("M-PESA consumer key and secret are required.");
  }

  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`, "utf8").toString("base64");
  const url = `${config.baseUrl || "https://sandbox.safaricom.co.ke"}/oauth/v1/generate?grant_type=client_credentials`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
      "User-Agent": "xsfarmpos/1.0",
    },
  });

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(`Daraja OAuth failed (${response.status}): ${rawBody || "Empty response"}`);
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`Daraja returned invalid JSON: ${rawBody}`);
  }

  if (!data.access_token) {
    throw new Error(data.errorMessage || data.error_description || "Daraja did not return an access token");
  }

  return data.access_token;
}

async function initiateMpesaSTK({
  phoneNumber,
  amount,
  accountReference,
  transactionDesc,
  config = DEFAULT_MPESA_CONFIG,
}) {
  const shortCode = String(config.shortCode || "").trim();
  const passkey = String(config.passkey || "").trim();
  const baseUrl = String(config.baseUrl || DEFAULT_MPESA_CONFIG.baseUrl).trim();

  if (!phoneNumber) {
    throw new Error("Phone number is required");
  }

  if (!shortCode || !passkey) {
    throw new Error("M-PESA short code and passkey are required for STK push.");
  }

  if (!amount || Number(amount) <= 0) {
    throw new Error("Valid amount is required");
  }

  const accessToken = await getMpesaAccessToken(config);
  const timestamp = getMpesaTimestamp();
  const password = Buffer.from(`${shortCode}${passkey}${timestamp}`, "utf8").toString("base64");

  const response = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      BusinessShortCode: Number(shortCode),
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(Number(amount)),
      PartyA: phoneNumber,
      PartyB: Number(shortCode),
      PhoneNumber: phoneNumber,
      CallBackURL: config.callbackUrl,
      AccountReference: accountReference || "XSFARM",
      TransactionDesc: transactionDesc || "Nursery POS payment",
    }),
  });

  const rawBody = await response.text();
  let data = {};

  try {
    data = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    throw new Error(`Daraja returned invalid JSON for STK push: ${rawBody}`);
  }

  if (!response.ok) {
    console.error("Daraja STK error:", data);
    throw new Error(data.errorMessage || data.ResponseDescription || rawBody || "STK Push failed");
  }

  return data;
}

function buildMpesaRouter(options = {}) {
  const router = express.Router();
  const defaultConfig = { ...DEFAULT_MPESA_CONFIG, ...(options.config || {}) };
  const store = options.store || createDefaultMpesaStore();

  const resolveConfig = (req) => resolveMpesaConfigForRequest(req, defaultConfig);

  router.use((req, res, next) => {
    req.mpesaConfig = resolveConfig(req);
    next();
  });

  router.post("/stkpush", async (req, res) => {
    try {
      const config = resolveConfig(req);
      const { phoneNumber, amount, accountReference, transactionDesc } = req.body || {};

      if (!phoneNumber) {
        return res.status(400).json({ success: false, message: "Phone number is required" });
      }

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, message: "Valid amount is required" });
      }

      const result = await initiateMpesaSTK({
        phoneNumber,
        amount,
        accountReference,
        transactionDesc,
        config,
      });

      if (result.CheckoutRequestID) {
        store.create({
          status: "pending",
          amount: Number(amount),
          phoneNumber,
          merchantRequestId: result.MerchantRequestID || null,
          checkoutRequestId: result.CheckoutRequestID,
          transactionId: null,
          source: "stk",
        });
      }

      return res.json({ success: true, ...result });
    } catch (error) {
      console.error("M-Pesa STK Push failed:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  router.post("/callback", (req, res) => {
    try {
      const callback = req.body?.Body?.stkCallback;

      if (!callback) {
        return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
      }

      const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;

      let payment;

      try {
        payment = store.get(CheckoutRequestID);
      } catch (error) {
        if (error.status === 404) {
          return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
        }
        throw error;
      }

      if (Number(ResultCode) === 0) {
        const metadata = CallbackMetadata?.Item || [];
        const getMetadata = (name) => metadata.find((item) => item.Name === name)?.Value;

        const updatedPayment = store.update(CheckoutRequestID, {
          status: "completed",
          transactionId: getMetadata("MpesaReceiptNumber") || null,
          amount: getMetadata("Amount") ?? payment.amount,
          phoneNumber: getMetadata("PhoneNumber") || payment.phoneNumber,
          transactionDate: getMetadata("TransactionDate") || null,
          resultCode: Number(ResultCode),
          resultDesc: ResultDesc,
          merchantRequestId: MerchantRequestID,
        });

        return res.json({ ResultCode: 0, ResultDesc: "Accepted", payment: updatedPayment });
      }

      const updatedPayment = store.update(CheckoutRequestID, {
        status: "failed",
        source: "stk",
        resultCode: Number(ResultCode),
        resultDesc: ResultDesc,
        merchantRequestId: MerchantRequestID,
      });

      return res.json({ ResultCode: 0, ResultDesc: "Accepted", payment: updatedPayment });
    } catch (error) {
      console.error("Error processing M-PESA callback:", error);
      return res.status(500).json({ ResultCode: 1, ResultDesc: "Internal server error" });
    }
  });

  router.get("/status/:checkoutRequestId", (req, res) => {
    const { checkoutRequestId } = req.params;

    try {
      const payment = store.get(checkoutRequestId);
      return res.json({ success: true, payment });
    } catch (error) {
      if (error.status === 404) {
        return res.status(404).json({ success: false, message: "M-PESA payment not found" });
      }

      console.error("M-PESA status error:", error);
      return res.status(500).json({ success: false, message: "Failed to retrieve M-PESA payment" });
    }
  });

  return router;
}

module.exports = {
  DEFAULT_MPESA_CONFIG,
  createDefaultMpesaStore,
  getMpesaAccessToken,
  getMpesaTimestamp,
  initiateMpesaSTK,
  buildMpesaRouter,
};
