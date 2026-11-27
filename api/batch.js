// api/batch.js — Vercel serverless
// Runtime: Node.js 18+
// Endpoint: POST /api/batch
// Body: { ids: string[], apiKey: string, userId: string }
// Headers alt: x-roblox-api-key, x-roblox-user-id

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import FormData from "form-data";

// ── Constants ────────────────────────────────────────────────────────────────

const ASSET_DELIVERY   = "https://assetdelivery.roblox.com/v1/asset/";
const OPEN_CLOUD_BASE  = "https://apis.roblox.com/assets/v1/assets";
const CONCURRENCY      = 4;      // parallel uploads per chunk
const RETRY_MAX        = 3;
const RETRY_DELAY_MS   = 800;
const POLL_INTERVAL_MS = 1200;
const POLL_MAX         = 25;

// ── Entry point ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = req.headers["x-roblox-api-key"] || req.body?.apiKey;
  const userId = req.headers["x-roblox-user-id"] || req.body?.userId;
  const ids    = req.body?.ids;
  const mode   = req.body?.mode ?? "spoof"; // "spoof" | "plain"

  if (!apiKey || !userId || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "Missing apiKey, userId, or ids" });
  }

  // Process in parallel with concurrency cap
  const results = await processWithConcurrency(ids, CONCURRENCY, (id) =>
    processOne(id, apiKey, userId, mode)
  );

  return res.status(200).json({ results });
}

// ── Core: one animation ID ────────────────────────────────────────────────────

async function processOne(originalId, apiKey, userId, mode = "spoof") {
  const base = { originalId, newId: null, robloxLink: null, status: "error", error: null };

  try {
    // 1. Download raw RBXM/XML from Roblox asset delivery
    const rawBuffer = await downloadAsset(originalId);

    // 2. Detect format and spoof creator fields (skip when mode=plain)
    const patchedBuffer = mode === "spoof" ? patchCreator(rawBuffer, userId) : rawBuffer;

    // 3. Upload via Open Cloud Assets API
    const operationId = await uploadAsset(patchedBuffer, apiKey, userId);

    // 4. Poll until operation completes
    const newId = await pollOperation(operationId, apiKey);

    return {
      ...base,
      newId,
      robloxLink: `https://www.roblox.com/catalog/${newId}`,
      status: "done",
    };
  } catch (err) {
    return { ...base, error: String(err.message || err) };
  }
}

// ── Step 1: Download ──────────────────────────────────────────────────────────

