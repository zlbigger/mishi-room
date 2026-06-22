import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, ".data");
const roomsStorePath = join(dataDir, "rooms.json");
const port = Number(process.env.PORT || 4173);
const maxBodyBytes = 20 * 1024 * 1024;
const maxStoredEvents = 900;
const maxRoomMembers = 2;
const sessionHoldMs = 10000;
const rooms = new Map();
let persistTimer = null;

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

function serializeRoom(room) {
  return {
    id: room.id,
    title: room.title,
    mode: room.mode,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    salt: room.salt,
    passwordHash: room.passwordHash,
    events: room.events,
    sessions: [...room.sessions.values()],
    destroyed: room.destroyed
  };
}

function hydrateRoom(saved) {
  if (!saved || saved.destroyed || Date.now() > Number(saved.expiresAt)) return null;
  return {
    id: saved.id,
    title: sanitizeText(saved.title, "密室") || "密室",
    mode: ["intimate", "stranger", "work"].includes(saved.mode) ? saved.mode : "intimate",
    createdAt: Number(saved.createdAt) || Date.now(),
    expiresAt: Number(saved.expiresAt),
    salt: saved.salt,
    passwordHash: saved.passwordHash,
    events: Array.isArray(saved.events) ? saved.events : [],
    sessions: new Map((Array.isArray(saved.sessions) ? saved.sessions : []).map((session) => [session.token, session])),
    clients: new Map(),
    destroyed: false
  };
}

async function persistRoomsNow() {
  clearTimeout(persistTimer);
  persistTimer = null;
  const activeRooms = [...rooms.values()].filter((room) => !room.destroyed && Date.now() <= room.expiresAt);
  await mkdir(dataDir, { recursive: true });
  await writeFile(roomsStorePath, JSON.stringify({ version: 1, rooms: activeRooms.map(serializeRoom) }), "utf8");
}

function schedulePersistRooms() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistRoomsNow().catch((error) => console.error("[persist_rooms]", error));
  }, 250);
  persistTimer.unref?.();
}

