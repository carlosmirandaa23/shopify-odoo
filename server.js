const crypto = require("crypto");
require("dotenv").config();
const express = require("express");

const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

const ODOO_URL = process.env.ODOO_URL;
const DB = process.env.DB;
const USER = process.env.USER;
const PASS = process.env.PASS;

function verifyShopifyWebhook(req) {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");

  const valid = crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmac)
  );

  console.log("🔐 Webhook valid:", valid);
  return valid;
}

// Función genérica para llamar Odoo
async function odooCall(service, method, args) {
  console.log(`📡 Llamando a Odoo: ${service}.${method} con args:`, args);
  const response = await fetch(ODOO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Math.floor(Math.random() * 1000)
    })
  });

  const data = await response.json();
  if (data.error) {
    console.error("❌ Error Odoo:", data.error);
    throw new Error(JSON.stringify(data.error));
  }
  console.log("✅ Respuesta Odoo:", data.result);
  return data.result;
}

app.post("/shopify-webhook", async (req, res) => {
  try {
    console.log("=== Nuevo webhook recibido ===");
    console.log("Headers:", req.headers);
    console.log("Body:", JSON.stringify(req.body, null, 2));

    // ✅ Validación primero
    if (!verifyShopifyWebhook(req)) {
      console.log("❌ Webhook inválido");
      return res.status(401).send("Invalid webhook signature");
    }

    const order = req.body;
    console.log("🛒 Procesando orden:", order.name);

    // 1️⃣ Login
    const uid = await odooCall("common", "login", [DB, USER, PASS]);
    console.log("👤 UID de Odoo:", uid);

    // 2️⃣ Buscar cliente
    let partners = await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "res.partner", "search_read",
      [[["email", "=", order.email]]],
      { limit: 1 }
    ]);

    console.log("📇 Clientes encontrados:", partners.length);

    let partner_id;
    if (partners.length > 0) {
      partner_id = partners[0].id;
      console.log("✅ Cliente existente ID:", partner_id);
    } else {
      partner_id = await odooCall("object", "execute_kw", [
        DB, uid, PASS,
        "res.partner", "create",
        [{
          name: order.customer.first_name + " " + order.customer.last_name,
          email: order.email,
          phone: order.phone || ""
        }]
      ]);
      console.log("🆕 Cliente creado ID:", partner_id);
    }

    // 3️⃣ Construir líneas
    const order_lines = [];
    for (const item of order.line_items) {
      const products = await odooCall("object", "execute_kw", [
        DB, uid, PASS,
        "product.product", "search_read",
        [[["default_code", "=", item.sku]]],
        { limit: 1 }
      ]);

      if (products.length === 0) {
        console.log("⚠️ Producto no encontrado SKU:", item.sku);
        continue;
      }

      order_lines.push([
        0, 0, {
          product_id: products[0].id,
          product_uom_qty: item.quantity,
          price_unit: parseFloat(item.price),
          name: item.title
        }
      ]);
      console.log("➕ Línea agregada:", item.sku, item.quantity);
    }

    if (order_lines.length === 0) {
      console.log("❌ Ningún producto válido encontrado");
      return res.status(400).json({ error: "No valid products found" });
    }

    // 4️⃣ Crear venta
    const sale_id = await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "sale.order", "create",
      [{
        partner_id: partner_id,
        client_order_ref: order.name,
        order_line: order_lines
      }]
    ]);
    console.log("🛒 Venta creada ID:", sale_id);

    // 5️⃣ Confirmar venta
    await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "sale.order", "action_confirm",
      [[sale_id]]
    ]);
    console.log("✅ Venta confirmada ID:", sale_id);

    res.json({ success: true, sale_id });

  } catch (error) {
    console.error("❌ Error general:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor corriendo");
});

// --- Endpoint para recibir de Odoo ---
app.post("/odoo-stock-webhook", async (req, res) => {
  try {
    const { sku, new_qty } = req.body;
    console.log(`📦 Actualización de Odoo: SKU ${sku} -> Cantidad ${new_qty}`);

    if (sku && new_qty !== undefined) {
      await updateShopifyStock(sku, new_qty);
    }
    res.status(200).send("OK");
  } catch (error) {
    console.error("Error en webhook:", error);
    res.status(500).send("Error");
  }
});

// --- Función para actualizar Shopify ---
async function updateShopifyStock(sku, qty) {
  // Asegúrate de que estas variables estén en el panel de Render
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/products.json?sku=${sku}`,
    { headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN } }
  );
  const data = await response.json();
  const variant = data.products?.[0]?.variants.find(v => v.sku === sku);

  if (variant) {
    await fetch(
      `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/inventory_levels/set.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          location_id: process.env.SHOPIFY_LOCATION_ID,
          inventory_item_id: variant.inventory_item_id,
          available: Math.floor(qty)
        })
      }
    );
    console.log(`✅ Shopify sincronizado: ${sku}`);
  }
}