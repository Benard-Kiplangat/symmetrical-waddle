const express = require("express");
const axios = require("axios");
const QRCode = require("qrcode");
const cors = require("cors");
const { buildMpesaRouter } = require("./mpesa");

const DEFAULT_BUSINESS_CODE = String(process.env.DEFAULT_BUSINESS || "default").trim().toLowerCase() || "default";
const DEFAULT_DIGITAX_URL = "https://api.digitax.tech/ke/v2";

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

function getBusinessDigitaxConfig(businessCode = DEFAULT_BUSINESS_CODE) {
  const normalized = normalizeBusinessCode(businessCode);
  const prefix = getBusinessEnvPrefix(normalized);

  return {
    businessCode: normalized,
    baseUrl: process.env[`${prefix}DIGITAX_BASE_URL`] || process.env.DIGITAX_BASE_URL || DEFAULT_DIGITAX_URL,
    apiKey: process.env[`${prefix}DIGITAX_API_KEY`] || process.env.DIGITAX_API_KEY || "",
  };
}

function resolveDigitaxConfigForRequest(req) {
  const businessCode = normalizeBusinessCode(
    req?.params?.businessCode ||
    req?.query?.business ||
    req?.headers?.["x-business-code"] ||
    req?.businessCode ||
    DEFAULT_BUSINESS_CODE
  );
  return getBusinessDigitaxConfig(businessCode);
}

function digitaxRequest(config) {
  if (!config.apiKey) {
    const error = new Error("DIGITAX_API_KEY is not configured");
    error.status = 500;
    throw error;
  }

  return {
      headers: {
    accept: 'application/json',
    'content-type': 'application/json',
    'X-API-Key': config.apiKey
  },
  };
}

function getErrorPayload(error) {
  return error.response?.data || error.message;
}

function mapItemToDigitax(item) {
  return {
    item_class_code: String(item.itemClassCode || item.itemClsCd || "10150000"),
    item_type_code: String(item.itemTypeCode || "3"),
    item_name: String(item.name || item.itemName || ""),
    origin_nation_code: String(item.originNationCode || "KE"),
    package_unit_code: String(item.packageUnitCode || "NT"),
    quantity_unit_code: String(item.quantityUnitCode || "U"),
    tax_type_code: String(item.taxTypeCode || "D"),
    default_unit_price: Number(item.defaultUnitPrice ?? item.sellingPrice ?? item.price ?? 0),
    stock_quantity: Number(item.stockQuantity ?? item.quantity ?? 0),
    item_bar_code: item.itemBarCode || item.itemCode || undefined,
    levies: Array.isArray(item.levies) ? item.levies : undefined,
    callback_url: item.callbackUrl || undefined,
  };
}

function mapCustomerToDigitax(customer) {
  return {
    customer_name: String(customer.name || customer.customerName || "").trim(),
    customer_tin: String(customer.krapin || customer.pin || customer.customerTin || "").trim(),
    email: customer.email || undefined,
    phone: customer.phone || undefined,
  };
}

function mapSupplierToDigitax(supplier) {
  return {
    supplier_name: String(supplier.name || supplier.supplierName || "").trim(),
    supplier_tin: String(supplier.krapin || supplier.pin || supplier.supplierTin || "").trim(),
    email: supplier.email || undefined,
    phone: supplier.phone || undefined,
  };
}

async function qrUrlToBase64(qrUrl) {
  if (!qrUrl) return null;

  let parsedUrl;
  try {
    parsedUrl = new URL(qrUrl);
  } catch {
    throw new Error("DigiTax returned an invalid QR URL");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("DigiTax returned an unsupported QR URL protocol");
  }

  const response = await axios.get(parsedUrl.toString(), {
    responseType: "arraybuffer",
    timeout: 10000,
    maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 2 * 1024 * 1024,
  });
  const contentType = String(response.headers["content-type"] || "").toLowerCase();

  if (contentType.startsWith("image/")) {
    return `data:${contentType};base64,${Buffer.from(response.data).toString("base64")}`;
  }

  // DigiTax offline receipt URLs return an HTML receipt page. Encode that
  // verifiable URL as the QR image instead of passing HTML to jsPDF.
  if (contentType.includes("text/html")) {
    return QRCode.toDataURL(parsedUrl.toString(), {
      errorCorrectionLevel: "M",
      type: "image/png",
      margin: 1,
      width: 320,
    });
  }

  throw new Error(`DigiTax QR URL returned unsupported content type: ${contentType || "unknown"}`);
}

