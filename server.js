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

const { ODOO_URL, DB, USER, PASS, SHOPIFY_STORE_URL, SHOPIFY_LOCATION_ID } = process.env;

// ─────────────────────────────────────────
// FUNCIONES DE APOYO
// ─────────────────────────────────────────

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
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Math.random()
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function getShopifyToken() {
  const authResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET
    })
  });
  const data = await authResponse.json();
  if (!data.access_token) {
    throw new Error("No se pudo obtener token de Shopify. Revisa SHOPIFY_CLIENT_ID y SHOPIFY_CLIENT_SECRET.");
  }
  return data.access_token;
}

// Obtiene TODAS las variantes de Shopify con barcode e inventoryItemId
// Maneja paginación automática con cursores
async function getAllShopifyVariants(token) {
  const variants = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const query = `{
      productVariants(first: 100${afterClause}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            barcode
            inventoryItem { id }
          }
        }
      }
    }`;

    const response = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2024-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({ query })
    });

    const result = await response.json();
    const page = result.data?.productVariants;

    for (const edge of page?.edges || []) {
      const node = edge.node;
      if (node.barcode && node.inventoryItem?.id) {
        variants.push({
          barcode: node.barcode.trim(),
          inventoryItemId: node.inventoryItem.id.split("/").pop()
        });
      }
    }

    hasNextPage = page?.pageInfo?.hasNextPage || false;
    cursor = page?.pageInfo?.endCursor || null;
  }

  return variants;
}

// Actualiza el nivel de inventario en Shopify para un inventoryItemId dado
async function setShopifyInventory(token, inventoryItemId, qty) {
  const response = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2024-01/inventory_levels/set.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      location_id: SHOPIFY_LOCATION_ID,
      inventory_item_id: inventoryItemId,
      available: qty
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Shopify inventory set failed: ${err}`);
  }
}

// Obtiene el barcode de una variante de Shopify a partir de su variant_id (REST)
async function getBarcodeFromVariantId(token, variantId) {
  const response = await fetch(
    `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/variants/${variantId}.json`,
    {
      headers: { "X-Shopify-Access-Token": token }
    }
  );
  const data = await response.json();
  return data.variant?.barcode || null;
}

// ─────────────────────────────────────────
// SINCRONIZACIÓN MASIVA CADA 2 MINUTOS
// ─────────────────────────────────────────

async function syncAllStock() {
  console.log("🔄 [SYNC] Iniciando barrido de inventario...");
  const start = Date.now();

  try {
    // Obtener token de Shopify y sesión de Odoo en paralelo
    const [token, uid] = await Promise.all([
      getShopifyToken(),
      odooCall("common", "login", [DB, USER, PASS])
    ]);

    // 1. Traer todas las variantes de Shopify (con paginación automática)
    const variants = await getAllShopifyVariants(token);
    console.log(`📋 [SYNC] ${variants.length} variantes con barcode encontradas en Shopify.`);

    if (variants.length === 0) {
      console.log("⚠️  [SYNC] No hay variantes con barcode. Verifica que tus productos en Shopify tengan código de barras.");
      return;
    }

    // 2. Consultar stock en Odoo para todos los barcodes en una sola llamada
    const barcodes = variants.map(v => v.barcode);
    const odooProducts = await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "product.product", "search_read",
      [[["barcode", "in", barcodes]]],
      { fields: ["barcode", "virtual_available"] }
    ]);

    // Convertir a mapa barcode -> stock para búsqueda O(1)
    const stockMap = {};
    for (const p of odooProducts) {
      if (p.barcode) {
        stockMap[p.barcode.trim()] = p.virtual_available || 0;
      }
    }

    console.log(`📦 [SYNC] ${odooProducts.length} productos encontrados en Odoo de ${variants.length} barcodes buscados.`);

    // 3. Actualizar cada variante en Shopify
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const variant of variants) {
      const rawStock = stockMap[variant.barcode];

      if (rawStock === undefined) {
        // Barcode no existe en Odoo — no tocar el inventario
        skipped++;
        continue;
      }

      // Restar 2 de seguridad y nunca enviar negativo
      const finalQty = Math.max(0, Math.floor(rawStock) - 2);

      try {
        await setShopifyInventory(token, variant.inventoryItemId, finalQty);
        console.log(`  ✅ ${variant.barcode}: ${rawStock} en Odoo → ${finalQty} en Shopify`);
        updated++;
      } catch (err) {
        console.error(`  ❌ Error actualizando ${variant.barcode}:`, err.message);
        errors++;
      }

      // Pausa de 150ms entre llamadas para respetar el rate limit de Shopify
      await new Promise(r => setTimeout(r, 150));
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✔️  [SYNC] Completado en ${elapsed}s | Actualizados: ${updated} | Sin barcode en Odoo: ${skipped} | Errores: ${errors}`);

  } catch (error) {
    console.error("❌ [SYNC] Error durante el barrido:", error);
  }
}

