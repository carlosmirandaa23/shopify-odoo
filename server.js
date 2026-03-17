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

// Devuelve el objeto completo de la variante: { barcode, sku, ... }
async function getVariantData(token, variantId) {
  const response = await fetch(
    `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/variants/${variantId}.json`,
    { headers: { "X-Shopify-Access-Token": token } }
  );
  const data = await response.json();
  return data.variant || {};
}

// Obtiene TODAS las variantes de Shopify con barcode, sku e inventoryItemId
// Incluye variantes aunque no tengan barcode (el SKU sirve de fallback)
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
            sku
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
      // Solo excluir si no tiene inventoryItemId — barcode y sku son opcionales
      if (node.inventoryItem?.id) {
        variants.push({
          barcode: node.barcode?.trim() || null,
          sku: node.sku?.trim() || null,
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

// Busca un producto en Odoo con cadena de fallback:
// 1. barcode del payload
// 2. barcode consultando la variante en Shopify
// 3. SKU del payload contra default_code
// 4. SKU consultando la variante en Shopify contra default_code
async function findOdooProduct(uid, token, item) {
  let variantCache = null;

  const fetchVariant = async () => {
    if (!variantCache && item.variant_id) {
      variantCache = await getVariantData(token, item.variant_id);
    }
    return variantCache || {};
  };

  // ── Intento 1: barcode directo del payload ──
  const barcodeFromPayload = item.barcode?.trim();
  if (barcodeFromPayload) {
    const found = await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "product.product", "search_read",
      [[["barcode", "=", barcodeFromPayload]]],
      { limit: 1 }
    ]);
    if (found.length > 0) {
      console.log(`  🔖 "${item.title}" encontrado por barcode del payload: ${barcodeFromPayload}`);
      return found[0];
    }
  }

  // ── Intento 2: barcode consultando la variante en Shopify ──
  const variant = await fetchVariant();
  const barcodeFromVariant = variant.barcode?.trim();
  if (barcodeFromVariant && barcodeFromVariant !== barcodeFromPayload) {
    const found = await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "product.product", "search_read",
      [[["barcode", "=", barcodeFromVariant]]],
      { limit: 1 }
    ]);
    if (found.length > 0) {
      console.log(`  🔖 "${item.title}" encontrado por barcode de variante: ${barcodeFromVariant}`);
      return found[0];
    }
  }

  // ── Intento 3: SKU del payload contra default_code ──
  const skuFromPayload = item.sku?.trim();
  if (skuFromPayload) {
    const found = await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "product.product", "search_read",
      [[["default_code", "=", skuFromPayload]]],
      { limit: 1 }
    ]);
    if (found.length > 0) {
      console.log(`  🔖 "${item.title}" encontrado por SKU del payload en default_code: ${skuFromPayload}`);
      return found[0];
    }
  }

  // ── Intento 4: SKU de la variante en Shopify contra default_code ──
  const skuFromVariant = variant.sku?.trim();
  if (skuFromVariant && skuFromVariant !== skuFromPayload) {
    const found = await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "product.product", "search_read",
      [[["default_code", "=", skuFromVariant]]],
      { limit: 1 }
    ]);
    if (found.length > 0) {
      console.log(`  🔖 "${item.title}" encontrado por SKU de variante en default_code: ${skuFromVariant}`);
      return found[0];
    }
  }

  // ── Sin resultado ──
  console.warn(`  ⚠️  No se encontró "${item.title}" en Odoo por ningún método (barcode payload: ${barcodeFromPayload || "—"}, barcode variante: ${barcodeFromVariant || "—"}, SKU payload: ${skuFromPayload || "—"}, SKU variante: ${skuFromVariant || "—"})`);
  return null;
}

// ─────────────────────────────────────────
// SINCRONIZACIÓN MASIVA CADA 2 MINUTOS
// ─────────────────────────────────────────

