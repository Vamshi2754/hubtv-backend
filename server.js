const fastify = require("fastify");
const fastifySocketIO = require("fastify-socket.io");
const cors = require("@fastify/cors");
const Redis = require("ioredis");
require("dotenv").config();

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3001", 10);
const REDIS_URL = process.env.REDIS_URL || null;
const MAX_MSG = 500;           // max chat message chars
const MAX_QUEUE = 1000;          // max users in queue
const QUEUE_KEY = "match:queue";

// Rate limiting (per socket): max joins per window
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_JOINS = 5;

// ─── App ───────────────────────────────────────────────────────────────────
const app = fastify({
    logger: { level: process.env.NODE_ENV === "production" ? "warn" : "info" },
    trustProxy: true,
});

// ─── Redis (optional) ─────────────────────────────────────────────────────
let redis = null;
let usingRedis = false;
const localQueue = [];  // in-memory fallback

if (REDIS_URL) {
    redis = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        lazyConnect: true,
        connectTimeout: 5000,
    });
    redis.once("ready", () => { usingRedis = true; });
    redis.on("error", () => {
        if (usingRedis) {
            console.warn("[Redis] Connection failed. Using in-memory queue.");
            usingRedis = false;
        }
    });
    redis.connect().catch(() => { });
} else {
    console.info("[Server] No REDIS_URL set. Using in-memory queue.");
}

// ─── CORS ─────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());