async function restoreRooms() {
  try {
    const data = JSON.parse(await readFile(roomsStorePath, "utf8"));
    for (const saved of Array.isArray(data.rooms) ? data.rooms : []) {
      const room = hydrateRoom(saved);
      if (room?.id) rooms.set(room.id, room);
    }
    if (rooms.size) console.log(`Restored ${rooms.size} active room(s).`);
  } catch (error) {
    if (error.code !== "ENOENT") console.error("[restore_rooms]", error);
  }
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

function pruneDetachedSessions(room, now = Date.now()) {
  for (const [token, session] of room.sessions) {
    if (room.clients.has(token)) continue;
    const recentlyJoined = now - session.joinedAt < sessionHoldMs;
    const recentlySeen = now - session.lastSeen < sessionHoldMs;
    if (!recentlyJoined && !recentlySeen) {
      room.sessions.delete(token);
    }
  }
}

function occupiedSessionCount(room, now = Date.now(), exceptToken = null) {
  pruneDetachedSessions(room, now);
  let count = 0;
  for (const [token, session] of room.sessions) {
    if (token === exceptToken) continue;
    if (room.clients.has(token) || now - session.joinedAt < sessionHoldMs || now - session.lastSeen < sessionHoldMs) {
      count += 1;
    }
  }
  return count;
}

function roomIsFull(room, exceptToken = null) {
  return occupiedSessionCount(room, Date.now(), exceptToken) >= maxRoomMembers;
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

function sceneDataFrom(event) {
  const source = event?.payload && typeof event.payload === "object" ? event.payload : event || {};
  return {
    elements: Array.isArray(source.elements) ? source.elements : [],
    appState: source.appState && typeof source.appState === "object" ? source.appState : {},
    files: source.files && typeof source.files === "object" ? source.files : {}
  };
}

function mergeSceneFiles(previousEvent, nextEvent) {
  return {
    ...sceneDataFrom(previousEvent).files,
    ...sceneDataFrom(nextEvent).files
  };
}

function elementVersionScore(element) {
  return Number(element?.version || 0) * 1_000_000_000 + Number(element?.updated || 0);
}

function mergeSceneElements(previousEvent, nextEvent) {
  const previous = sceneDataFrom(previousEvent).elements;
  const next = sceneDataFrom(nextEvent).elements;
  if (!next.length && previous.length) return previous;

  const merged = new Map();
  for (const element of previous) {
    if (element?.id) merged.set(element.id, element);
  }
  for (const element of next) {
    if (!element?.id) continue;
    const current = merged.get(element.id);
    if (!current || elementVersionScore(element) >= elementVersionScore(current)) {
      merged.set(element.id, element);
    }
  }
  return [...merged.values()];
}

function sceneHasContent(scene) {
  return scene.elements.length > 0 || Object.keys(scene.files).length > 0;
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
  schedulePersistRooms();
}

function clientColor(index) {
  const colors = ["#2558ff", "#00a884", "#ff7a59", "#171717", "#ef4d37", "#8b5cf6"];
  return colors[index % colors.length];
}

const aliasAdjectives = [
  "薄荷",
  "月光",
  "纸飞机",
  "蓝莓",
  "落日",
  "玻璃",
  "电台",
  "雨后",
  "雪松",
  "微醺",
  "海盐",
  "星尘"
];

const aliasNouns = [
  "画师",
  "邮差",
  "密探",
  "来客",
  "记录员",
  "涂鸦师",
  "放映员",
  "收藏家",
  "观察员",
  "合伙人",
  "拆信人",
  "造梦师"
];

function randomItem(items, offset = 0) {
  return items[(randomBytes(1)[0] + offset) % items.length];
}

function makeAlias(room, index) {
  const usedNames = new Set([...room.sessions.values()].map((session) => session.name));
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const name = `${randomItem(aliasAdjectives, attempt)}${randomItem(aliasNouns, index + attempt)}`;
    if (!usedNames.has(name)) return name;
  }
  return `${randomItem(aliasAdjectives)}${randomItem(aliasNouns)} ${index + 1}`;
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
      schedulePersistRooms();
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
        if (roomIsFull(room, token)) {
          room.sessions.delete(token);
          json(res, 409, { error: "room_full", message: "这间密室已经有 2 个人了，暂时不能再进入。" });
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
        const resumeToken = sanitizeText(body.token);
        const existingSession = getSession(room, resumeToken);
        if (existingSession) {
          if (roomIsFull(room, resumeToken)) {
            json(res, 409, { error: "room_full", message: "这间密室已经有 2 个人了，暂时不能再进入。" });
            return;
          }
          existingSession.lastSeen = Date.now();
          schedulePersistRooms();
          json(res, 200, {
            token: resumeToken,
            self: existingSession,
            room: roomSummary(room),
            events: room.events
          });
          return;
        }

        const password = sanitizeText(body.password);
        if (!verifyPassword(password, room)) {
          json(res, 403, { error: "forbidden", message: "口令不正确。" });
          return;
        }
        if (roomIsFull(room)) {
          json(res, 409, { error: "room_full", message: "这间密室已经有 2 个人了，暂时不能再进入。" });
          return;
        }

        const token = makeId(18);
        const sessionIndex = occupiedSessionCount(room);
        const session = {
          id: makeId(6),
          token,
          name: makeAlias(room, sessionIndex),
          color: clientColor(sessionIndex),
          joinedAt: Date.now(),
          lastSeen: Date.now()
        };
        room.sessions.set(token, session);
        schedulePersistRooms();
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
        if (!["stroke", "text", "image", "image-update", "file", "cursor", "scene"].includes(type)) {
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

        if (type === "image-update") {
          const target = room.events.find((item) => item.type === "image" && item.id === payload.id);
          if (!target) {
            badRequest(res, "要更新的图片不存在。");
            return;
          }
          for (const key of ["x", "y", "w", "h"]) {
            if (Number.isFinite(Number(payload[key]))) {
              target[key] = Number(payload[key]);
            }
          }
          target.updatedAt = payload.createdAt;
          target.updatedBy = payload.actor;
        } else if (type === "scene") {
          const previousScene = room.events.find((item) => item.type === "scene");
          const scene = sceneDataFrom(payload);
          const joinedRecently = payload.createdAt - session.joinedAt < 15000;
          if (joinedRecently && sceneHasContent(sceneDataFrom(previousScene)) && !sceneHasContent(scene)) {
            json(res, 202, { ok: true, id: payload.id, ignored: "initial_empty_scene" });
            return;
          }
          payload.elements = mergeSceneElements(previousScene, payload);
          payload.appState = scene.appState;
          payload.files = mergeSceneFiles(previousScene, payload);
          delete payload.payload;
          room.events = room.events.filter((item) => item.type !== "scene");
          room.events.push(payload);
        } else if (type !== "cursor") {
          room.events.push(payload);
          pruneEvents(room);
        }
        if (type !== "cursor") schedulePersistRooms();
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

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    persistRoomsNow()
      .catch((error) => console.error("[persist_rooms_before_exit]", error))
      .finally(() => process.exit(0));
  });
}

await restoreRooms();

server.listen(port, "0.0.0.0", () => {
  console.log(`Mishi Room running at http://localhost:${port}`);
});