async function downloadAsset(id) {
  const url = `${ASSET_DELIVERY}?id=${encodeURIComponent(id)}`;

  const response = await fetchWithRetry(url, {
    headers: {
      "User-Agent": "Roblox/WinInet",
      "Accept": "*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── Step 2: Patch creator metadata ───────────────────────────────────────────
// Roblox animation assets are RBXM (binary) or RBXMX (XML).
// RBXMX is plaintext XML — parse and replace creator fields directly.
// RBXM binary: locate UTF-8 string chunks and patch creator user ID in-place.

function patchCreator(buffer, userId) {
  const str = buffer.toString("utf8", 0, 8);

  // RBXMX: starts with <?xml or <roblox
  if (str.startsWith("<?xml") || str.startsWith("<roblox")) {
    return patchXml(buffer, userId);
  }

  // RBXM binary magic: "<roblox!" (3C 72 6F 62 6C 6F 78 21)
  if (buffer[0] === 0x3c && buffer[1] === 0x72) {
    return patchBinaryRbxm(buffer, userId);
  }

  // Unknown format — upload as-is; server-side re-owner via API params is enough
  return buffer;
}

function patchXml(buffer, userId) {
  const xml = buffer.toString("utf8");
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");

  // Target nodes that carry creator/owner identity
  const targetProps = [
    "CreatorId",
    "CreatorType",
    "RobloxId",
    "UserId",
  ];

  targetProps.forEach((propName) => {
    const nodes = doc.getElementsByTagName(propName);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      // CreatorType: 1 = User, 2 = Group — force User
      if (propName === "CreatorType") {
        node.textContent = "1";
      } else {
        node.textContent = userId;
      }
    }
  });

  // Also patch <string name="Name"> inside Creator ItemType block if present
  const intNodes = doc.getElementsByTagName("int");
  for (let i = 0; i < intNodes.length; i++) {
    const n = intNodes[i];
    const name = n.getAttribute("name");
    if (name === "UserId" || name === "CreatorId") {
      n.textContent = userId;
    }
  }

  const serializer = new XMLSerializer();
  return Buffer.from(serializer.serializeToString(doc), "utf8");
}

function patchBinaryRbxm(buffer, userId) {
  // RBXM binary stores property values as length-prefixed strings or ints.
  // Creator user IDs appear as 4-byte little-endian int32 values following
  // specific property name strings. We scan for known property name patterns
  // and patch the int value that follows.

  const copy = Buffer.from(buffer); // work on a copy

  // Property name patterns to look for (ASCII, length-prefixed)
  const propNames = ["CreatorId", "UserId", "RobloxId"];
  const uidInt = parseInt(userId, 10);

  propNames.forEach((name) => {
    const needle = Buffer.from(name, "ascii");
    let offset = 0;

    while (offset < copy.length - needle.length - 4) {
      const idx = copy.indexOf(needle, offset);
      if (idx === -1) break;

      // The int32 value is typically 4–16 bytes after the property name end,
      // depending on type tag. Scan the next 20 bytes for a plausible user ID
      // (a large positive 32-bit int) and overwrite it.
      const scanEnd = Math.min(idx + needle.length + 24, copy.length - 4);
      for (let s = idx + needle.length; s < scanEnd; s++) {
        const candidate = copy.readInt32LE(s);
        // Roblox user IDs are >100 and not tiny/negative
        if (candidate > 100 && candidate < 0x7fffffff) {
          copy.writeInt32LE(uidInt, s);
          break;
        }
      }

      offset = idx + needle.length;
    }
  });

  return copy;
}

// ── Step 3: Upload via Open Cloud ─────────────────────────────────────────────

async function uploadAsset(buffer, apiKey, userId) {
  // Open Cloud Assets API v1 — multipart/form-data
  // https://apis.roblox.com/assets/v1/assets
  //
  // Required fields:
  //   request  — JSON metadata blob (assetType, creationContext, etc.)
  //   fileContent — the binary asset

  const metadata = JSON.stringify({
    assetType: "Animation",
    displayName: `Anim_${Date.now()}`,
    description: "",
    creationContext: {
      creator: {
        userId: userId,
      },
    },
  });

  const form = new FormData();
  form.append("request", metadata, { contentType: "application/json" });
  form.append("fileContent", buffer, {
    filename: "animation.rbxm",
    contentType: "application/octet-stream",
  });

  const response = await fetchWithRetry(OPEN_CLOUD_BASE, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      ...form.getHeaders(),
    },
    body: form.getBuffer(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Upload failed: HTTP ${response.status} — ${errText.slice(0, 200)}`);
  }

  const data = await response.json();

  // Response: { path: "operations/{operationId}", ... }
  const operationPath = data.path;
  if (!operationPath) {
    throw new Error(`Upload returned no operation path: ${JSON.stringify(data)}`);
  }

  // Extract operation ID from path string "operations/abc123"
  const operationId = operationPath.split("/").pop();
  return operationId;
}

// ── Step 4: Poll operation ────────────────────────────────────────────────────

async function pollOperation(operationId, apiKey) {
  const pollUrl = `https://apis.roblox.com/assets/v1/operations/${operationId}`;

  for (let attempt = 0; attempt < POLL_MAX; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const response = await fetchWithRetry(pollUrl, {
      headers: { "x-api-key": apiKey },
    });

    if (!response.ok) {
      throw new Error(`Poll failed: HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.done) {
      if (data.error) {
        throw new Error(`Operation error: ${JSON.stringify(data.error)}`);
      }
      // response.response.assetId
      const assetId = data.response?.assetId;
      if (!assetId) {
        throw new Error(`Operation done but no assetId: ${JSON.stringify(data)}`);
      }
      return String(assetId);
    }
  }

  throw new Error(`Operation timed out after ${POLL_MAX} polls`);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function fetchWithRetry(url, options = {}, attempt = 0) {
  try {
    const response = await fetch(url, options);
    // 429 or 5xx — retry
    if ((response.status === 429 || response.status >= 500) && attempt < RETRY_MAX) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      return fetchWithRetry(url, options, attempt + 1);
    }
    return response;
  } catch (err) {
    if (attempt < RETRY_MAX) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

async function processWithConcurrency(items, concurrency, fn) {
  const results = [];
  const queue = [...items];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      results.push(await fn(item));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
