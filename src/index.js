require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Client } = require("pg");
const Facturapi = require("facturapi").default;
const { DateTime } = require("luxon");
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));

const db = new Client({ connectionString: process.env.DATABASE_URL });
db.connect().then(() => console.log("[db] connected"));

function fp() {
  if (!process.env.FACTURAPI_KEY) throw new Error("Missing FACTURAPI_KEY");
  return new Facturapi(process.env.FACTURAPI_KEY);
}

/**
 * Lookup por:
 *   date (YYYY-MM-DD, UTC) + numcheque
 * Devuelve lista (por si hay repetidos)
 */
app.get("/api/orders/lookup", async (req, res) => {
  const date = String(req.query.date || "");
  const numcheque = String(req.query.numcheque || "");

  if (!date || !numcheque) {
    return res.status(400).json({ error: "date y numcheque son requeridos" });
  }

  const tz = process.env.RESTAURANT_TZ || "America/Mexico_City";

  // “date” viene como YYYY-MM-DD y lo interpretamos como fecha LOCAL del restaurante
  const startUtc = DateTime.fromISO(date, { zone: tz }).startOf("day").toUTC();
  const endUtc = startUtc.plus({ days: 1 });

  const start = startUtc.toISO();
  const end = endUtc.toISO();

  const q = `
    select id, folio, numcheque, mesa, fecha, cierre, total, subtotal, totalimpuesto1
    from public.orders
    where numcheque = $1
      and fecha >= $2
      and fecha < $3
    order by fecha desc
    limit 20
  `;
  const r = await db.query(q, [numcheque, start, end]);
  return res.json({ count: r.rows.length, orders: r.rows });
});

/**
 * Generar factura:
 * body: { orderId, customer:{ legalName, taxId, email, address:{ zip } }, cfdiUse, paymentForm }
 */
app.post("/api/invoices", async (req, res) => {
  const { orderId, customer, cfdiUse, paymentForm } = req.body || {};

  if (
    !orderId ||
    !customer?.taxId ||
    !customer?.legalName ||
    !customer?.taxSystem
  ) {
    return res.status(400).json({
      error: "Faltan campos requeridos (incluye régimen fiscal / taxSystem)",
    });
  }
  if (String(customer.taxSystem).length !== 3) {
    return res
      .status(400)
      .json({ error: "taxSystem debe ser de 3 caracteres (ej: 601)" });
  }

  const ord = await db.query(
    `select * from public.orders where id=$1 limit 1`,
    [orderId]
  );
  if (!ord.rows.length)
    return res.status(404).json({ error: "Order no encontrado" });
  const order = ord.rows[0];

  // ya facturada?
  const ex = await db.query(
    `select * from public.invoices where order_id=$1 limit 1`,
    [orderId]
  );
  if (ex.rows.length) {
    return res.json({
      ok: true,
      invoiceId: ex.rows[0].id,
      pdfUrl: `/api/invoices/${ex.rows[0].id}/pdf`,
      zipUrl: `/api/invoices/${ex.rows[0].id}/zip`,
    });
  }

  const facturapi = fp();

  const createdCustomer = await facturapi.customers.create({
    legal_name: customer.legalName,
    tax_id: customer.taxId,
    tax_system: String(customer.taxSystem), // régimen fiscal (3 chars)
    email: customer.email,
    address: customer.address,
  });

  const total = Number(order.total || 0);

  const invoice = await facturapi.invoices.create({
    customer: createdCustomer.id,
    payment_form: paymentForm || "03",
    use: cfdiUse || "G03",
    items: [
      {
        quantity: 1,
        product: {
          product_key: "90101501",
          description: `Consumo restaurante - numcheque ${order.numcheque}`,
          price: total,
        },
      },
    ],
  });

  const ins = await db.query(
    `insert into public.invoices (order_id, facturapi_invoice_id) values ($1,$2) returning id`,
    [orderId, invoice.id]
  );

  return res.json({
    ok: true,
    invoiceId: ins.rows[0].id,
    pdfUrl: `/api/invoices/${ins.rows[0].id}/pdf`,
    zipUrl: `/api/invoices/${ins.rows[0].id}/zip`,
  });
});

// POST /api/invoices/:id/send-email
app.post("/api/invoices/:id/send-email", async (req, res) => {
  const id = Number(req.params.id);

  const r = await db.query(
    `select * from public.invoices where id=$1 limit 1`,
    [id]
  );
  if (!r.rows.length)
    return res.status(404).json({ error: "Invoice no encontrada" });

  const facturapiInvoiceId = r.rows[0].facturapi_invoice_id;

  const facturapi = fp();
  await facturapi.invoices.sendByEmail(facturapiInvoiceId); // :contentReference[oaicite:2]{index=2}

  return res.json({ ok: true });
});

// GET /api/invoices/:id/zip  (PDF+XML en ZIP)
app.get("/api/invoices/:id/zip", async (req, res) => {
  const id = Number(req.params.id);

  const r = await db.query(
    `select * from public.invoices where id=$1 limit 1`,
    [id]
  );
  if (!r.rows.length)
    return res.status(404).json({ error: "Invoice no encontrada" });

  const facturapiInvoiceId = r.rows[0].facturapi_invoice_id;

  const facturapi = fp();
  const zipStream = await facturapi.invoices.downloadZip(facturapiInvoiceId); // :contentReference[oaicite:3]{index=3}

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="factura_${id}.zip"`
  );
  zipStream.pipe(res);
});

/**
 * PDF stream
 */
app.get("/api/invoices/:id/pdf", async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.query(
    `select * from public.invoices where id=$1 limit 1`,
    [id]
  );
  if (!r.rows.length)
    return res.status(404).json({ error: "Invoice no encontrada" });

  const facturapi = fp();
  const pdfStream = await facturapi.invoices.downloadPdf(
    r.rows[0].facturapi_invoice_id
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="factura_${id}.pdf"`);
  pdfStream.pipe(res);
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(Number(process.env.PORT || 3000), () => {
  console.log(`[api] listening on :${process.env.PORT || 3000}`);
});