app.register(cors, {
    origin: ALLOWED_ORIGINS.includes("*") ? "*" : (origin, cb) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error("Not allowed by CORS"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false,
});

// ─── Socket.IO ────────────────────────────────────────────────────────────
app.register(fastifySocketIO, {
    cors: {
        origin: ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS,
        methods: ["GET", "POST"],
    },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    transports: ["websocket", "polling"],
});

// ─── ICE Servers ──────────────────────────────────────────────────────────
function getIceServers() {
    const servers = [{ urls: "stun:stun.l.google.com:19302" }];
    // Add TURN if configured
    if (process.env.TURN_URL && process.env.TURN_USER && process.env.TURN_CRED) {
        servers.push({
            urls: process.env.TURN_URL,
            username: process.env.TURN_USER,
            credential: process.env.TURN_CRED,
        });
    }
    return servers;
}

// ─── Queue helpers ────────────────────────────────────────────────────────
async function enqueue(socketId) {
    if (usingRedis) {
        const len = await redis.llen(QUEUE_KEY);
        if (len >= MAX_QUEUE) return false;
        const exists = await redis.lpos(QUEUE_KEY, socketId);
        if (exists !== null) return false;
        await redis.rpush(QUEUE_KEY, socketId);
    } else {
        if (localQueue.length >= MAX_QUEUE) return false;
        if (localQueue.includes(socketId)) return false;
        localQueue.push(socketId);
    }
    return true;
}

async function dequeue() {
    if (usingRedis) {
        const script = `
      local len = redis.call("LLEN", KEYS[1])
      if len >= 2 then
        return {redis.call("LPOP", KEYS[1]), redis.call("LPOP", KEYS[1])}
      end
      return nil
    `;
        return await redis.eval(script, 1, QUEUE_KEY);
    } else {
        if (localQueue.length < 2) return null;
        return [localQueue.shift(), localQueue.shift()];
    }
}

async function removeFromQueue(socketId) {
    if (usingRedis) {
        await redis.lrem(QUEUE_KEY, 0, socketId);
    } else {
        const i = localQueue.indexOf(socketId);
        if (i !== -1) localQueue.splice(i, 1);
    }
}

async function returnToFront(socketId) {
    if (usingRedis) {
        await redis.lpush(QUEUE_KEY, socketId);
    } else {
        localQueue.unshift(socketId);
    }
}

// ─── Matchmaking ──────────────────────────────────────────────────────────
async function attemptMatch(io) {
    try {
        const pair = await dequeue();
        if (!pair || pair.length < 2) return;

        const [id1, id2] = pair;
        const s1 = io.sockets.sockets.get(id1);
        const s2 = io.sockets.sockets.get(id2);

        if (!s1 && !s2) {
            // both gone — try again if queue has more
            const len = usingRedis ? await redis.llen(QUEUE_KEY) : localQueue.length;
            if (len >= 2) attemptMatch(io);
            return;
        }
        if (!s1) { await returnToFront(id2); attemptMatch(io); return; }
        if (!s2) { await returnToFront(id1); attemptMatch(io); return; }

        // Both alive — pair them
        const roomId = `room_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const iceServers = getIceServers();

        s1.join(roomId);
        s2.join(roomId);

        s1.emit("match_found", { roomId, iceServers, isInitiator: true });
        s2.emit("match_found", { roomId, iceServers, isInitiator: false });

        app.log.info(`[Match] ${id1.slice(0, 6)} ↔ ${id2.slice(0, 6)} → ${roomId}`);
    } catch (err) {
        app.log.error("[Matchmaking]", err.message);
    }
}

// ─── Socket handlers ──────────────────────────────────────────────────────
app.ready((err) => {
    if (err) throw err;
    const io = app.io;

    // Per-socket rate limiting map
    const joinTracker = new Map(); // socketId → { count, resetAt }

    io.on("connection", (socket) => {
        app.log.info(`[Socket] connect ${socket.id.slice(0, 8)}`);

        let currentRoom = null;

        // ── join_queue ─────────────────────────────────────────────────────
        socket.on("join_queue", async () => {
            // Rate limiting
            const now = Date.now();
            let tracker = joinTracker.get(socket.id) || { count: 0, resetAt: now + RATE_WINDOW_MS };
            if (now > tracker.resetAt) tracker = { count: 0, resetAt: now + RATE_WINDOW_MS };
            tracker.count++;
            joinTracker.set(socket.id, tracker);
            if (tracker.count > RATE_MAX_JOINS) {
                socket.emit("error", { message: "Too many requests. Slow down." });
                return;
            }

            const ok = await enqueue(socket.id);
            if (ok) {
                app.log.info(`[Queue] +${socket.id.slice(0, 8)} (len=${usingRedis ? "?" : localQueue.length})`);
                attemptMatch(io);
            }
        });

        // ── leave_room ─────────────────────────────────────────────────────
        socket.on("leave_room", ({ roomId } = {}) => {
            if (!roomId || typeof roomId !== "string") return;
            // Validate roomId format (prevent arbitrary room injection)
            if (!/^room_[a-z0-9_]+$/.test(roomId)) return;
            socket.to(roomId).emit("peer_disconnected");
            socket.leave(roomId);
            currentRoom = null;
        });

        // ── WebRTC signaling (validate types, don't relay raw anything) ────
        socket.on("offer", ({ roomId, offer } = {}) => {
            if (!roomId || !offer || typeof offer !== "object") return;
            if (offer.type !== "offer") return;
            socket.to(roomId).emit("offer", { type: offer.type, sdp: offer.sdp });
        });

        socket.on("answer", ({ roomId, answer } = {}) => {
            if (!roomId || !answer || typeof answer !== "object") return;
            if (answer.type !== "answer") return;
            socket.to(roomId).emit("answer", { type: answer.type, sdp: answer.sdp });
        });

        socket.on("ice_candidate", ({ roomId, candidate } = {}) => {
            if (!roomId || !candidate || typeof candidate !== "object") return;
            socket.to(roomId).emit("ice_candidate", {
                candidate: String(candidate.candidate ?? ""),
                sdpMid: String(candidate.sdpMid ?? ""),
                sdpMLineIndex: Number(candidate.sdpMLineIndex ?? 0),
            });
        });

        socket.on("chat_message", ({ roomId, text } = {}) => {
            if (!roomId || typeof text !== "string") return;
            const safe = text.replace(/[<>]/g, "").slice(0, MAX_MSG);
            if (!safe) return;
            socket.to(roomId).emit("chat_message", { text: safe });
        });

        // ── disconnect ─────────────────────────────────────────────────────
        socket.on("disconnecting", () => {
            for (const room of socket.rooms) {
                if (room !== socket.id) {
                    socket.to(room).emit("peer_disconnected");
                }
            }
        });

        socket.on("disconnect", async (reason) => {
            app.log.info(`[Socket] disconnect ${socket.id.slice(0, 8)} (${reason})`);
            joinTracker.delete(socket.id);
            await removeFromQueue(socket.id);
        });
    });
});

// ─── Health / ICE routes ──────────────────────────────────────────────────
app.get("/health", async () => ({
    status: "ok",
    ts: Date.now(),
    queue: usingRedis ? "redis" : `memory:${localQueue.length}`,
}));

app.get("/ice-config", async () => getIceServers());

// ─── Start ─────────────────────────────────────────────────────────────────
const start = async () => {
    try {
        await app.listen({ port: PORT, host: "0.0.0.0" });
        console.log(`\n🚀  Server ready on port ${PORT}\n`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
