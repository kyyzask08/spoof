// api/batch.js — Vercel serverless
// Runtime : Node 18+
// Endpoint: POST /api/batch
// Body    : { ids: string[], apiKey: string, userId: string, assetType: string, concurrency: number, mode: string }

const OPEN_CLOUD_BASE  = "https://apis.roblox.com/assets/v1/assets";
const POLL_INTERVAL_MS = 1500;
const POLL_MAX         = 40;
const RETRY_MAX        = 3;
const RETRY_DELAY_MS   = 1000;

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const {
    ids,
    apiKey,
    userId,
    assetType   = "Animation",
    concurrency = 3,
    mode        = "plain",
  } = req.body ?? {};

  if (!apiKey || !userId || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "Missing: apiKey, userId, ids[]" });
  }

  const results = await processWithConcurrency(
    ids,
    Math.min(Number(concurrency) || 3, 5),
    (id) => processOne(id, apiKey, userId, assetType, mode)
  );

  return res.status(200).json({ results });
}

// ── Core: satu aset ───────────────────────────────────────────────────────────

async function processOne(originalId, apiKey, userId, assetType, mode) {
  const base = { originalId, newId: null, status: "error", error: null };

  try {
    // 1. Download dari Roblox CDN
    const rawBuffer = await downloadAsset(originalId);

    // 2. Patch creator kalau mode=spoof
    const patchedBuffer = mode === "spoof" ? patchCreator(rawBuffer, userId) : rawBuffer;

    // 3. Upload ke Open Cloud
    const operationId = await uploadAsset(patchedBuffer, apiKey, userId, assetType);

    // 4. Poll sampai selesai
    const newId = await pollOperation(operationId, apiKey);

    return { ...base, newId, status: "done" };
  } catch (err) {
    return { ...base, error: String(err?.message ?? err) };
  }
}

// ── Step 1: Download ──────────────────────────────────────────────────────────

async function downloadAsset(id) {
  // Coba dua endpoint — v1/assetId/:id dulu, fallback ke v1/asset?id=
  const urls = [
    `https://assetdelivery.roblox.com/v1/assetId/${id}`,
    `https://assetdelivery.roblox.com/v1/asset/?id=${id}`,
  ];

  for (const infoUrl of urls) {
    try {
      const infoRes = await fetchWithRetry(infoUrl, {
        headers: { Accept: "application/json", "User-Agent": "Roblox/WinInet" },
        redirect: "follow",
      });

      if (!infoRes.ok) continue;

      const contentType = infoRes.headers.get("content-type") ?? "";

      // Kalau endpoint langsung return binary (v2 behavior)
      if (!contentType.includes("application/json")) {
        const buf = Buffer.from(await infoRes.arrayBuffer());
        if (buf.byteLength > 0) return buf;
        continue;
      }

      // JSON → ambil location → download binary
      const json   = await infoRes.json();
      const cdnUrl = json.location;
      if (!cdnUrl) continue;

      const fileRes = await fetchWithRetry(cdnUrl, {
        headers: { "User-Agent": "Roblox/WinInet" },
      });

      if (!fileRes.ok) continue;

      const buf = Buffer.from(await fileRes.arrayBuffer());
      if (buf.byteLength > 0) return buf;
    } catch (_) {
      continue;
    }
  }

  throw new Error(`Download failed for ID ${id}`);
}

// ── Step 2: Patch creator (mode=spoof) ───────────────────────────────────────

function patchCreator(buffer, userId) {
  const prefix = buffer.toString("utf8", 0, 8);
  if (prefix.startsWith("<?xml") || prefix.startsWith("<roblox")) {
    return patchXml(buffer, userId);
  }
  return patchBinaryRbxm(buffer, userId);
}

function patchXml(buffer, userId) {
  let xml = buffer.toString("utf8");
  xml = xml.replace(/(<(?:CreatorId|UserId|RobloxId)>)\d+(<\/)/g, `$1${userId}$2`);
  xml = xml.replace(/(<CreatorType>)\d+(<\/)/g, "${1}1$2");
  return Buffer.from(xml, "utf8");
}

function patchBinaryRbxm(buffer, userId) {
  const copy    = Buffer.from(buffer);
  const uidInt  = parseInt(userId, 10);
  const needles = ["CreatorId", "UserId", "RobloxId"].map(n => Buffer.from(n, "ascii"));

  for (const needle of needles) {
    let offset = 0;
    while (offset < copy.length - needle.length - 4) {
      const idx = copy.indexOf(needle, offset);
      if (idx === -1) break;
      const scanEnd = Math.min(idx + needle.length + 24, copy.length - 4);
      for (let s = idx + needle.length; s < scanEnd; s++) {
        const candidate = copy.readInt32LE(s);
        if (candidate > 100 && candidate < 0x7fffffff) {
          copy.writeInt32LE(uidInt, s);
          break;
        }
      }
      offset = idx + needle.length;
    }
  }
  return copy;
}

// ── Step 3: Upload ke Open Cloud ──────────────────────────────────────────────

async function uploadAsset(buffer, apiKey, userId, assetType) {
  const metadata = JSON.stringify({
    assetType,
    displayName: `Asset_${Date.now()}`,
    description: "",
    creationContext: {
      creator: { userId: String(userId) },
    },
  });

  // Native FormData — no import needed, built-in Node 18+
  const form = new FormData();
  form.append("request", new Blob([metadata], { type: "application/json" }));
  form.append(
    "fileContent",
    new Blob([buffer], { type: "application/octet-stream" }),
    "asset.bin"
  );

  const res = await fetchWithRetry(OPEN_CLOUD_BASE, {
    method:  "POST",
    headers: { "x-api-key": apiKey },
    // jangan set Content-Type manual — biar fetch isi boundary sendiri
    body: form,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Upload HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = await res.json();
  const operationId = data.path?.split("/").pop();
  if (!operationId) throw new Error(`No operation path: ${JSON.stringify(data)}`);
  return operationId;
}

// ── Step 4: Poll operation ────────────────────────────────────────────────────

async function pollOperation(operationId, apiKey) {
  const url = `https://apis.roblox.com/assets/v1/operations/${operationId}`;

  for (let i = 0; i < POLL_MAX; i++) {
    await sleep(POLL_INTERVAL_MS);

    const res = await fetchWithRetry(url, {
      headers: { "x-api-key": apiKey },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Poll HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();

    if (data.done) {
      if (data.error) throw new Error(`Operation failed: ${JSON.stringify(data.error)}`);
      const assetId = data.response?.assetId ?? data.response?.asset?.assetId;
      if (!assetId) throw new Error(`No assetId in response: ${JSON.stringify(data)}`);
      return String(assetId);
    }
  }

  throw new Error(`Operation ${operationId} timed out after ${POLL_MAX} polls`);
}

// ── Concurrency helper ────────────────────────────────────────────────────────

async function processWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ── Fetch with retry ──────────────────────────────────────────────────────────

async function fetchWithRetry(url, options = {}, retries = RETRY_MAX) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

// ── Util ──────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
