const express = require('express');
const axios = require('axios');
const cors = require("cors");
const { buildMpesaRouter } = require("./mpesa");

const DEFAULT_BUSINESS_CODE = String(process.env.DEFAULT_BUSINESS || "default").trim().toLowerCase() || "default";

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5003,http://127.0.0.1:5003")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

app.use(express.json());

function normalizeBusinessCode(value) {
  const businessCode = String(value || "").trim().toLowerCase();
  return businessCode || DEFAULT_BUSINESS_CODE;
}

function getBusinessEnvPrefix(businessCode) {
  const normalized = normalizeBusinessCode(businessCode);
  return normalized === "default" ? "" : `${normalized.toUpperCase()}_`;
}

function getBusinessKraConfig(businessCode = DEFAULT_BUSINESS_CODE) {
  const normalized = normalizeBusinessCode(businessCode);
  const prefix = getBusinessEnvPrefix(normalized);

  return {
    businessCode: normalized,
    baseUrl: process.env[`${prefix}KRA_BASE_URL`] || process.env.KRA_BASE_URL || "https://etims-api-sbx.kra.go.ke",
    pin: process.env[`${prefix}KRA_PIN`] || process.env.KRA_PIN || "",
    bhfId: process.env[`${prefix}KRA_BHF_ID`] || process.env.KRA_BHF_ID || "00",
    dvcSrlNo: process.env[`${prefix}KRA_DEVICE_SERIAL`] || process.env.KRA_DEVICE_SERIAL || "",
    token: process.env[`${prefix}KRA_TOKEN`] || process.env.KRA_TOKEN || "",
  };
}

function resolveKraConfigForRequest(req) {
  const businessCode = normalizeBusinessCode(
    req?.params?.businessCode || req?.query?.business || req?.headers?.["x-business-code"] || req?.businessCode || DEFAULT_BUSINESS_CODE
  );

  return getBusinessKraConfig(businessCode);
}

async function qrUrlToBase64(qrUrl) {
  try {
    const response = await axios.get(qrUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(response.data, 'binary').toString('base64');
    return `data:image/png;base64,${base64}`;
  } catch (err) {
    console.error("QR Convert Error", err.message);
    return null;
  }
}

function createKraRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    req.kraConfig = resolveKraConfigForRequest(req);
    next();
  });

  router.post('/create-invoice', async (req, res) => {
    const config = req.kraConfig;
    const { invoiceNo, buyer, items, paymentType } = req.body;

    let taxblAmt = 0;
    let taxAmt = 0;
    const itemList = items.map((it, idx) => {
      const splyAmt = it.quantity * it.sellingPrice;
      const itemTax = splyAmt * 0;
      taxblAmt += splyAmt;
      taxAmt += itemTax;
      return {
        itemSeq: idx + 1,
        itemCd: it.itemCode || `ITEM00${idx + 1}`,
        itemClsCd: it.itemClsCd || "87083000",
        itemNm: it.name,
        qty: it.quantity,
        prc: it.sellingPrice,
        splyAmt,
        dcRt: 0,
        dcAmt: 0,
        isrccCd: null,
        isrccNm: null,
        isrcRt: null,
        isrcAmt: null,
        vatCatCd: "C",
        exciseTxCatCd: null,
        tlTaxblAmt: splyAmt,
        taxblAmt: splyAmt,
        taxAmt: itemTax,
        totAmt: splyAmt + itemTax
      };
    });

    const kraPayload = {
      trdInvcNo: invoiceNo,
      invcDt: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
      trdPin: config.pin,
      bhfId: config.bhfId,
      custPin: buyer.pin || null,
      custNm: buyer.name,
      salesTyCd: buyer.pin ? "B" : "C",
      rcptTyCd: "S",
      pmtTyCd: paymentType || "01",
      pmtNm: paymentType === "05" ? "M-PESA" : "CASH",
      salesSttsCd: "02",
      cfmSch: "01",
      salesDt: new Date().toISOString().slice(0, 8).replace(/-/g, ''),
      totItemCnt: items.length,
      taxblAmtA: taxblAmt,
      taxAmtA: taxAmt,
      totAmt: taxblAmt + taxAmt,
      itemList
    };

    try {
      console.log(`KRA REQUEST [${config.businessCode}]`, kraPayload);
      const kraRes = await axios.post(
        `${config.baseUrl}/trnsSales/saveSales`,
        kraPayload,
        {
          headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
            'tin': config.pin,
            'bhfId': config.bhfId,
            'dvcSrlNo': config.dvcSrlNo,
          }
        }
      );

      const { cuInvcNo, qrCodeUrl, invcNo } = kraRes.data.data || kraRes.data;
      const qrBase64 = qrUrlToBase64 ? await qrUrlToBase64(qrCodeUrl) : null;

      return res.json({
        success: true,
        business: config.businessCode,
        cuInvoiceNo: cuInvcNo,
        kraInvoiceNo: invcNo,
        qrUrl: qrCodeUrl,
        qrBase64,
        kraPayload: kraRes.data
      });
    } catch (err) {
      console.error(`KRA ERROR [${config.businessCode}]`, err.response?.data || err.message);
      return res.status(400).json({
        success: false,
        business: config.businessCode,
        error: err.response?.data || err.message,
        kraPayload
      });
    }
  });

  router.get('/purchases', async (req, res) => {
    const config = req.kraConfig;

    try {
      const resp = await axios.get(
        `${config.baseUrl}/trnsPurchase/selectTrnsPurchaseSales`,
        {
          headers: {
            'Authorization': `Bearer ${config.token}`,
            'tin': config.pin,
            'bhfId': config.bhfId,
          },
          params: { lastReqDt: "20200101" }
        }
      );
      res.json({ business: config.businessCode, data: resp.data });
    } catch (e) {
      res.status(400).json({
        business: config.businessCode,
        error: e.response?.data || e.message,
      });
    }
  });

  return router;
}

app.use('/:businessCode/api/etims', createKraRouter());
app.use('/api/etims', createKraRouter());
app.use('/:businessCode/api/mpesa', buildMpesaRouter());
app.use('/api/mpesa', buildMpesaRouter());

if (require.main === module) {
  app.listen();
}

module.exports = app;