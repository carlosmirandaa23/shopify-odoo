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

// Variables de Entorno
const { ODOO_URL, DB, USER, PASS, SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN, SHOPIFY_LOCATION_ID } = process.env;

// --- FUNCIONES DE APOYO ---

function verifyShopifyWebhook(req) {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const digest = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

async function odooCall(service, method, args) {
  const response = await fetch(ODOO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Math.random() })
  });
  const data = await response.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

// --- RUTAS (ENDPOINTS) ---

// Webhook de Shopify (Cuando entra una orden)
app.post("/shopify-webhook", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) return res.status(401).send("Invalid signature");

    const order = req.body;
    const uid = await odooCall("common", "login", [DB, USER, PASS]);
    
    // Buscar o crear cliente
    let partners = await odooCall("object", "execute_kw", [DB, uid, PASS, "res.partner", "search_read", [[["email", "=", order.email]]], { limit: 1 }]);
    let partner_id = partners.length > 0 ? partners[0].id : await odooCall("object", "execute_kw", [DB, uid, PASS, "res.partner", "create", [{ name: `${order.customer.first_name} ${order.customer.last_name}`, email: order.email }]]);

    // Líneas de orden
    const order_lines = [];
    for (const item of order.line_items) {
      const products = await odooCall("object", "execute_kw", [DB, uid, PASS, "product.product", "search_read", [[["default_code", "=", item.sku]]], { limit: 1 }]);
      if (products.length > 0) {
        order_lines.push([0, 0, { product_id: products[0].id, product_uom_qty: item.quantity, price_unit: parseFloat(item.price), name: item.title }]);
      }
    }

    if (order_lines.length > 0) {
      const sale_id = await odooCall("object", "execute_kw", [DB, uid, PASS, "sale.order", "create", [{ partner_id, client_order_ref: order.name, order_line: order_lines }]]);
      await odooCall("object", "execute_kw", [DB, uid, PASS, "sale.order", "action_confirm", [[sale_id]]]);
      console.log(`🛒 Venta creada y confirmada en Odoo: ${order.name}`);
    }

    res.json({ success: true });
  } catch (error) {up
    console.error("❌ Error procesando orden:", error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook de Odoo (Cuando cambia el stock)
app.post("/odoo-stock-webhook", async (req, res) => {
  try {
    const { product_id } = req.body;

    if (!product_id) return res.status(400).send("No product_id provided");

    console.log(`📡 Evento de Odoo para ID: ${product_id}. Consultando stock real...`);

    const uid = await odooCall("common", "login", [DB, USER, PASS]);

    // 1. Consultamos el SKU Y el stock actualizado directamente de la DB de Odoo
    // 'qty_available' es el stock físico real. 
    // 'virtual_available' es el stock proyectado (físico - reservado).
    const products = await odooCall("object", "execute_kw", [
      DB, uid, PASS, 
      "product.product", "read", 
      [[product_id]], 
      { fields: ["default_code", "virtual_available"] } 
    ]);

    const product = products[0];
    const sku = product?.default_code?.trim();
    
    // 2. Validación de seguridad para números negativos
    // Si Odoo dice -5, nosotros enviamos 0 a Shopify.
    let stockEnOdoo = product?.virtual_available || 0;
    const final_qty = Math.max(0, Math.floor(stockEnOdoo));

    if (sku) {
      console.log(`📦 Datos frescos de Odoo: SKU ${sku} | Stock: ${stockEnOdoo} -> Enviando a Shopify: ${final_qty}`);
      await updateShopifyStock(sku, final_qty);
    } else {
      console.log(`⚠️ El producto ${product_id} no tiene SKU.`);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error en la re-consulta a Odoo:", error);
    res.status(500).send("Error");
  }
});

// Función de actualización mejorada para SKUs complejos
async function updateShopifyStock(sku, qty) {
  try {
    // 1. Pedir el token usando las variables de entorno seguras
    const authResponse = await fetch(`https://${process.env.SHOPIFY_STORE_URL}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.SHOPIFY_CLIENT_ID, // <--- Variable de Render
        client_secret: process.env.SHOPIFY_CLIENT_SECRET // <--- Variable de Render
      })
    });

    const authData = await authResponse.json();
    const tempToken = authData.access_token;

    if (!tempToken) {
      console.error("❌ Error de autenticación: Revisa el Client ID y Secret en Render.");
      return;
    }

    // 2. Buscar la variante con el token obtenido
    const query = `{ productVariants(first: 1, query: "sku:\\"${sku}\\"") { edges { node { id inventoryItem { id } } } } }`;
    
    const response = await fetch(`https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": tempToken
      },
      body: JSON.stringify({ query })
    });

    const result = await response.json();
    const variant = result.data?.productVariants?.edges[0]?.node;

    if (variant) {
      const inventoryItemId = variant.inventoryItem.id.split('/').pop();
      
      // 3. Actualizar el nivel de inventario
      await fetch(`https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/inventory_levels/set.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": tempToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          location_id: process.env.SHOPIFY_LOCATION_ID,
          inventory_item_id: inventoryItemId,
          available: Math.floor(qty)
        })
      });
      console.log(`✅ Sincronización exitosa: ${sku} ahora tiene ${qty} unidades.`);
    } else {
      console.log(`⚠️ No se encontró el SKU ${sku} en Shopify.`);
    }
  } catch (error) {
    console.error("❌ Error crítico en el proceso:", error);
  }
}

// --- EL SERVIDOR SIEMPRE ESCUCHA AL FINAL ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});