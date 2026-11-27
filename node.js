// proxy.js  —  node proxy.js
const http  = require("http");
const https = require("https");

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "*");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url   = new URL(req.url.slice(1), "https://placeholder");
  const target = req.url.slice(1); // full URL passed as path

  const parsed = new URL(target);
  const opts = {
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method:   req.method,
    headers:  { ...req.headers, host: parsed.hostname },
  };
  delete opts.headers["origin"];
  delete opts.headers["referer"];

  const proxy = https.request(opts, (pr) => {
    res.writeHead(pr.statusCode, pr.headers);
    pr.pipe(res);
  });
  proxy.on("error", e => { res.writeHead(502); res.end(e.message); });
  req.pipe(proxy);
}).listen(7979, () => console.log("Proxy up → http://localhost:7979"));