async function syncAllStock() {
  console.log("🔄 [SYNC] Iniciando barrido de inventario...");
  const start = Date.now();

  try {
    const [token, uid] = await Promise.all([
      getShopifyToken(),
      odooCall("common", "login", [DB, USER, PASS])
    ]);

    // 1. Traer todas las variantes de Shopify (barcode + sku + inventoryItemId)
    const variants = await getAllShopifyVariants(token);
    console.log(`📋 [SYNC] ${variants.length} variantes encontradas en Shopify.`);

    if (variants.length === 0) {
      console.log("⚠️  [SYNC] No se encontraron variantes.");
      return;
    }

    // 2. Consultar Odoo por barcodes Y por skus en paralelo — dos mapas
    const barcodes = variants.map(v => v.barcode).filter(Boolean);
    const skus     = variants.map(v => v.sku).filter(Boolean);

    const [byBarcode, bySku] = await Promise.all([
      barcodes.length > 0
        ? odooCall("object", "execute_kw", [DB, uid, PASS,
            "product.product", "search_read",
            [[["barcode", "in", barcodes]]],
            { fields: ["barcode", "virtual_available"] }])
        : [],
      skus.length > 0
        ? odooCall("object", "execute_kw", [DB, uid, PASS,
            "product.product", "search_read",
            [[["default_code", "in", skus]]],
            { fields: ["default_code", "virtual_available"] }])
        : []
    ]);

    // Mapa barcode -> stock
    const barcodeMap = {};
    for (const p of byBarcode) {
      if (p.barcode) barcodeMap[p.barcode.trim()] = p.virtual_available || 0;
    }

    // Mapa sku/default_code -> stock
    const skuMap = {};
    for (const p of bySku) {
      if (p.default_code) skuMap[p.default_code.trim()] = p.virtual_available || 0;
    }

    console.log(`📦 [SYNC] Odoo respondió: ${byBarcode.length} por barcode, ${bySku.length} por SKU.`);

    // 3. Actualizar cada variante en Shopify
    let updated = 0;
    let skipped = 0;
    let errors  = 0;

    for (const variant of variants) {
      // Buscar primero por barcode, luego por SKU como fallback
      let rawStock = undefined;
      let matchedBy = "";

      if (variant.barcode && barcodeMap[variant.barcode] !== undefined) {
        rawStock  = barcodeMap[variant.barcode];
        matchedBy = `barcode:${variant.barcode}`;
      } else if (variant.sku && skuMap[variant.sku] !== undefined) {
        rawStock  = skuMap[variant.sku];
        matchedBy = `sku:${variant.sku}`;
      }

      if (rawStock === undefined) {
        skipped++;
        continue;
      }

      // Restar 2 de seguridad y nunca enviar negativo
      const finalQty = Math.max(0, Math.floor(rawStock) - 2);

      try {
        await setShopifyInventory(token, variant.inventoryItemId, finalQty);
        console.log(`  ✅ [${matchedBy}] ${rawStock} en Odoo → ${finalQty} en Shopify`);
        updated++;
      } catch (err) {
        console.error(`  ❌ Error actualizando [${matchedBy}]:`, err.message);
        errors++;
      }

      // Pausa de 150ms para respetar el rate limit de Shopify
      await new Promise(r => setTimeout(r, 150));
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✔️  [SYNC] Completado en ${elapsed}s | Actualizados: ${updated} | Sin match en Odoo: ${skipped} | Errores: ${errors}`);

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

    // Construir líneas de orden con cadena de fallback completa
    const order_lines = [];

    for (const item of order.line_items) {
      const odooProduct = await findOdooProduct(uid, token, item);
      if (!odooProduct) continue;

      order_lines.push([0, 0, {
        product_id: odooProduct.id,
        product_uom_qty: item.quantity,
        price_unit: parseFloat(item.price),
        name: item.title
      }]);
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

// Endpoint manual para forzar sincronización inmediata
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