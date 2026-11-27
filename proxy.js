// proxy.js — AnimReup local CORS proxy
// Runtime : Node 18+  (native fetch built-in)
// Usage   : npm install && node proxy.js
// Port    : 3131  (override with PORT env var)
//
// Routes
//   GET  /delivery/:assetId     → resolves CDN location + streams binary back
//   POST /upload                → builds multipart via form-data pkg → Open Cloud
//   GET  /poll/:operationId     → polls Open Cloud operation
//   GET  /health                → sanity check

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
// 1. Hit assetdelivery API → get CDN redirect URL
// 2. Download binary from CDN
// 3. Stream binary back to browser

async function handleDelivery(res, assetId) {
  try {
    const infoRes = await fetch(
      `https://assetdelivery.roblox.com/v1/assetId/${assetId}`,
      { headers: { Accept: "application/json" }, redirect: "follow" }
    );
    if (!infoRes.ok)
      return sendErr(res, 502, `Delivery API: ${infoRes.status}`);

    const info   = await infoRes.json();
    const cdnUrl = info.location;
    if (!cdnUrl)
      return sendErr(res, 502, "Delivery API: no location field");

    const fileRes = await fetch(cdnUrl);
    if (!fileRes.ok)
      return sendErr(res, 502, `CDN download: ${fileRes.status}`);

    const buffer = Buffer.from(await fileRes.arrayBuffer());

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
// Body JSON: { apiKey, userId, assetType, displayName, fileBase64 }
// Uses form-data package to build multipart → forwards to Open Cloud

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

    // ── Build multipart using form-data ──
    const form = new FormData();

    form.append("request", JSON.stringify({
      assetType,
      displayName: displayName || `animreup_${Date.now()}`,
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

    // form-data gives us the correct Content-Type header with boundary
    const formHeaders = form.getHeaders();

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
      return sendErr(res, ocRes.status, `Open Cloud: ${ocText.slice(0, 200)}`);

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

// ── Main server ───────────────────────────────────────────────────────────────

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
  if (deliveryMatch && req.method === "GET")
    return handleDelivery(res, deliveryMatch[1]);

  if (path === "/upload" && req.method === "POST")
    return handleUpload(req, res);

  const pollMatch = path.match(/^\/poll\/(.+)$/);
  if (pollMatch && req.method === "GET")
    return handlePoll(req, res, decodeURIComponent(pollMatch[1]));

  sendErr(res, 404, `No route: ${req.method} ${path}`);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  AnimReup Proxy  →  http://localhost:${PORT}`);
  console.log(`  Node            →  ${process.version}`);
  console.log(`  form-data       →  ${FormData.name} (npm pkg)`);
  console.log(`  Routes:`);
  console.log(`    GET  /delivery/:assetId`);
  console.log(`    POST /upload`);
  console.log(`    GET  /poll/:operationId`);
  console.log(`    GET  /health\n`);
});
