const fastify = require('fastify');
const fastifySocketIO = require('fastify-socket.io');
const cors = require('@fastify/cors');
const Redis = require('ioredis');
const dotenv = require('dotenv');

dotenv.config();

const app = fastify({ logger: true });

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PORT = process.env.PORT || 3001;

// Redis Clients
const redis = new Redis(REDIS_URL, {
    retryStrategy: () => null // Don't retry if connection fails immediately for local dev
});

let usingRedis = true;
const localQueue = [];

redis.on('error', (err) => {
    if (usingRedis) {
        console.warn("Redis connection failed. Switching to in-memory matchmaking.");
        usingRedis = false;
    }
});
const QUEUE_KEY = 'matchmaking:queue';

// Register Plugins
app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST'],
});

app.register(fastifySocketIO, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
    },
});

const getIceServers = () => [
    {
        urls: 'stun:stun.l.google.com:19302',
    },
];

app.ready(err => {
    if (err) throw err;

    const io = app.io;

    // Lua script to atomically pop 2 users if available
    const popPairScript = `
    local len = redis.call("LLEN", KEYS[1])
    if len >= 2 then
      return {redis.call("LPOP", KEYS[1]), redis.call("LPOP", KEYS[1])}
    else
      return nil
    end
  `;

    const attemptMatch = async () => {
        try {
            let result = null;

            if (usingRedis) {
                result = await redis.eval(popPairScript, 1, QUEUE_KEY);
            } else {
                if (localQueue.length >= 2) {
                    result = [localQueue.shift(), localQueue.shift()];
                }
            }

            if (result && result.length === 2 && result[0] && result[1]) {
                const [user1, user2] = result;

                // Get sockets
                const socket1 = io.sockets.sockets.get(user1);
                const socket2 = io.sockets.sockets.get(user2);

                // Handle if one or both users disconnected while in queue
                if (!socket1 && !socket2) {
                    // Both gone, do nothing, try to match next pair if queue not empty
                    if (usingRedis) {
                        if (await redis.llen(QUEUE_KEY) >= 2) attemptMatch();
                    } else {
                        if (localQueue.length >= 2) attemptMatch();
                    }
                    return;
                }

                if (!socket1) {
                    app.log.info(`User ${user1} disconnected during matching. Returning ${user2} to queue.`);
                    if (usingRedis) await redis.lpush(QUEUE_KEY, user2);
                    else localQueue.unshift(user2);
                    attemptMatch();
                    return;
                }

                if (!socket2) {
                    app.log.info(`User ${user2} disconnected during matching. Returning ${user1} to queue.`);
                    if (usingRedis) await redis.lpush(QUEUE_KEY, user1);
                    else localQueue.unshift(user1);
                    attemptMatch();
                    return;
                }

                // Both active - Create Room
                const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const iceServers = getIceServers();

                socket1.join(roomId);
                socket2.join(roomId);

                // Notify Match
                socket1.emit('match_found', { roomId, iceServers, isInitiator: true });
                socket2.emit('match_found', { roomId, iceServers, isInitiator: false });

                app.log.info(`Match created: ${user1} <-> ${user2} in ${roomId}`);
            }
        } catch (error) {
            app.log.error(`Matchmaking error: ${error}`);
        }
    };

    io.on('connection', (socket) => {
        app.log.info(`Socket connected: ${socket.id}`);

        socket.on('join_queue', async () => {
            // Avoid duplicate queue entries
            // Note: This is O(N) but queue is usually short or we use a set + list.
            // For now, strict LPOP/RPUSH logic assumes one entry per socket.
            // We rely on client not spamming 'join_queue'. 
            // Ideally we'd remove previous entry if exists, but LREM is O(N).

            if (usingRedis) {
                await redis.rpush(QUEUE_KEY, socket.id);
            } else {
                // Simple duplicate check
                if (!localQueue.includes(socket.id)) {
                    localQueue.push(socket.id);
                }
            }
            app.log.info(`User ${socket.id} joined queue`);
            attemptMatch();
        });

        socket.on('leave_room', ({ roomId }) => {
            if (roomId) {
                socket.to(roomId).emit('peer_disconnected');
                socket.leave(roomId);
                app.log.info(`User ${socket.id} left room ${roomId}`);
            }
        });

        // WebRTC Signaling
        socket.on('offer', ({ roomId, offer }) => {
            if (roomId) socket.to(roomId).emit('offer', offer);
        });

        socket.on('answer', ({ roomId, answer }) => {
            if (roomId) socket.to(roomId).emit('answer', answer);
        });

        socket.on('ice_candidate', ({ roomId, candidate }) => {
            if (roomId) socket.to(roomId).emit('ice_candidate', candidate);
        });

        socket.on('chat_message', ({ roomId, text }) => {
            if (roomId) socket.to(roomId).emit('chat_message', { text });
        });

        socket.on('disconnecting', () => {
            for (const room of socket.rooms) {
                if (room !== socket.id) {
                    socket.to(room).emit('peer_disconnected');
                }
            }
        });

        socket.on('disconnect', async () => {
            app.log.info(`Socket disconnected: ${socket.id}`);
            if (usingRedis) {
                await redis.lrem(QUEUE_KEY, 0, socket.id);
            } else {
                const idx = localQueue.indexOf(socket.id);
                if (idx !== -1) localQueue.splice(idx, 1);
            }
        });
    });
});

app.get('/ice-config', async (req, reply) => {
    return getIceServers();
});

const start = async () => {
    try {
        await app.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`Server listening on port ${PORT}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