async function mapSaleResponse(data, config, payload) {
  const sale = data?.data || data;
  const qrUrl = sale.etims_url || sale.offline_url || null;
  let qrBase64 = null;

  if (qrUrl) {
    try {
      qrBase64 = await qrUrlToBase64(qrUrl);
    } catch (error) {
      console.error(`DigiTax QR conversion error [${config.businessCode}]`, error.message);
    }
  }

  return {
    success: true,
    business: config.businessCode,
    // Keep the names used by the existing receipt consumer.
    cuInvoiceNo: sale.serial_number || sale.receipt_number || sale.invoice_number,
    kraInvoiceNo: sale.invoice_number || sale.receipt_number,
    qrUrl,
    qrBase64,
    digitaxPayload: data,
    kraPayload: data,
    invoice: sale,
    digitaxPayloadSent: payload,
    taxSummary: data.sales_tax_summary,
  };
}

function createDigitaxRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    req.digitaxConfig = resolveDigitaxConfigForRequest(req);
    next();
  });

  // DigiTax API: POST /items. The local item shape (name, sellingPrice, etc.)
  // is accepted and converted to the documented DigiTax item schema.
  router.post("/items", async (req, res) => {
    const config = req.digitaxConfig;
    const payload = mapItemToDigitax(req.body || {});

    try {
      const response = await axios.post(`${config.baseUrl}/items`, payload, digitaxRequest(config));
      return res.status(response.status || 201).json({
        success: true,
        business: config.businessCode,
        item: response.data?.data || response.data,
        digitaxPayload: response.data,
      });
    } catch (error) {
      console.error(`DigiTax item error [${config.businessCode}]`, getErrorPayload(error));
      return res.status(error.status || error.response?.status || 400).json({
        success: false,
        business: config.businessCode,
        error: getErrorPayload(error),
        digitaxPayloadSent: payload,
      });
    }
  });

  router.get("/items", async (req, res) => {
    const config = req.digitaxConfig;
    try {
      const response = await axios.get(`${config.baseUrl}/items`, {
        ...digitaxRequest(config),
        params: {
          before: req.query.before,
          after: req.query.after,
          page_size: req.query.page_size,
        },
      });
      return res.json({ success: true, business: config.businessCode, data: response.data });
    } catch (error) {
      console.error(`DigiTax items error [${config.businessCode}]`, getErrorPayload(error));
      return res.status(error.status || error.response?.status || 400).json({
        success: false,
        business: config.businessCode,
        error: getErrorPayload(error),
      });
    }
  });

  router.post("/customers", async (req, res) => {
    const config = req.digitaxConfig;
    const payload = mapCustomerToDigitax(req.body || {});

    if (!payload.customer_name || !payload.customer_tin) {
      return res.status(400).json({
        success: false,
        business: config.businessCode,
        error: "Customer name and KRA PIN are required to register a DigiTax customer.",
      });
    }

    try {
      const response = await axios.post(`${config.baseUrl}/customers`, payload, digitaxRequest(config));
      return res.status(response.status || 201).json({
        success: true,
        business: config.businessCode,
        customer: response.data?.data || response.data,
        digitaxPayload: response.data,
      });
    } catch (error) {
      console.error(`DigiTax customer error [${config.businessCode}]`, getErrorPayload(error));
      return res.status(error.status || error.response?.status || 400).json({
        success: false,
        business: config.businessCode,
        error: getErrorPayload(error),
        digitaxPayloadSent: payload,
      });
    }
  });

  router.put("/customers/:customerId", async (req, res) => {
    const config = req.digitaxConfig;
    const payload = mapCustomerToDigitax(req.body || {});

    if (!req.params.customerId || !payload.customer_name || !payload.customer_tin) {
      return res.status(400).json({
        success: false,
        business: config.businessCode,
        error: "Customer ID, name and KRA PIN are required to update a DigiTax customer.",
      });
    }

    try {
      const response = await axios.put(
        `${config.baseUrl}/customers/${encodeURIComponent(req.params.customerId)}`,
        payload,
        digitaxRequest(config)
      );
      return res.status(response.status || 200).json({
        success: true,
        business: config.businessCode,
        customer: response.data?.data || response.data,
        digitaxPayload: response.data,
      });
    } catch (error) {
      console.error(`DigiTax customer update error [${config.businessCode}]`, getErrorPayload(error));
      return res.status(error.status || error.response?.status || 400).json({
        success: false,
        business: config.businessCode,
        error: getErrorPayload(error),
        digitaxPayloadSent: payload,
      });
    }
  });

  router.get("/customers", async (req, res) => {
    const config = req.digitaxConfig;
    try {
      const response = await axios.get(`${config.baseUrl}/customers`, {
        ...digitaxRequest(config),
        params: {
          before: req.query.before,
          after: req.query.after,
          page_size: req.query.page_size,
        },
      });

      router.post("/suppliers", async (req, res) => {
        const config = req.digitaxConfig;
        const payload = mapSupplierToDigitax(req.body || {});

        if (!payload.supplier_name || !payload.supplier_tin) {
          return res.status(400).json({
            success: false,
            business: config.businessCode,
            error: "Supplier name and KRA PIN are required to register a DigiTax supplier.",
          });
        }

        try {
          const response = await axios.post(`${config.baseUrl}/suppliers`, payload, digitaxRequest(config));
          return res.status(response.status || 201).json({
            success: true,
            business: config.businessCode,
            supplier: response.data?.data || response.data,
            digitaxPayload: response.data,
          });
        } catch (error) {
          console.error(`DigiTax supplier error [${config.businessCode}]`, getErrorPayload(error));
          return res.status(error.status || error.response?.status || 400).json({
            success: false,
            business: config.businessCode,
            error: getErrorPayload(error),
            digitaxPayloadSent: payload,
          });
        }
      });

      router.put("/suppliers/:supplierId", async (req, res) => {
        const config = req.digitaxConfig;
        const payload = mapSupplierToDigitax(req.body || {});

        if (!req.params.supplierId || !payload.supplier_name || !payload.supplier_tin) {
          return res.status(400).json({
            success: false,
            business: config.businessCode,
            error: "Supplier ID, name and KRA PIN are required to update a DigiTax supplier.",
          });
        }

        try {
          const response = await axios.put(
            `${config.baseUrl}/suppliers/${encodeURIComponent(req.params.supplierId)}`,
            payload,
            digitaxRequest(config)
          );
          return res.status(response.status || 200).json({
            success: true,
            business: config.businessCode,
            supplier: response.data?.data || response.data,
            digitaxPayload: response.data,
          });
        } catch (error) {
          console.error(`DigiTax supplier update error [${config.businessCode}]`, getErrorPayload(error));
          return res.status(error.status || error.response?.status || 400).json({
            success: false,
            business: config.businessCode,
            error: getErrorPayload(error),
            digitaxPayloadSent: payload,
          });
        }
      });

      router.put("/crops/:cropId", async (req, res) => {
        const config = req.digitaxConfig;
        const payload = mapItemToDigitax(req.body || {});

        if (!req.params.cropId || !payload.item_name) {
          return res.status(400).json({
            success: false,
            business: config.businessCode,
            error: "Crop ID and name are required to update a DigiTax item.",
          });
        }

        try {
          const response = await axios.put(
            `${config.baseUrl}/items/${encodeURIComponent(req.params.cropId)}`,
            { item_name: payload.item_name, default_unit_price: payload.default_unit_price, tax_type_code: payload.tax_type_code },
            digitaxRequest(config)
          );
          return res.status(response.status || 200).json({
            success: true,
            business: config.businessCode,
            item: response.data?.data || response.data,
            digitaxPayload: response.data,
          });
        } catch (error) {
          console.error(`DigiTax crop update error [${config.businessCode}]`, getErrorPayload(error));
          return res.status(error.status || error.response?.status || 400).json({
            success: false,
            business: config.businessCode,
            error: getErrorPayload(error),
            digitaxPayloadSent: payload,
          });
        }
      });

      router.put("/items/:itemId", async (req, res) => {
        const config = req.digitaxConfig;
        const payload = mapItemToDigitax(req.body || {});
        if (!req.params.itemId || !payload.item_name) {
          return res.status(400).json({ success: false, business: config.businessCode, error: "Item ID and name are required to update a DigiTax item." });
        }
        try {
          const response = await axios.put(
            `${config.baseUrl}/items/${encodeURIComponent(req.params.itemId)}`,
            { item_name: payload.item_name, default_unit_price: payload.default_unit_price, tax_type_code: payload.tax_type_code },
            digitaxRequest(config)
          );
          return res.status(response.status || 200).json({ success: true, business: config.businessCode, item: response.data?.data || response.data, digitaxPayload: response.data });
        } catch (error) {
          console.error(`DigiTax item update error [${config.businessCode}]`, getErrorPayload(error));
          return res.status(error.status || error.response?.status || 400).json({ success: false, business: config.businessCode, error: getErrorPayload(error), digitaxPayloadSent: payload });
        }
      });
      return res.json({ success: true, business: config.businessCode, data: response.data });
    } catch (error) {
      console.error(`DigiTax customers error [${config.businessCode}]`, getErrorPayload(error));
      return res.status(error.status || error.response?.status || 400).json({
        success: false,
        business: config.businessCode,
        error: getErrorPayload(error),
      });
    }
  });

  router.post("/create-invoice", async (req, res) => {
    const config = req.digitaxConfig;
    const { invoiceNo, buyer = {}, items = [], paymentType } = req.body || {};

    if (!invoiceNo || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        business: config.businessCode,
        error: "invoiceNo and at least one item are required",
      });
    }

    let payload;
    try {
      payload = {
        sale_date: new Date().toISOString().slice(0, 10),
        customer_tin: buyer.pin || undefined,
        customer_name: buyer.name || undefined,
        customer_id: req.body.customerId || buyer.digitaxCustomerId || buyer.customerId || undefined,
        trader_invoice_number: String(invoiceNo),
        payment_type_code: String(paymentType || "01"),
        invoice_status_code: String(req.body.invoiceStatusCode || "01"),
        is_tax_exempt: req.body.isTaxExempt ?? true,
        items: items.map((item) => {
          const id = item.digitaxItemId || item.itemId || item.id;
          const quantity = Number(item.quantity ?? item.qty ?? 0);
          const unitPrice = Number(item.sellingPrice ?? item.unitPrice ?? item.price ?? 0);
          const discountAmount = Number(item.discountAmount || 0);

          if (!id) {
            throw new Error(`Item "${item.name || "unknown"}" has no Digitax item ID`);
          }

          return {
            id: String(id),
            quantity,
            unit_price: unitPrice,
            total_amount: quantity * unitPrice - discountAmount,
            package_unit_quantity: Number(item.packageUnitQuantity || 1),
            discount_rate: Number(item.discountRate || 0),
            discount_amount: discountAmount,
            item_description: item.name || item.itemName || undefined,
          };
        }),
      };
      const response = await axios.post(`${config.baseUrl}/sales`, payload, digitaxRequest(config));
      return res.status(response.status || 201).json(await mapSaleResponse(response.data, config, payload));
    } catch (error) {
      console.error(`DigiTax sale error [${config.businessCode}]`, getErrorPayload(error));
      return res.status(error.status || error.response?.status || 400).json({
        success: false,
        business: config.businessCode,
        error: getErrorPayload(error),
        kraPayload: payload,
        digitaxPayloadSent: payload,
      });
    }
  });

  router.get("/purchases", async (req, res) => {
    const config = req.digitaxConfig;
    try {
      const response = await axios.get(`${config.baseUrl}/purchases`, {
        ...digitaxRequest(config),
        params: {
          before: req.query.before,
          after: req.query.after,
          page_size: req.query.page_size,
        },
      });
      return res.json({ success: true, business: config.businessCode, data: response.data });
    } catch (error) {
      console.error(`DigiTax purchases error [${config.businessCode}]`, getErrorPayload(error));
      return res.status(error.status || error.response?.status || 400).json({
        success: false,
        business: config.businessCode,
        error: getErrorPayload(error),
      });
    }
  });

  /*
  router.post("/reverse-invoice", async (req, res) => {
    const config = req.digitaxConfig;
    const {
      supplierId,
      supplier_id: supplierIdFromPayload,
      saleDate,
      sale_date: saleDateFromPayload,
      invoiceNo,
      trader_invoice_number: invoiceNoFromPayload,
      items = [],
      paymentType,
      payment_type_code: paymentTypeFromPayload,
      invoiceDetails,
    } = req.body || {};
    const resolvedSupplierId = supplierId || supplierIdFromPayload;
    const resolvedInvoiceNo = invoiceNo || invoiceNoFromPayload;
    const resolvedSaleDate = saleDate || saleDateFromPayload || new Date().toISOString().slice(0, 10);

    if (!resolvedSupplierId || !resolvedInvoiceNo || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        business: config.businessCode,
        error: "supplierId, invoiceNo and at least one item are required",
      });
    }

    let payload;
    try {
      payload = {
        supplier_id: String(resolvedSupplierId),
        sale_date: String(resolvedSaleDate),
        customer_tin: req.body.customerTin || undefined,
        customer_name: req.body.customerName || undefined,
        customer_phone: req.body.customerPhone || undefined,
        customer_email: req.body.customerEmail || undefined,
        payment_type_code: String(paymentType || paymentTypeFromPayload || "07"),
        invoice_details: invoiceDetails || undefined,
        trader_invoice_number: String(resolvedInvoiceNo),
        callback_url: req.body.callbackUrl || undefined,
        items: items.map((item) => {
          const id = item.id || item.digitaxItemId || item.itemId;
          const quantity = Number(item.quantity ?? item.qty ?? 0);
          const unitPrice = Number(item.unit_price ?? item.unitPrice ?? item.price ?? item.sellingPrice ?? 0);
          const discountRate = Number(item.discount_rate ?? item.discountRate ?? 0);
          const discountAmount = Number(item.discount_amount ?? item.discountAmount ?? 0);

          if (!id || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
            throw new Error(`Each reverse invoice item needs a valid DigiTax item ID, quantity and unit price`);
          }

          return {
            id: String(id),
            quantity,
            unit_price: unitPrice,
            total_amount: Number(item.total_amount ?? (quantity * unitPrice - discountAmount)),
            package_unit_quantity: Number(item.package_unit_quantity ?? item.packageUnitQuantity ?? 1),
            discount_rate: discountRate,
            discount_amount: discountAmount,
            item_name: item.item_name || item.itemName || item.name || undefined,
            item_class_code: item.item_class_code || item.itemClassCode || undefined,
            item_bar_code: item.item_bar_code || item.itemBarCode || undefined,
            item_tax_type_code: item.item_tax_type_code || item.taxTypeCode || undefined,
            item_description: item.item_description || item.itemDescription || item.name || undefined,
          };
        }),
      };

      const response = await axios.post(
        `${config.baseUrl}/reverse-invoices`,
        payload,
        digitaxRequest(config)
      );
      return res.status(response.status || 201).json({
        success: true,
        business: config.businessCode,
        data: response.data?.data || response.data,
        digitaxPayload: response.data,
        digitaxPayloadSent: payload,
      });
    } catch (error) {
      console.error(`DigiTax reverse invoice error [${config.businessCode}]`, getErrorPayload(error));
      return res.status(error.status || error.response?.status || 400).json({
        success: false,
        business: config.businessCode,
        error: getErrorPayload(error),
        digitaxPayloadSent: payload,
      });
    }
  });
  */

  return router;
}

app.use("/:businessCode/api/etims", createDigitaxRouter());
app.use("/api/etims", createDigitaxRouter());
app.use("/:businessCode/api/mpesa", buildMpesaRouter());
app.use("/api/mpesa", buildMpesaRouter());

if (require.main === module) {
  app.listen(process.env.PORT || 3000);
}

module.exports = app;
