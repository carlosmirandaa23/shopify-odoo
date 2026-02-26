require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

const ODOO_URL = process.env.ODOO_URL;
const DB = process.env.DB;
const USER = process.env.USER;
const PASS = process.env.PASS;

// Función genérica para llamar Odoo
async function odooCall(service, method, args) {
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
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

app.post("/shopify-webhook", async (req, res) => {
  try {
    const order = req.body;

    // 1️⃣ Login
    const uid = await odooCall("common", "login", [DB, USER, PASS]);

    // 2️⃣ Buscar cliente
    let partners = await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "res.partner", "search_read",
      [[["email", "=", order.email]]],
      { limit: 1 }
    ]);

    let partner_id;

    if (partners.length > 0) {
      partner_id = partners[0].id;
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

      if (products.length === 0) continue;

      order_lines.push([
        0, 0, {
          product_id: products[0].id,
          product_uom_qty: item.quantity,
          price_unit: parseFloat(item.price),
          name: item.title
        }
      ]);
    }

    if (order_lines.length === 0) {
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

    // 5️⃣ Confirmar venta
    await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "sale.order", "action_confirm",
      [[sale_id]]
    ]);

    res.json({ success: true, sale_id });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor corriendo");
});