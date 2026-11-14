import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { RequestError } from "./dashboard.js";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

async function readJson(req) {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError("Content-Type must be application/json.", 415);
  }
  if (req.headers["sec-fetch-site"] === "cross-site") throw new RequestError("Cross-site commands are not allowed.", 403);
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) throw new RequestError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("Request body must be valid JSON.");
  }
}

export function createServer({ dashboard, webRoot, logger = console }) {
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    res.setHeader("Cache-Control", "no-store");
    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname === "/api/command") {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          throw new RequestError("Method not allowed.", 405);
        }
        await dashboard.command(await readJson(req));
        return json(200, { ok: true });
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        res.setHeader("Allow", "GET, HEAD");
        throw new RequestError("Method not allowed.", 405);
      }
      if (pathname === "/health") return json(200, { ok: true, connected: dashboard.connected });
      if (pathname === "/api/state") return json(200, dashboard.payload());
      const asset = assets.get(pathname);
      if (!asset) throw new RequestError("Not found.", 404);
      const body = await fs.readFile(path.join(webRoot, asset[0]));
      res.writeHead(200, { "Content-Type": asset[1] });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      logger.warn(`HTTP request failed: ${error.message}`);
      json(error instanceof RequestError ? error.status : 502, {
        error: error instanceof RequestError ? error.message : "The request failed. Check the app log and Home Assistant connection.",
      });
    }
  });
}