// Ejecutar inmediatamente al arrancar y luego cada 2 minutos
syncAllStock();
setInterval(syncAllStock, 2 * 60 * 1000);

// ─────────────────────────────────────────
// RUTAS (ENDPOINTS)
// ─────────────────────────────────────────

// Webhook de Shopify → crea la venta en Odoo
app.post("/shopify-webhook", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) return res.status(401).send("Invalid signature");

    const order = req.body;
    const uid = await odooCall("common", "login", [DB, USER, PASS]);

    // Obtener token para poder consultar barcodes si vienen vacíos
    const token = await getShopifyToken();

    // Buscar o crear cliente en Odoo
    let partners = await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "res.partner", "search_read",
      [[["email", "=", order.email]]],
      { limit: 1 }
    ]);

    let partner_id = partners.length > 0
      ? partners[0].id
      : await odooCall("object", "execute_kw", [
          DB, uid, PASS,
          "res.partner", "create",
          [{
            name: `${order.customer.first_name} ${order.customer.last_name}`,
            email: order.email
          }]
        ]);

    // Construir líneas de orden usando barcode
    const order_lines = [];

    for (const item of order.line_items) {
      // Intentar obtener barcode directo del item
      let barcode = item.barcode?.trim() || null;

      // Fallback: consultar la variante por variant_id si el barcode viene vacío
      if (!barcode && item.variant_id) {
        console.log(`🔍 barcode vacío en item "${item.title}", consultando variante ${item.variant_id}...`);
        barcode = await getBarcodeFromVariantId(token, item.variant_id);
      }

      if (!barcode) {
        console.warn(`⚠️  No se encontró barcode para "${item.title}" (variant_id: ${item.variant_id}). Saltando línea.`);
        continue;
      }

      // Buscar producto en Odoo por barcode
      const products = await odooCall("object", "execute_kw", [
        DB, uid, PASS,
        "product.product", "search_read",
        [[["barcode", "=", barcode]]],
        { limit: 1 }
      ]);

      if (products.length > 0) {
        order_lines.push([0, 0, {
          product_id: products[0].id,
          product_uom_qty: item.quantity,
          price_unit: parseFloat(item.price),
          name: item.title
        }]);
      } else {
        console.warn(`⚠️  Producto con barcode ${barcode} no encontrado en Odoo. Saltando línea.`);
      }
    }

    if (order_lines.length > 0) {
      const sale_id = await odooCall("object", "execute_kw", [
        DB, uid, PASS,
        "sale.order", "create",
        [{
          partner_id,
          client_order_ref: order.name,
          order_line: order_lines
        }]
      ]);
      await odooCall("object", "execute_kw", [DB, uid, PASS, "sale.order", "action_confirm", [[sale_id]]]);
      console.log(`🛒 Venta creada y confirmada en Odoo: ${order.name}`);
    } else {
      console.warn(`⚠️  Orden ${order.name} no generó líneas válidas en Odoo.`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error procesando orden:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint manual para forzar sincronización inmediata (útil para pruebas)
app.post("/sync-now", async (req, res) => {
  res.json({ message: "Sincronización iniciada en background." });
  syncAllStock();
});

// ─────────────────────────────────────────
// ARRANCAR SERVIDOR
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});