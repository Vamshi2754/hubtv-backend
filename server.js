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

// ─── Pro Features Config ──────────────────────────────────────────────────
const MAX_STRIKES = 3;
const BAN_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const strikes = new Map(); // IP -> { count, expiresAt }
const interestQueues = new Map(); // interest -> [socketId]

// ─── Group Chat Config ────────────────────────────────────────────────────
const MAX_GROUP_SIZE = 5;
const groupQueue = [];              // waiting group queue
const activeGroups = new Map();     // groupRoomId -> { members: Set<socketId>, locked: boolean }
const socketGroupMap = new Map();   // socketId -> groupRoomId

// ─── Queue helpers ────────────────────────────────────────────────────────
async function enqueue(socketId, interests = []) {
    // If user has interests, add to specific queues
    if (interests.length > 0) {
        interests.forEach(tag => {
            const cleanTag = tag.toLowerCase().trim().slice(0, 20);
            if (!cleanTag) return;
            if (!interestQueues.has(cleanTag)) interestQueues.set(cleanTag, []);
            const q = interestQueues.get(cleanTag);
            if (!q.includes(socketId)) q.push(socketId);
        });
    }

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

async function dequeue(targetSocketId = null) {
    if (usingRedis) {
        // Simple redis pop (doesn't support interest prioritization easily without complex logic)
        const script = `
            local len = redis.call("LLEN", KEYS[1])
            if len >= 2 then
                return {redis.call("LPOP", KEYS[1]), redis.call("LPOP", KEYS[1])}
            end
            return nil
        `;
        return await redis.eval(script, 1, QUEUE_KEY);
    } else {
        // In-memory interest-based matching
        if (localQueue.length < 2) return null;

        // If we want to find a match for a specific socket
        if (targetSocketId) {
            const socketIdx = localQueue.indexOf(targetSocketId);
            if (socketIdx === -1) return null;

            const socket = localQueue[socketIdx];
            // Find its interests
            const interests = [];
            interestQueues.forEach((q, tag) => {
                if (q.includes(socket)) interests.push(tag);
            });

            // Try to find someone in the queue with at least one common interest
            for (let i = 0; i < localQueue.length; i++) {
                const peerId = localQueue[i];
                if (peerId === socket) continue;

                let hasMatch = false;
                for (const tag of interests) {
                    if (interestQueues.get(tag)?.includes(peerId)) {
                        hasMatch = true;
                        break;
                    }
                }

                if (hasMatch) {
                    localQueue.splice(localQueue.indexOf(peerId), 1);
                    localQueue.splice(localQueue.indexOf(socket), 1);
                    return [socket, peerId];
                }
            }
        }

        // Fallback to random match
        return [localQueue.shift(), localQueue.shift()];
    }
}

async function removeFromQueue(socketId) {
    interestQueues.forEach((q, tag) => {
        const i = q.indexOf(socketId);
        if (i !== -1) q.splice(i, 1);
        if (q.length === 0) interestQueues.delete(tag);
    });

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
async function attemptMatch(io, triggerSocketId = null) {
    try {
        const pair = await dequeue(triggerSocketId);
        if (!pair || pair.length < 2) return;

        const [id1, id2] = pair;
        const s1 = io.sockets.sockets.get(id1);
        const s2 = io.sockets.sockets.get(id2);

        if (!s1 && !s2) {
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

// ─── Group Leave Helper ───────────────────────────────────────────────────
function handleGroupLeave(socket, groupId, io) {
    const group = activeGroups.get(groupId);
    if (!group) return;

    group.members.delete(socket.id);
    socketGroupMap.delete(socket.id);
    socket.leave(groupId);

    // Notify remaining members
    io.to(groupId).emit("group_member_left", {
        memberId: socket.id,
        members: Array.from(group.members)
    });

    app.log.info(`[Group] ${socket.id.slice(0, 6)} left ${groupId} (${group.members.size} remaining)`);

    // If group is empty, delete it
    if (group.members.size === 0) {
        activeGroups.delete(groupId);
        app.log.info(`[Group] ${groupId} dissolved (empty)`);
    } else if (group.locked && group.members.size < MAX_GROUP_SIZE) {
        // Unlock if someone left a full group
        group.locked = false;
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
        const userIp = socket.handshake.address;

        // ── join_queue ─────────────────────────────────────────────────────
        socket.on("join_queue", async ({ interests = [] } = {}) => {
            // 🚫 Check for bans
            const banInfo = strikes.get(userIp);
            if (banInfo && banInfo.count >= MAX_STRIKES) {
                if (Date.now() < banInfo.expiresAt) {
                    const remainingHours = Math.ceil((banInfo.expiresAt - Date.now()) / (1000 * 60 * 60));
                    socket.emit("error", { message: `You are banned for ${remainingHours} more hours due to multiple reports.` });
                    return;
                } else {
                    strikes.delete(userIp); // ban expired
                }
            }

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

            const ok = await enqueue(socket.id, Array.isArray(interests) ? interests : []);
            if (ok) {
                app.log.info(`[Queue] +${socket.id.slice(0, 8)} (int=${interests.join(",")})`);
                attemptMatch(io, socket.id);
            }
        });

        // ── leave_room ─────────────────────────────────────────────────────
        socket.on("leave_room", ({ roomId } = {}) => {
            if (!roomId || typeof roomId !== "string") return;
            if (!/^room_[a-z0-9_]+$/.test(roomId)) return;
            socket.to(roomId).emit("peer_disconnected");
            socket.leave(roomId);
        });

        // ── WebRTC signaling ──────────────────────────────────────────────
        socket.on("offer", ({ roomId, offer } = {}) => {
            if (!roomId || !offer || typeof offer !== "object") return;
            socket.to(roomId).emit("offer", { type: offer.type, sdp: offer.sdp });
        });

        socket.on("answer", ({ roomId, answer } = {}) => {
            if (!roomId || !answer || typeof answer !== "object") return;
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

        // ── PRO: Typing Indicators ─────────────────────────────────────────
        socket.on("typing_start", ({ roomId } = {}) => {
            if (roomId) socket.to(roomId).emit("typing_start");
        });
        socket.on("typing_stop", ({ roomId } = {}) => {
            if (roomId) socket.to(roomId).emit("typing_stop");
        });

        // ── PRO: Reporting ─────────────────────────────────────────────────
        socket.on("report_peer", ({ roomId } = {}) => {
            if (!roomId) return;
            // Find the other person in the room
            const roomSockets = io.sockets.adapter.rooms.get(roomId);
            if (!roomSockets) return;

            let peerSocket = null;
            for (const id of roomSockets) {
                if (id !== socket.id) {
                    peerSocket = io.sockets.sockets.get(id);
                    break;
                }
            }

            if (peerSocket) {
                const peerIp = peerSocket.handshake.address;
                const info = strikes.get(peerIp) || { count: 0, expiresAt: 0 };
                info.count++;
                if (info.count >= MAX_STRIKES) {
                    info.expiresAt = Date.now() + BAN_DURATION;
                    peerSocket.emit("error", { message: "You have been banned for 24 hours due to multiple reports." });
                    peerSocket.disconnect();
                }
                strikes.set(peerIp, info);
                socket.emit("report_success", { message: "User reported. We take this seriously." });
                app.log.warn(`[Report] User ${peerIp} strikes: ${info.count}`);
            }
        });

        // ── PRO: Group Video Chat ─────────────────────────────────────────
        socket.on("join_group", () => {
            // Ban check
            const banInfo = strikes.get(userIp);
            if (banInfo && banInfo.count >= MAX_STRIKES) {
                if (Date.now() < banInfo.expiresAt) {
                    socket.emit("error", { message: `You are banned.` });
                    return;
                } else {
                    strikes.delete(userIp);
                }
            }

            // Find an active group that isn't full yet
            let assignedGroup = null;
            for (const [groupId, group] of activeGroups) {
                if (!group.locked && group.members.size < MAX_GROUP_SIZE) {
                    assignedGroup = groupId;
                    break;
                }
            }

            if (!assignedGroup) {
                // Create a new group
                assignedGroup = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
                activeGroups.set(assignedGroup, { members: new Set(), locked: false });
                app.log.info(`[Group] Created ${assignedGroup}`);
            }

            const group = activeGroups.get(assignedGroup);
            group.members.add(socket.id);
            socketGroupMap.set(socket.id, assignedGroup);
            socket.join(assignedGroup);

            const iceServers = getIceServers();
            const memberList = Array.from(group.members);

            // Tell the new member about the group
            socket.emit("group_joined", {
                groupId: assignedGroup,
                members: memberList,
                iceServers,
                you: socket.id
            });

            // Notify existing members about the new member
            socket.to(assignedGroup).emit("group_member_joined", {
                memberId: socket.id,
                members: memberList,
                iceServers
            });

            app.log.info(`[Group] ${socket.id.slice(0, 6)} joined ${assignedGroup} (${group.members.size}/${MAX_GROUP_SIZE})`);

            // If group is now full, lock it
            if (group.members.size >= MAX_GROUP_SIZE) {
                group.locked = true;
                io.to(assignedGroup).emit("group_full", { groupId: assignedGroup });
                app.log.info(`[Group] ${assignedGroup} is FULL and locked`);
            }
        });

        socket.on("leave_group", () => {
            const groupId = socketGroupMap.get(socket.id);
            if (!groupId) return;
            handleGroupLeave(socket, groupId, io);
        });

        // Group WebRTC signaling (targeted to specific peer within group)
        socket.on("group_offer", ({ groupId, targetId, offer } = {}) => {
            if (!groupId || !targetId || !offer) return;
            const target = io.sockets.sockets.get(targetId);
            if (target) target.emit("group_offer", { senderId: socket.id, offer });
        });

        socket.on("group_answer", ({ groupId, targetId, answer } = {}) => {
            if (!groupId || !targetId || !answer) return;
            const target = io.sockets.sockets.get(targetId);
            if (target) target.emit("group_answer", { senderId: socket.id, answer });
        });

        socket.on("group_ice_candidate", ({ groupId, targetId, candidate } = {}) => {
            if (!groupId || !targetId || !candidate) return;
            const target = io.sockets.sockets.get(targetId);
            if (target) target.emit("group_ice_candidate", {
                senderId: socket.id,
                candidate: String(candidate.candidate ?? ""),
                sdpMid: String(candidate.sdpMid ?? ""),
                sdpMLineIndex: Number(candidate.sdpMLineIndex ?? 0),
            });
        });

        socket.on("group_chat_message", ({ groupId, text } = {}) => {
            if (!groupId || typeof text !== "string") return;
            const safe = text.replace(/[<>]/g, "").slice(0, MAX_MSG);
            if (!safe) return;
            socket.to(groupId).emit("group_chat_message", { senderId: socket.id, text: safe });
        });

        // ── disconnect ─────────────────────────────────────────────────────
        socket.on("disconnecting", () => {
            for (const room of socket.rooms) {
                if (room !== socket.id) {
                    if (room.startsWith("group_")) {
                        // Group disconnect handled separately
                    } else {
                        socket.to(room).emit("peer_disconnected");
                    }
                }
            }
        });

        socket.on("disconnect", async (reason) => {
            app.log.info(`[Socket] disconnect ${socket.id.slice(0, 8)} (${reason})`);
            joinTracker.delete(socket.id);
            await removeFromQueue(socket.id);

            // Handle group cleanup
            const groupId = socketGroupMap.get(socket.id);
            if (groupId) {
                handleGroupLeave(socket, groupId, io);
            }
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
