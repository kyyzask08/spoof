// proxy.js — AnimReup local CORS proxy (FIXED VERSION)
// Runtime : Node 18+  (native fetch built-in)
// Usage   : npm install && node proxy.js
// Port    : 3131  (override with PORT env var)

import { createServer }  from "http";
import FormData          from "form-data";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3131;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...CORS, "Content-Type": "application/json" });
  res.end(body);
}

function sendErr(res, status, msg) {
  sendJson(res, status, { error: msg });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── Route: GET /delivery/:assetId ────────────────────────────────────────────
// FIXED: Menggunakan endpoint Open Cloud yang baru dan mewajibkan x-api-key

async function handleDelivery(req, res, assetId) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return sendErr(res, 400, "Missing x-api-key header untuk download");
  }

  try {
    // 1. Hit API Open Cloud yang BARU
    const infoRes = await fetch(
      `https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`,
      { 
        headers: { 
          "x-api-key": apiKey,
          "Accept": "application/json" 
        }, 
        redirect: "follow" 
      }
    );
    
    if (!infoRes.ok) {
      const errText = await infoRes.text();
      // Jika error 403, berarti aset privat atau API Key tidak punya akses
      return sendErr(res, infoRes.status, `Delivery API Gagal: ${infoRes.status} - ${errText}`);
    }

    const info   = await infoRes.json();
    const cdnUrl = info.location;
    if (!cdnUrl) {
      return sendErr(res, 502, "Delivery API: field 'location' tidak ditemukan");
    }

    // 2. Download binary asli dari CDN Roblox
    const fileRes = await fetch(cdnUrl);
    if (!fileRes.ok) {
      return sendErr(res, 502, `CDN download gagal: ${fileRes.status}`);
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());

    // 3. Kirim balik ke browser
    res.writeHead(200, {
      ...CORS,
      "Content-Type":   "application/octet-stream",
      "Content-Length": buffer.byteLength,
      "X-Cdn-Url":      cdnUrl,
    });
    res.end(buffer);
  } catch (e) {
    sendErr(res, 500, e.message);
  }
}

// ── Route: POST /upload ───────────────────────────────────────────────────────
// (Tidak banyak berubah, hanya perapian)

async function handleUpload(req, res) {
  try {
    const raw = await readBody(req);
    let body;
    try   { body = JSON.parse(raw.toString("utf8")); }
    catch { return sendErr(res, 400, "Invalid JSON body"); }

    const { apiKey, userId, assetType, displayName, fileBase64 } = body;
    if (!apiKey || !userId || !assetType || !fileBase64)
      return sendErr(res, 400, "Missing: apiKey, userId, assetType, fileBase64");

    const fileBuffer = Buffer.from(fileBase64, "base64");

    // Build multipart
    const form = new FormData();

    form.append("request", JSON.stringify({
      assetType: assetType,
      displayName: displayName || `Reup_${Date.now()}`,
      description: "",
      creationContext: {
        creator: { userId: parseInt(userId, 10) }
      }
    }), { contentType: "application/json" });

    form.append("fileContent", fileBuffer, {
      filename:    "asset.bin",
      contentType: "application/octet-stream",
      knownLength: fileBuffer.byteLength,
    });

    const formHeaders = form.getHeaders();

    // Upload ke Open Cloud
    const ocRes = await fetch("https://apis.roblox.com/assets/v1/assets", {
      method:  "POST",
      headers: {
        "x-api-key": apiKey,
        ...formHeaders,
      },
      body: form.getBuffer(),
    });

    const ocText = await ocRes.text();
    let ocJson;
    try   { ocJson = JSON.parse(ocText); }
    catch { ocJson = { raw: ocText }; }

    if (!ocRes.ok)
      return sendErr(res, ocRes.status, `Open Cloud Upload Gagal: ${ocText.slice(0, 200)}`);

    sendJson(res, 200, ocJson);
  } catch (e) {
    sendErr(res, 500, e.message);
  }
}

// ── Route: GET /poll/:operationId ─────────────────────────────────────────────

async function handlePoll(req, res, operationId) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return sendErr(res, 400, "Missing x-api-key header");

  try {
    const ocRes = await fetch(
      `https://apis.roblox.com/assets/v1/operations/${operationId}`,
      { headers: { "x-api-key": apiKey } }
    );
    const text = await ocRes.text();
    let json;
    try   { json = JSON.parse(text); }
    catch { json = { raw: text }; }

    res.writeHead(ocRes.status, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  } catch (e) {
    sendErr(res, 500, e.message);
  }
}

// ── Main Server ───────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (path === "/health" && req.method === "GET")
    return sendJson(res, 200, { status: "ok", port: PORT, node: process.version });

  const deliveryMatch = path.match(/^\/delivery\/(\d+)$/);
  // FIXED: Oper req ke handleDelivery agar bisa ambil header
  if (deliveryMatch && req.method === "GET")
    return handleDelivery(req, res, deliveryMatch[1]); 

  if (path === "/upload" && req.method === "POST")
    return handleUpload(req, res);

  const pollMatch = path.match(/^\/poll\/(.+)$/);
  if (pollMatch && req.method === "GET")
    return handlePoll(req, res, decodeURIComponent(pollMatch[1]));

  sendErr(res, 404, `No route: ${req.method} ${path}`);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  AnimReup Proxy (FIXED) →  http://localhost:${PORT}`);
  console.log(`  Node                   →  ${process.version}`);
  console.log(`  Routes:`);
  console.log(`    GET  /delivery/:assetId (Butuh header x-api-key)`);
  console.log(`    POST /upload`);
  console.log(`    GET  /poll/:operationId`);
  console.log(`    GET  /health\n`);
});