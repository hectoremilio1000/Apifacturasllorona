require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Client } = require("pg");
const Facturapi = require("facturapi").default;
const ftp = require("basic-ftp");

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
async function uploadInvoiceFilesToFtp({
  invoiceId,
  pdfStream,
  xmlStream,
  zipStream,
}) {
  const host = process.env.FTP_HOST;
  const user = process.env.FTP_USER;
  const password = process.env.FTP_PASS;
  const port = Number(process.env.FTP_PORT || 21);
  const secure = String(process.env.FTP_SECURE || "false") === "true";

  if (!host || !user || !password)
    throw new Error("Missing FTP env vars (FTP_HOST/FTP_USER/FTP_PASS)");

  const baseDir = process.env.FTP_BASE_DIR || "/facturasllorona";
  const mediaBase = process.env.MEDIA_BASE_URL || "";

  const remoteDir = `${baseDir}/${invoiceId}`;
  const pdfName = "invoice.pdf";
  const xmlName = "invoice.xml";
  const zipName = "invoice.zip";

  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({ host, user, password, port, secure });
    await client.ensureDir(remoteDir);
    await client.cd(remoteDir);

    // basic-ftp acepta streams en uploadFrom
    await client.uploadFrom(pdfStream, pdfName);
    await client.uploadFrom(xmlStream, xmlName);
    await client.uploadFrom(zipStream, zipName);

    const pdfUrl = mediaBase ? `${mediaBase}/${invoiceId}/${pdfName}` : null;
    const xmlUrl = mediaBase ? `${mediaBase}/${invoiceId}/${xmlName}` : null;
    const zipUrl = mediaBase ? `${mediaBase}/${invoiceId}/${zipName}` : null;

    return { pdfUrl, xmlUrl, zipUrl };
  } finally {
    client.close();
  }
}

function requireAdmin(req, res, next) {
  const token = req.header("x-admin-token");
  if (!process.env.ADMIN_TOKEN)
    return res.status(500).json({ error: "Missing ADMIN_TOKEN" });
  if (token !== process.env.ADMIN_TOKEN)
    return res.status(401).json({ error: "Unauthorized" });
  next();
}

// rutas admin
app.get("/api/admin/invoices", requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim(); // numcheque
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const sqlText = `
    select
      i.id as "invoiceId",
      i.order_id as "orderId",
      i.facturapi_invoice_id as "facturapiInvoiceId",
      i.created_at as "createdAt",
      i.emailed_at as "emailedAt",
      i.uploaded_at as "uploadedAt",
      i.media_pdf_url as "mediaPdfUrl",
      i.media_xml_url as "mediaXmlUrl",
      i.media_zip_url as "mediaZipUrl",
      o.folio,
      o.numcheque,
      o.fecha,
      o.total,
      c.id as "customerId",
      c.tax_id as "taxId",
      c.legal_name as "legalName",
      c.email
    from public.invoices i
    join public.orders o on o.id = i.order_id
    left join public.customers c on c.id = i.customer_id
    where ($1 = '' or o.numcheque ilike '%' || $1 || '%')
    order by i.id desc
    limit $2 offset $3
  `;
  const r = await db.query(sqlText, [q, limit, offset]);
  res.json({ rows: r.rows });
});
app.get("/api/admin/customers", requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const sqlText = `
    select id, tax_id as "taxId", legal_name as "legalName", tax_system as "taxSystem",
           email, zip, facturapi_customer_id as "facturapiCustomerId",
           created_at as "createdAt", updated_at as "updatedAt"
    from public.customers
    where ($1 = '' or tax_id ilike '%'||$1||'%' or legal_name ilike '%'||$1||'%' or email ilike '%'||$1||'%')
    order by id desc
    limit $2 offset $3
  `;
  const r = await db.query(sqlText, [q, limit, offset]);
  res.json({ rows: r.rows });
});

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
  select
    o.id, o.folio, o.numcheque, o.mesa, o.fecha, o.cierre, o.total, o.subtotal, o.totalimpuesto1,
    i.id as "invoiceId",
    i.emailed_at as "emailedAt"
  from public.orders o
  left join public.invoices i on i.order_id = o.id
  where o.numcheque = $1
    and o.fecha >= $2
    and o.fecha < $3
  order by o.fecha desc
  limit 20
