import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 4173);
const maxBodyBytes = 9 * 1024 * 1024;
const maxStoredEvents = 900;
const rooms = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function makeId(bytes = 9) {
  return randomBytes(bytes).toString("base64url");
}

function hashPassword(password, salt = randomBytes(16).toString("base64url")) {
  const hash = pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("base64url");
  return { salt, hash };
}

function verifyPassword(password, room) {
  const candidate = hashPassword(password, room.salt).hash;
  const stored = Buffer.from(room.passwordHash);
  const incoming = Buffer.from(candidate);
  return stored.length === incoming.length && timingSafeEqual(stored, incoming);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "not_found", message: "房间不存在或已经消失。" });
}

function badRequest(res, message) {
  json(res, 400, { error: "bad_request", message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error("body_too_large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid_json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function roomSummary(room) {
  return {
    id: room.id,
    title: room.title,
    mode: room.mode,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    destroyed: room.destroyed,
    eventCount: room.events.length
  };
}

function getRoom(id) {
  const room = rooms.get(id);
  if (!room || room.destroyed || Date.now() > room.expiresAt) {
    if (room) destroyRoom(room, "expired");
    return null;
  }
  return room;
}

function getSession(room, token) {
  if (!token) return null;
  return room.sessions.get(token) || null;
}

function sendSse(client, event, data) {
  client.res.write(`event: ${event}\n`);
  client.res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room, event, data, exceptToken = null) {
  for (const [token, client] of room.clients) {
    if (exceptToken && token === exceptToken) continue;
    sendSse(client, event, data);
  }
}

function broadcastPresence(room) {
  const members = [...room.clients.keys()]
    .map((token) => room.sessions.get(token))
    .filter(Boolean)
    .map((session) => ({
      id: session.id,
      name: session.name,
      color: session.color,
      joinedAt: session.joinedAt
    }));
  broadcast(room, "presence", { members });
}

function pruneEvents(room) {
  if (room.events.length > maxStoredEvents) {
    room.events.splice(0, room.events.length - maxStoredEvents);
  }
}

function destroyRoom(room, reason = "destroyed", actor = null) {
  if (room.destroyed) return;
  room.destroyed = true;
  room.events.length = 0;
  broadcast(room, "destroyed", {
    roomId: room.id,
    reason,
    actor,
    at: Date.now()
  });
  for (const client of room.clients.values()) {
    client.res.end();
  }
  room.clients.clear();
  setTimeout(() => rooms.delete(room.id), 1000);
}

function clientColor(index) {
  const colors = ["#2558ff", "#00a884", "#ff7a59", "#171717", "#ef4d37", "#8b5cf6"];
  return colors[index % colors.length];
}

function sanitizeText(value, fallback = "") {
  return String(value || fallback).slice(0, 160).trim();
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname.startsWith("/r/")) pathname = "/index.html";
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    notFound(res);
    return;
  }

  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": mimeTypes[ext] || "application/octet-stream",
    "cache-control": "no-store"
  });
  createReadStream(filePath).pipe(res);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readBody(req);
      const password = sanitizeText(body.password);
      if (password.length < 4) {
        badRequest(res, "口令至少需要 4 个字符。");
        return;
      }

      const ttlMinutes = Math.min(Math.max(Number(body.ttlMinutes) || 60, 5), 10080);
      const id = makeId();
      const { salt, hash } = hashPassword(password);
      const room = {
        id,
        title: sanitizeText(body.title, "密室") || "密室",
        mode: ["intimate", "stranger", "work"].includes(body.mode) ? body.mode : "intimate",
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMinutes * 60 * 1000,
        salt,
        passwordHash: hash,
        events: [],
        sessions: new Map(),
        clients: new Map(),
        destroyed: false
      };
      rooms.set(id, room);
      json(res, 201, { room: roomSummary(room) });
      return;
    }

    if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
      const roomId = parts[2];
      const room = getRoom(roomId);
      if (!room) {
        notFound(res);
        return;
      }

      if (req.method === "GET" && parts[3] === "events") {
        const token = url.searchParams.get("token");
        const session = getSession(room, token);
        if (!session) {
          json(res, 401, { error: "unauthorized", message: "请先输入房间口令。" });
          return;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        res.write(": connected\n\n");
        room.clients.set(token, { res, connectedAt: Date.now() });
        session.lastSeen = Date.now();
        sendSse({ res }, "hello", {
          self: session,
          room: roomSummary(room),
          events: room.events
        });
        broadcastPresence(room);

        const heartbeat = setInterval(() => {
          res.write(": heartbeat\n\n");
        }, 20000);

        req.on("close", () => {
          clearInterval(heartbeat);
          room.clients.delete(token);
          broadcastPresence(room);
        });
        return;
      }

      if (req.method === "POST" && parts[3] === "join") {
        const body = await readBody(req);
        const password = sanitizeText(body.password);
        if (!verifyPassword(password, room)) {
          json(res, 403, { error: "forbidden", message: "口令不正确。" });
          return;
        }

        const token = makeId(18);
        const sessionIndex = room.sessions.size;
        const session = {
          id: makeId(6),
          token,
          name: sanitizeText(body.name, sessionIndex === 0 ? "你" : `访客 ${sessionIndex + 1}`),
          color: clientColor(sessionIndex),
          joinedAt: Date.now(),
          lastSeen: Date.now()
        };
        room.sessions.set(token, session);
        json(res, 200, {
          token,
          self: session,
          room: roomSummary(room),
          events: room.events
        });
        return;
      }

      if (req.method === "POST" && parts[3] === "events") {
        const body = await readBody(req);
        const token = sanitizeText(body.token);
        const session = getSession(room, token);
        if (!session) {
          json(res, 401, { error: "unauthorized", message: "请重新进入房间。" });
          return;
        }
        session.lastSeen = Date.now();

        const event = body.event || {};
        const type = sanitizeText(event.type);
        if (!["stroke", "text", "image", "file", "cursor"].includes(type)) {
          badRequest(res, "不支持的事件类型。");
          return;
        }

        const payload = {
          ...event,
          id: event.id || makeId(10),
          type,
          actor: {
            id: session.id,
            name: session.name,
            color: session.color
          },
          createdAt: Date.now()
        };

        if (type !== "cursor") {
          room.events.push(payload);
          pruneEvents(room);
        }
        broadcast(room, type, payload, type === "cursor" ? token : null);
        json(res, 202, { ok: true, id: payload.id });
        return;
      }

      if (req.method === "POST" && parts[3] === "destroy") {
        const body = await readBody(req);
        const session = getSession(room, sanitizeText(body.token));
        if (!session) {
          json(res, 401, { error: "unauthorized", message: "请重新进入房间。" });
          return;
        }
        destroyRoom(room, "manual", { id: session.id, name: session.name, color: session.color });
        json(res, 202, { ok: true });
        return;
      }
    }

    notFound(res);
  } catch (error) {
    if (error.status === 413) {
      json(res, 413, { error: "too_large", message: "内容太大了，当前原型单次最多 9MB。" });
      return;
    }
    if (error.status === 400) {
      badRequest(res, "请求格式不正确。");
      return;
    }
    const fingerprint = createHash("sha256").update(String(error.stack || error)).digest("hex").slice(0, 8);
    console.error(`[${fingerprint}]`, error);
    json(res, 500, { error: "server_error", message: `服务暂时不可用。错误码 ${fingerprint}` });
  }
}

const server = createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.destroyed && Date.now() > room.expiresAt) {
      destroyRoom(room, "expired");
    }
  }
}, 30000).unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`Mishi Room running at http://localhost:${port}`);
});
