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

async function updateShopifyStock(sku, qty) {
  try {
    // 1. Buscar variante por SKU (CORREGIDO)
    // Usamos variants/search.json que es el endpoint correcto para filtrar por SKU
    const response = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2024-01/variants/search.json?query=sku:${sku}`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
    });
    
    const data = await response.json();
    const variant = data.variants?.[0]; // Tomamos la primera coincidencia

    if (variant) {
      // 2. Actualizar stock (Se mantiene igual, pero ahora variant.inventory_item_id es seguro)
      await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2024-01/inventory_levels/set.json`, {
        method: "POST",
        headers: { 
          "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({
          location_id: SHOPIFY_LOCATION_ID,
          inventory_item_id: variant.inventory_item_id,
          available: Math.floor(qty)
        })
      });
      console.log(`✅ Shopify sincronizado (Master Odoo): ${sku} -> ${qty}`);
    } else {
      console.log(`⚠️ SKU ${sku} no encontrado en Shopify. Revisa que el SKU coincida exactamente.`);
    }
  } catch (error) {
    console.error("❌ Error actualizando Shopify:", error);
  }
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
    const { product_id, available_quantity, quantity } = req.body;
    const final_qty = quantity || available_quantity;

    console.log(`📡 Recibido de Odoo: ID Producto ${product_id} -> Cantidad ${final_qty}`);

    if (product_id) {
      const uid = await odooCall("common", "login", [DB, USER, PASS]);
      const products = await odooCall("object", "execute_kw", [DB, uid, PASS, "product.product", "read", 
        [[product_id]], { fields: ["default_code"] }
      ]);

      // Aplicamos .trim() para limpiar espacios accidentales
      const sku = products[0]?.default_code?.trim();

      if (sku) {
        console.log(`📦 SKU encontrado: |${sku}|. Sincronizando con Shopify...`);
        // Usamos await para asegurar que la función termine o lance error
        await updateShopifyStock(sku, final_qty);
      } else {
        console.log(`⚠️ El producto con ID ${product_id} no tiene una Referencia Interna (SKU).`);
      }
    }
    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error en webhook Odoo:", error);
    res.status(500).send("Error");
  }
});

// Función de actualización mejorada para SKUs complejos
async function updateShopifyStock(sku, qty) {
  try {
    // 1. Buscamos el Inventory Item usando el SKU codificado
    // encodeURIComponent convierte los "." y "-" en caracteres seguros para la URL
    const searchUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/inventory_items.json?sku=${encodeURIComponent(sku)}`;
    
    const response = await fetch(searchUrl, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
    });
    
    const data = await response.json();
    const inventoryItem = data.inventory_items?.[0];

    if (inventoryItem) {
      console.log(`🎯 Item encontrado en Shopify para SKU: ${sku} (ID: ${inventoryItem.id})`);

      // 2. Ajustamos el stock en la ubicación configurada
      const updateUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/inventory_levels/set.json`;
      const updateResponse = await fetch(updateUrl, {
        method: "POST",
        headers: { 
          "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({
          location_id: SHOPIFY_LOCATION_ID,
          inventory_item_id: inventoryItem.id,
          available: Math.floor(qty) // Shopify no acepta decimales en stock
        })
      });

      if (updateResponse.ok) {
        console.log(`✅ Shopify sincronizado con éxito: ${sku} -> ${qty}`);
      } else {
        const errorData = await updateResponse.json();
        console.error(`❌ Error al setear stock en Shopify:`, JSON.stringify(errorData));
      }
    } else {
      console.log(`⚠️ SKU ${sku} no encontrado en Shopify. Verifica que el campo SKU en la variante sea idéntico.`);
    }
  } catch (error) {
    console.error(`❌ Error técnico actualizando Shopify para SKU ${sku}:`, error);
  }
}

// --- EL SERVIDOR SIEMPRE ESCUCHA AL FINAL ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});