`;
  const r = await db.query(q, [numcheque, start, end]);

  return res.json({ count: r.rows.length, orders: r.rows });
});

/**
 * Generar factura:
 * body: { orderId, customer:{ legalName, taxId, email, address:{ zip } }, cfdiUse, paymentForm }
 */
async function verifyRecaptcha(token) {
  if (String(process.env.RECAPTCHA_ENABLED || "false") !== "true") return true;

  if (!process.env.RECAPTCHA_SECRET)
    throw new Error("Missing RECAPTCHA_SECRET");
  if (!token) return false;

  const params = new URLSearchParams();
  params.append("secret", process.env.RECAPTCHA_SECRET);
  params.append("response", token);

  const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await resp.json();
  return !!data.success;
}

app.post("/api/invoices", async (req, res) => {
  const { orderId, customer, cfdiUse, paymentForm, recaptchaToken } =
    req.body || {};

  // 1) reCAPTCHA
  const okCaptcha = await verifyRecaptcha(recaptchaToken);
  if (!okCaptcha)
    return res
      .status(400)
      .json({ error: "reCAPTCHA inválido. Intenta de nuevo." });

  // 2) Validaciones (email obligatorio)
  if (
    !orderId ||
    !customer?.taxId ||
    !customer?.legalName ||
    !customer?.taxSystem ||
    !customer?.email
  ) {
    return res.status(400).json({
      error: "Faltan campos requeridos (incluye email y régimen fiscal)",
    });
  }
  if (String(customer.taxSystem).length !== 3) {
    return res
      .status(400)
      .json({ error: "taxSystem debe ser de 3 caracteres (ej: 601)" });
  }

  // 3) Order existe
  const ord = await db.query(
    `select * from public.orders where id=$1 limit 1`,
    [orderId]
  );
  if (!ord.rows.length)
    return res.status(404).json({ error: "Order no encontrado" });
  const order = ord.rows[0];

  // 4) ¿Ya facturada? -> NO permitir llenar datos, solo devolver PDF/ZIP
  const ex = await db.query(
    `select * from public.invoices where order_id=$1 limit 1`,
    [orderId]
  );
  if (ex.rows.length) {
    return res.json({
      ok: true,
      alreadyInvoiced: true,
      invoiceId: ex.rows[0].id,
      pdfUrl: `/api/invoices/${ex.rows[0].id}/pdf`,
      zipUrl: `/api/invoices/${ex.rows[0].id}/zip`,
    });
  }

  const facturapi = fp();

  // 5) Upsert customer en DB (buscar por tax_id)
  let customerRow = await db.query(
    `select * from public.customers where tax_id=$1 limit 1`,
    [String(customer.taxId)]
  );
  let localCustomer = customerRow.rows[0];

  // Si no existe, lo creamos en Facturapi + DB
  if (!localCustomer) {
    const created = await facturapi.customers.create({
      legal_name: customer.legalName,
      tax_id: customer.taxId,
      tax_system: String(customer.taxSystem),
      email: customer.email,
      address: customer.address, // mínimo { zip }
    });

    const ins = await db.query(
      `insert into public.customers (tax_id, legal_name, tax_system, email, zip, facturapi_customer_id)
       values ($1,$2,$3,$4,$5,$6)
       returning *`,
      [
        String(customer.taxId),
        String(customer.legalName),
        String(customer.taxSystem),
        String(customer.email),
        String(customer.address?.zip || ""),
        created.id,
      ]
    );
    localCustomer = ins.rows[0];
  } else {
    // existe: si no tiene facturapi_customer_id, créalo; si tiene, opcionalmente actualiza datos
    let facturapiCustomerId = localCustomer.facturapi_customer_id;

    if (!facturapiCustomerId) {
      const created = await facturapi.customers.create({
        legal_name: customer.legalName,
        tax_id: customer.taxId,
        tax_system: String(customer.taxSystem),
        email: customer.email,
        address: customer.address,
      });
      facturapiCustomerId = created.id;
    } else {
      // opcional: mantener datos actualizados en Facturapi
      await facturapi.customers.update(facturapiCustomerId, {
        legal_name: customer.legalName,
        tax_system: String(customer.taxSystem),
        email: customer.email,
        address: customer.address,
      });
    }

    // actualiza DB local customers
    const upd = await db.query(
      `update public.customers
       set legal_name=$2, tax_system=$3, email=$4, zip=$5, facturapi_customer_id=$6, updated_at=now()
       where id=$1
       returning *`,
      [
        localCustomer.id,
        String(customer.legalName),
        String(customer.taxSystem),
        String(customer.email),
        String(customer.address?.zip || ""),
        facturapiCustomerId,
      ]
    );
    localCustomer = upd.rows[0];
  }

  // 6) Crear invoice
  const total = Number(order.total || 0);

  const invoice = await facturapi.invoices.create({
    customer: localCustomer.facturapi_customer_id,
    payment_form: paymentForm || "03",
    use: cfdiUse || "G03",
    items: [
      {
        quantity: 1,
        product: {
          product_key: "90101501",
          description: `Consumo Cantina La Llorona - numcheque ${order.numcheque}`,
          price: total,
        },
      },
    ],
  });

  // 7) Guardar invoice en DB
  const insInv = await db.query(
    `insert into public.invoices (order_id, facturapi_invoice_id, customer_id)
     values ($1,$2,$3)
     returning id`,
    [orderId, invoice.id, localCustomer.id]
  );

  const invoiceId = insInv.rows[0].id;

  // 8) Enviar automáticamente por email
  await facturapi.invoices.sendByEmail(invoice.id);
  await db.query(`update public.invoices set emailed_at=now() where id=$1`, [
    invoiceId,
  ]);
  // Descarga streams desde Facturapi
  const pdfStream = await facturapi.invoices.downloadPdf(invoice.id);
  const xmlStream = await facturapi.invoices.downloadXml(invoice.id);
  const zipStream = await facturapi.invoices.downloadZip(invoice.id);

  // Subir a FTP: /facturasllorona/<invoiceId>/{invoice.pdf,invoice.xml,invoice.zip}
  try {
    const uploaded = await uploadInvoiceFilesToFtp({
      invoiceId,
      pdfStream,
      xmlStream,
      zipStream,
    });

    await db.query(
      `update public.invoices
     set media_pdf_url=$2, media_xml_url=$3, media_zip_url=$4, uploaded_at=now()
     where id=$1`,
      [invoiceId, uploaded.pdfUrl, uploaded.xmlUrl, uploaded.zipUrl]
    );
  } catch (e) {
    console.error("[ftp-upload] failed", e);
    // No rompemos el flujo: la factura ya existe y ya se envió por correo.
  }

  return res.json({
    ok: true,
    alreadyInvoiced: false,
    invoiceId,
    pdfUrl: `/api/invoices/${invoiceId}/pdf`,
    zipUrl: `/api/invoices/${invoiceId}/zip`,
    emailed: true,
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
app.get("/api/invoices/:id/xml", async (req, res) => {
  const id = Number(req.params.id);

  const r = await db.query(
    `select * from public.invoices where id=$1 limit 1`,
    [id]
  );
  if (!r.rows.length)
    return res.status(404).json({ error: "Invoice no encontrada" });

  const facturapi = fp();
  const xmlStream = await facturapi.invoices.downloadXml(
    r.rows[0].facturapi_invoice_id
  );

  res.setHeader("Content-Type", "application/xml");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="factura_${id}.xml"`
  );
  xmlStream.pipe(res);
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
  if (r.rows.length === 0)
    return res.status(404).json({ error: "Invoice no encontrada" });

  const facturapi = fp();
  console.log(r.rows[0].facturapi_invoice_id);
  const pdfStream = await facturapi.invoices.downloadPdf(
    r.rows[0].facturapi_invoice_id
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="factura_${r.rows[0].facturapi_invoice_id}.pdf"`
  );
  pdfStream.pipe(res);
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(Number(process.env.PORT || 3000), () => {
  console.log(`[api] listening on :${process.env.PORT || 3000}`);
});
