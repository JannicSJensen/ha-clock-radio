import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { RequestError } from "./dashboard.js";
import { MAError } from "./ma-api.js";
import { iconSvg } from "./icons.js";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const assetTypes = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

export function staticAsset(pathname) {
  if (assets.has(pathname)) return assets.get(pathname);
  if (!/^\/(js|css|fonts|clock)\/[a-zA-Z0-9_./-]+$/.test(pathname) || pathname.split("/").includes("..")) return null;
  const type = assetTypes[path.extname(pathname)] ?? (pathname.endsWith("/LICENSE") ? "text/plain; charset=utf-8" : null);
  return type ? [pathname.slice(1), type] : null;
}

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
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;
      const mutations = {
        "/api/command": "command", "/api/settings/clock": "saveClock",
        "/api/settings/alarm": "saveAlarm", "/api/settings/alarm-playback": "saveAlarmPlayback",
        "/api/alarm/stop": "stopAlarm", "/api/radio/play": "playRadio",
        "/api/music/play": "playMusic", "/api/radio/group": "groupPlayers",
      };
      if (Object.hasOwn(mutations, pathname)) {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          throw new RequestError("Method not allowed.", 405);
        }
        await dashboard[mutations[pathname]](await readJson(req));
        return json(200, { ok: true });
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        res.setHeader("Allow", "GET, HEAD");
        throw new RequestError("Method not allowed.", 405);
      }
      if (pathname === "/health") return json(200, { ok: true, connected: dashboard.connected });
      if (pathname === "/api/state") return json(200, dashboard.payload());
      const imageResponse = (image) => {
        if (!image) throw new RequestError("Image not found.", 404);
        res.writeHead(200, { "Content-Type": image.type });
        res.end(req.method === "HEAD" ? undefined : image.body);
      };
      if (/^\/icons\/[a-z0-9-]+\.svg$/.test(pathname)) {
        const svg = iconSvg(path.basename(pathname, ".svg"));
        if (!svg) throw new RequestError("Icon not found.", 404);
        return imageResponse({ type: "image/svg+xml", body: svg });
      }
      if (pathname.startsWith("/api/player/image/")) return imageResponse(await dashboard.playerImage(decodeURIComponent(pathname.slice("/api/player/image/".length))));
      if (pathname.startsWith("/api/music/")) {
        const music = dashboard.music;
        if (!music) throw new RequestError("Music Assistant is not configured.", 503);
        const params = Object.fromEntries(url.searchParams);
        if (pathname === "/api/music/library") {
          if (params.favorite !== undefined && !["0", "1", "false", "true"].includes(params.favorite)) throw new RequestError("favorite must be a boolean.");
          return json(200, await music.library({ ...params, favorite: ["1", "true"].includes(params.favorite) }));
        }
        if (pathname === "/api/music/discover") return json(200, await music.discover());
        if (pathname === "/api/music/search") return json(200, await music.search(params.q));
        if (pathname === "/api/music/item") return json(200, await music.detail(params.type, params.provider, params.id));
        if (pathname === "/api/music/party") return json(200, await music.party());
        if (pathname === "/api/music/party/qr") return imageResponse(await music.partyQr());
        if (/^\/api\/music\/image\/[a-f0-9]{12}$/.test(pathname)) return imageResponse(await music.image(path.basename(pathname)));
      }
      const asset = staticAsset(pathname);
      if (!asset) throw new RequestError("Not found.", 404);
      let body;
      try { body = await fs.readFile(path.join(webRoot, asset[0])); }
      catch (error) {
        if (error.code === "ENOENT") throw new RequestError("Not found.", 404);
        throw error;
      }
      res.writeHead(200, { "Content-Type": asset[1] });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      logger.warn(`HTTP request failed: ${error.message}`);
      const known = error instanceof RequestError || error instanceof MAError;
      json(known ? error.status : 502, {
        error: known ? error.message : "The request failed. Check the app log and Home Assistant connection.",
      });
    }
  });
}
