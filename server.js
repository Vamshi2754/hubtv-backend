const fastify = require("fastify");
const fastifySocketIO = require("fastify-socket.io");
const cors = require("@fastify/cors");
const Redis = require("ioredis");
const fs = require("fs");
const path = require("path");
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
    if (process.env.TURN_URL && process.env.TURN_USER && process.env.TURN_CRED) {
        servers.push({
            urls: process.env.TURN_URL,
            username: process.env.TURN_USER,
            credential: process.env.TURN_CRED,
        });
    }
    return servers;
}


// ═══════════════════════════════════════════════════════════════════════════
// ███  SECURITY MODULE — ANTI-ABUSE & WOMEN SAFETY SYSTEM  ███
// ═══════════════════════════════════════════════════════════════════════════

// ─── Persistent Ban Storage ───────────────────────────────────────────────
const BAN_FILE = path.join(__dirname, "bans.json");
const REPORT_LOG_FILE = path.join(__dirname, "reports.json");

function loadJSON(filePath, fallback = {}) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, "utf-8"));
        }
    } catch (e) {
        console.warn(`[Security] Failed to load ${filePath}:`, e.message);
    }
    return fallback;
}

function saveJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
        console.warn(`[Security] Failed to save ${filePath}:`, e.message);
    }
}

// Ban data: { ip: { count, expiresAt, permanent, reason } }
let banData = loadJSON(BAN_FILE, {});
let reportLog = loadJSON(REPORT_LOG_FILE, []);

// Auto-save bans every 30 seconds
setInterval(() => { saveJSON(BAN_FILE, banData); }, 30_000);

// Chat strike tracking: socketId -> { count, mutedUntil }
const chatStrikes = new Map();
// Report cooldowns: socketId -> lastReportTime
const reportCooldowns = new Map();
// Socket-to-IP mapping
const socketIpMap = new Map();

// ─── Ban Duration Escalation ──────────────────────────────────────────────
const BAN_ESCALATION = [
    1 * 60 * 60 * 1000,         // 1st offense: 1 hour
    6 * 60 * 60 * 1000,         // 2nd offense: 6 hours
    24 * 60 * 60 * 1000,        // 3rd offense: 24 hours
    7 * 24 * 60 * 60 * 1000,    // 4th offense: 7 days
    0                            // 5th offense: permanent (0 = infinite)
];

function getBanDuration(offenseCount) {
    const idx = Math.min(offenseCount - 1, BAN_ESCALATION.length - 1);
    return BAN_ESCALATION[idx];
}

function isUserBanned(ip) {
    const ban = banData[ip];
    if (!ban) return { banned: false };
    if (ban.permanent) return { banned: true, permanent: true, reason: ban.reason };
    if (ban.expiresAt && Date.now() < ban.expiresAt) {
        const remainMs = ban.expiresAt - Date.now();
        const hours = Math.ceil(remainMs / (1000 * 60 * 60));
        return { banned: true, hours, reason: ban.reason };
    }
    // Ban expired — keep offense count but remove active ban
    if (ban.expiresAt && Date.now() >= ban.expiresAt) {
        ban.expiresAt = 0;
    }
    return { banned: false };
}

function banUser(ip, reason = "violation") {
    const existing = banData[ip] || { count: 0, expiresAt: 0, permanent: false, reason: "" };
    existing.count++;
    existing.reason = reason;

    const duration = getBanDuration(existing.count);
    if (duration === 0) {
        existing.permanent = true;
        existing.expiresAt = 0;
    } else {
        existing.expiresAt = Date.now() + duration;
    }

    banData[ip] = existing;
    saveJSON(BAN_FILE, banData);

    console.warn(`[BAN] IP ${ip} banned. Offense #${existing.count}. Reason: ${reason}. ${existing.permanent ? "PERMANENT" : `Until ${new Date(existing.expiresAt).toISOString()}`}`);
    return existing;
}


// ═══════════════════════════════════════════════════════════════════════════
// ███  MULTI-LANGUAGE PROFANITY FILTER  ███
// ═══════════════════════════════════════════════════════════════════════════

// ─── PROFANITY FILTER ───────────────────────────────────────────────────
const PROFANITY_WORDS = [
    // ── ENGLISH (Comprehensive) ──
    "fuck", "fucker", "fucking", "fucked", "fck", "f u c k", "fuk", "phuck", "phuk", "f*ck", "f_u_c_k",
    "shit", "shitty", "bullshit", "shite", "sh1t", "s_h_i_t",
    "bitch", "b1tch", "biatch", "btch",
    "ass", "asshole", "arsehole", "arse", "a$$", "a$$h0le",
    "dick", "d1ck", "dck", "penis", "peen", "phallus",
    "cock", "c0ck", "knob", "bollocks",
    "pussy", "puss", "pu$$y", "vagina", "cunt", "kunt", "twat", "coochie", "cooch",
    "whore", "wh0re", "hoe", "slut", "sl*t", "skank", "prostitute",
    "bastard", "b@stard", "motherfucker", "mf", "mofo",
    "nigger", "n1gger", "nigga", "n1gga", "coon", "spic", "chink", "kike", "fag", "faggot", "queer",
    "retard", "retarded", "mongoloid",
    "rape", "rapist", "raping", "sexual", "molest",
    "nude", "nudes", "naked", "topless", "bottomless",
    "boobs", "boob", "tits", "titties", "jugs", "breasts",
    "cum", "cumming", "ejaculate", "sperm", "jizz",
    "sex", "sexy", "sexting", "horny", "h0rny", "hardon", "erection",
    "masturbat", "wank", "jerking off", "jack off",
    "porn", "p0rn", "porno", "xxx", "xvideos", "pornhub",
    "dildo", "vibrator", "anal", "bondage", "bdsm",
    "stfu", "kys", "die", "kill yourself",

    // ── HINDI / URDU / PUNJABI ──
    "madarchod", "mc", "madarc", "bhenchod", "bc", "behenchod", "behen k lode",
    "chutiya", "chutiye", "chut", "lund", "lauda", "lavde", "lavda", "lande", "landu",
    "gaand", "gand", "gandu", "bhosdike", "bhosdiwale", "bhosdi", "bhosada",
    "randi", "raand", "rand", "randwa", "kasbi",
    "harami", "haramkhor", "haram", "najaayaz",
    "kutte", "kutta", "kutiya", "kutia", "doggy",
    "sala", "saala", "saale", "saali",
    "tatte", "tatti", "hagga", "moot", "mutra",
    "jhant", "jhatu", "baal",
    "chod", "chodu", "chodna", "chudai",
    "bhadwa", "bhadwe", "dalal",
    "kamina", "kamine", "kameena", "badmaash",
    "suar", "suwar", "pig",
    "hijra", "chakka", "meetha",
    "behenchod", "penchoda", "lun", "kanjar", "lulli",

    // ── TELUGU ──
    "dengey", "dengu", "dengulata", "dengadu", "dengaku",
    "puku", "pukulo", "pukuna", "pooku", "pookulo",
    "modda", "moddala", "modda guddu", "moddalo",
    "lanja", "lanjakodaka", "lanjakoduku", "lanjaa", "lanja munda",
    "gudda", "gudda lo", "guddala",
    "sulli", "sulla", "sullilo",
    "erripuku", "erri puku", "vp",
    "donga", "donga koduku",
    "yedava", "yedavada", "vedhava",
    "nakodaka", "na kodaka", "nee amma", "deenamma", "amma neekuda",
    "dhoola", "bokka", "bokkalo",

    // ── TAMIL ──
    "thevdiya", "thevadiya", "thevidiya", "ommala", "omala", "otha",
    "pundai", "punda", "pundek", "sunni", "sunniya", "koothi", "kuthi",
    "myiru", "mayiru", "mayir", "lavadai", "oolu", "baadu",
    "vesai", "vesa", "loosu", "thayoli", "thayolee", "naaye", "naai",

    // ── KANNADA ──
    "sule", "sulemaga", "sulemagne", "bosudi", "bosudike", "tika", "tunne", "tullu",

    // ── MALAYALAM ──
    "myiru", "myre", "myran", "thayoli", "poori", "kunna", "patti", "thendi", "kandaroli", "andi",

    // ── BENGALI ──
    "choto lokh", "bal chhire", "boka choda", "magi", "shala", "nangta", "khanki", "khankir pola",

    // ── MARATHI / GUJARATI ──
    "zavade", "zavadi", "lavadya", "ghe", "maichya", "baichya", "gaandit", "chidya",
    "gando", "loda", "lodaloda", "gaandma",

    // ── SPANISH ──
    "puta", "puto", "hijo de puta", "mierda", "coño", "verga", "pendejo", "cabron", "cabrón",
    "culo", "pinche", "chingar", "chinga", "maricon", "joder", "zorra", "estupido", "boludo",
    "pajero", "concha", "culero", "mamon",

    // ── PORTUGUESE ──
    "porra", "caralho", "foda", "foda-se", "merda", "buceta", "filho da puta", "viado", "otario",
    "arrombado", "cu", "pau", "cacete", "vaca", "rapariga",

    // ── FRENCH ──
    "putain", "merde", "salope", "connard", "enculé", "fils de pute", "bordel", "pute", "chiant",
    "con", "garce", "bite", "couille",

    // ── GERMAN ──
    "scheisse", "scheiße", "arschloch", "fotze", "wichser", "hurensohn", "schlampe", "fick", "mist",
    "kacke", "penner", "sau",

    // ── ITALIAN ──
    "cazzo", "merda", "vaffanculo", "stronzo", "puttana", "troia", "bastardo", "minchia", "coglione",
    "fica", "finocchio",

    // ── TURKISH ──
    "amk", "aq", "amına koyayım", "oç", "piç", "siktir", "sikiş", "göt", "yavşak", "orospu", "yarrak",
    "taşak", "meme", "sik",

    // ── RUSSIAN (Cyrillic + Romanized) ──
    "suka", "blyat", "pizda", "hui", "khui", "ebat", "zalupa", "govno", "mudak", "chmo",
    "сука", "блять", "пизда", "хуй", "ебать", "залупа", "говно", "мудак", "чмо", "член",

    // ── ARABIC (Script + Romanized) ──
    "sharmuta", "sharmouta", "kos omak", "kuss", "khara", "kalb", "homar", "ayri", "sharmit",
    "شرموطة", "كس", "خرى", "כלב", "حمار", "قحبة", "طيز", "زب", "نيك",

    // ── CHINESE (Pinyin) ──
    "caonima", "cao ni ma", "sb", "shabi", "erbi", "gun", "wangba", "ben dan",

    // ── JAPANESE (Romaji) ──
    "baka", "ahou", "kuso", "yarou", "shinet", "kimochi", "hentai", "ecchi",

    // ── INDONESIAN / MALAY ──
    "anjing", "babi", "bangsat", "kontol", "memek", "puki", "pantat", "setan", "tolol", "goblok",

    // ── TAGALOG ──
    "putang ina", "bobot", "ulol", "gago", "tarantado", "pota",

    // ── Common harassment phrases (multi-language/global) ──
    "show me", "remove clothes", "take off", "strip for me", "show face", "open camera",
    "kapde utaro", "nangi ho ja", "dikhao", "dikhau", "nude pic", "nude photo",
    "cheppey", "chupichu", "kanipinchu", "kuch dikhao",
    "come to my room", "private chat", "meet me", "f2f", "cam 2 cam", "c2c",
    "age kya hai", "age what", "asl", "your age", "how old", "u girl", "r u girl",
    "gf banja", "be my gf", "boyfriend", "gf", "bf",
    "video call karo", "call karo", "number do", "whatsapp number", "insta id",
    "send pic", "send photo", "dp bhejo", "pic bhejo", "photo bhejo",
    "i love you", "iloveyou", "i like you", "marry me", "blowjob", "bj",
    "hot girl", "naughty", "dirty talk", "let's talk", "hookup",
];

// Build optimized lookup structures
const EXACT_WORDS = new Set();
const PHRASE_PATTERNS = [];

PROFANITY_WORDS.forEach(word => {
    const lower = word.toLowerCase().trim();
    if (lower.includes(" ")) {
        // Multi-word phrase — check as substring
        PHRASE_PATTERNS.push(lower);
    } else {
        EXACT_WORDS.add(lower);
    }
});

// Leet-speak normalization map
const LEET_MAP = {
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
    "7": "t", "8": "b", "@": "a", "$": "s", "!": "i",
    "*": "", " ": "",
};

function normalizeLeet(text) {
    let result = "";
    for (const ch of text.toLowerCase()) {
        result += LEET_MAP[ch] || ch;
    }
    return result;
}

/**
 * Check if a message contains profanity.
 * Returns { isAbusive: boolean, matchedWord: string|null }
 */
function checkProfanity(text) {
    if (!text || typeof text !== "string") return { isAbusive: false, matchedWord: null };

    const lower = text.toLowerCase().trim();
    const normalized = normalizeLeet(lower);

    // 1. Check phrases in original text
    for (const phrase of PHRASE_PATTERNS) {
        if (lower.includes(phrase)) {
            return { isAbusive: true, matchedWord: phrase };
        }
        // Also check normalized
        const normalizedPhrase = normalizeLeet(phrase);
        if (normalized.includes(normalizedPhrase)) {
            return { isAbusive: true, matchedWord: phrase };
        }
    }

    // 2. Split into words and check exact matches
    // Split on whitespace, punctuation, and common separators
    const words = lower.split(/[\s,.\-_!?;:'"()\[\]{}|/\\@#$%^&*+=~`]+/).filter(Boolean);
    const normalizedWords = normalized.split(/[\s,.\-_!?;:'"()\[\]{}|/\\@#$%^&*+=~`]+/).filter(Boolean);

    for (const word of words) {
        if (EXACT_WORDS.has(word)) {
            return { isAbusive: true, matchedWord: word };
        }
    }

    for (const word of normalizedWords) {
        if (EXACT_WORDS.has(word)) {
            return { isAbusive: true, matchedWord: `(normalized) ${word}` };
        }
    }

    // 3. Check for partial matches (words embedded in larger words)
    // Only for words >= 4 chars to avoid false positives
    for (const badWord of EXACT_WORDS) {
        if (badWord.length >= 4 && lower.includes(badWord)) {
            return { isAbusive: true, matchedWord: badWord };
        }
        if (badWord.length >= 4 && normalized.includes(badWord)) {
            return { isAbusive: true, matchedWord: `(normalized) ${badWord}` };
        }
    }

    return { isAbusive: false, matchedWord: null };
}

// ─── Chat Strike System ──────────────────────────────────────────────────
const MUTE_DURATION = 5 * 60 * 1000;       // 5 minutes mute
const STRIKES_TO_MUTE = 3;
const STRIKES_TO_BAN = 5;

function handleChatStrike(socketId, ip, io) {
    const strikes = chatStrikes.get(socketId) || { count: 0, mutedUntil: 0 };
    strikes.count++;
    chatStrikes.set(socketId, strikes);

    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return;

    if (strikes.count >= STRIKES_TO_BAN) {
        // Auto-ban
        const banInfo = banUser(ip, "Repeated abusive messages");
        socket.emit("user_banned", {
            message: banInfo.permanent
                ? "You have been permanently banned for repeated violations."
                : `You have been banned for repeated violations. Ban expires in ${Math.ceil(getBanDuration(banInfo.count) / (1000 * 60 * 60))} hours.`
        });
        socket.disconnect(true);
        console.warn(`[AUTOBAN] Socket ${socketId.slice(0, 8)} (IP: ${ip}) auto-banned for ${strikes.count} chat strikes.`);
    } else if (strikes.count >= STRIKES_TO_MUTE) {
        // Auto-mute
        strikes.mutedUntil = Date.now() + MUTE_DURATION;
        chatStrikes.set(socketId, strikes);
        socket.emit("user_muted", {
            message: `You have been muted for ${MUTE_DURATION / 60000} minutes due to abusive language. ${STRIKES_TO_BAN - strikes.count} more violations will result in a ban.`,
            mutedUntil: strikes.mutedUntil
        });
        console.warn(`[MUTE] Socket ${socketId.slice(0, 8)} muted. Strikes: ${strikes.count}`);
    } else {
        socket.emit("message_blocked", {
            message: `Your message was blocked for inappropriate content. Warning ${strikes.count}/${STRIKES_TO_MUTE}. Continued violations will result in a mute and then a ban.`,
            warningCount: strikes.count,
            maxWarnings: STRIKES_TO_BAN
        });
    }
}

function isUserMuted(socketId) {
    const strikes = chatStrikes.get(socketId);
    if (!strikes || !strikes.mutedUntil) return false;
    if (Date.now() < strikes.mutedUntil) return true;
    strikes.mutedUntil = 0; // mute expired
    return false;
}


// ─── Report System ────────────────────────────────────────────────────────
const REPORT_COOLDOWN = 30_000;  // 30 seconds between reports
const REPORTS_TO_AUTO_BAN = 3;   // reports from different users

// Track reports per user: ip -> Set of reporter IPs
const reportTracker = new Map();

function handleReport(reporterSocket, peerSocket, reason, io) {
    if (!peerSocket) return { success: false, message: "User not found." };

    const reporterId = reporterSocket.id;
    const reporterIp = socketIpMap.get(reporterId);
    const peerIp = socketIpMap.get(peerSocket.id);

    // Cooldown check
    const lastReport = reportCooldowns.get(reporterId);
    if (lastReport && Date.now() - lastReport < REPORT_COOLDOWN) {
        return { success: false, message: "Please wait before reporting again." };
    }
    reportCooldowns.set(reporterId, Date.now());

    // Track unique reports against this IP
    if (!reportTracker.has(peerIp)) reportTracker.set(peerIp, new Set());
    const reporters = reportTracker.get(peerIp);
    reporters.add(reporterIp);

    // Log report
    const reportEntry = {
        timestamp: new Date().toISOString(),
        reportedIp: peerIp,
        reportedSocketId: peerSocket.id.slice(0, 8),
        reporterIp: reporterIp,
        reporterSocketId: reporterId.slice(0, 8),
        reason: reason || "unspecified",
        totalUniqueReports: reporters.size
    };
    reportLog.push(reportEntry);

    // Save reports periodically (trimming to last 10000)
    if (reportLog.length > 10000) reportLog = reportLog.slice(-5000);
    saveJSON(REPORT_LOG_FILE, reportLog);

    console.warn(`[REPORT] ${reporterIp} reported ${peerIp} for: ${reason}. Total unique reports: ${reporters.size}`);

    // Auto-ban if enough unique reports
    if (reporters.size >= REPORTS_TO_AUTO_BAN) {
        const banInfo = banUser(peerIp, `Multiple user reports: ${reason}`);
        peerSocket.emit("user_banned", {
            message: banInfo.permanent
                ? "You have been permanently banned due to multiple reports."
                : `You have been banned due to multiple reports. You can try again later.`
        });
        peerSocket.disconnect(true);
        reportTracker.delete(peerIp);
        return { success: true, message: "User has been banned. Thank you for keeping the community safe." };
    }

    // Always disconnect the reported user from the current session
    peerSocket.emit("reported_warning", {
        message: `You have been reported for: ${reason}. Please be respectful. ${REPORTS_TO_AUTO_BAN - reporters.size} more reports will result in a ban.`,
        reason
    });

    return { success: true, message: "User reported successfully. Thank you for helping keep the community safe." };
}


// ─── Interest Queue Structures ────────────────────────────────────────────
const interestQueues = new Map(); // interest -> [socketId]

// ─── Group Chat Config ────────────────────────────────────────────────────
const MAX_GROUP_SIZE = 5;
const groupQueue = [];
const activeGroups = new Map();
const socketGroupMap = new Map();

// ─── Queue helpers ────────────────────────────────────────────────────────
async function enqueue(socketId, interests = []) {
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

        if (targetSocketId) {
            const socketIdx = localQueue.indexOf(targetSocketId);
            if (socketIdx === -1) return null;
            const socket = localQueue[socketIdx];
            const interests = [];
            interestQueues.forEach((q, tag) => {
                if (q.includes(socket)) interests.push(tag);
            });
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

    io.to(groupId).emit("group_member_left", {
        memberId: socket.id,
        members: Array.from(group.members)
    });

    app.log.info(`[Group] ${socket.id.slice(0, 6)} left ${groupId} (${group.members.size} remaining)`);

    if (group.members.size === 0) {
        activeGroups.delete(groupId);
        app.log.info(`[Group] ${groupId} dissolved (empty)`);
    } else if (group.locked && group.members.size < MAX_GROUP_SIZE) {
        group.locked = false;
    }
}


// ═══════════════════════════════════════════════════════════════════════════
// ███  SOCKET HANDLERS (WITH SECURITY)  ███
// ═══════════════════════════════════════════════════════════════════════════

app.ready((err) => {
    if (err) throw err;
    const io = app.io;
    const joinTracker = new Map();

    io.on("connection", (socket) => {
        app.log.info(`[Socket] connect ${socket.id.slice(0, 8)}`);
        const userIp = socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim()
            || socket.handshake.address;
        socketIpMap.set(socket.id, userIp);

        // ── SECURITY: Check ban on connection ──────────────────────────────
        const banCheck = isUserBanned(userIp);
        if (banCheck.banned) {
            const msg = banCheck.permanent
                ? "You are permanently banned from this platform."
                : `You are banned for ${banCheck.hours} more hour(s). Reason: ${banCheck.reason || "policy violation"}.`;
            socket.emit("user_banned", { message: msg });
            socket.disconnect(true);
            app.log.warn(`[Security] Banned user attempted connection: ${userIp}`);
            return;
        }

        // ── join_queue ─────────────────────────────────────────────────────
        socket.on("join_queue", async ({ interests = [] } = {}) => {
            // Ban check
            const banInfo = isUserBanned(userIp);
            if (banInfo.banned) {
                const msg = banInfo.permanent
                    ? "You are permanently banned."
                    : `You are banned for ${banInfo.hours} more hour(s).`;
                socket.emit("user_banned", { message: msg });
                return;
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

        // ── SECURE CHAT MESSAGE (with profanity filter) ───────────────────
        socket.on("chat_message", ({ roomId, text } = {}) => {
            if (!roomId || typeof text !== "string") return;
            const safe = text.replace(/[<>]/g, "").slice(0, MAX_MSG);
            if (!safe) return;

            // Check if user is muted
            if (isUserMuted(socket.id)) {
                const strikes = chatStrikes.get(socket.id);
                const remaining = Math.ceil((strikes.mutedUntil - Date.now()) / 60000);
                socket.emit("message_blocked", {
                    message: `You are muted for ${remaining} more minute(s).`,
                    warningCount: strikes.count,
                    maxWarnings: STRIKES_TO_BAN
                });
                return;
            }

            // Profanity check
            const profanityResult = checkProfanity(safe);
            if (profanityResult.isAbusive) {
                app.log.warn(`[PROFANITY] Blocked message from ${socket.id.slice(0, 8)}: "${safe.slice(0, 50)}" (matched: ${profanityResult.matchedWord})`);
                handleChatStrike(socket.id, userIp, io);
                return; // DO NOT relay the message
            }

            // Message is clean — relay it
            socket.to(roomId).emit("chat_message", { text: safe });
        });

        // ── Typing Indicators ─────────────────────────────────────────────
        socket.on("typing_start", ({ roomId } = {}) => {
            if (roomId) socket.to(roomId).emit("typing_start");
        });
        socket.on("typing_stop", ({ roomId } = {}) => {
            if (roomId) socket.to(roomId).emit("typing_stop");
        });

        // ── SECURE REPORTING (with reason & categories) ───────────────────
        socket.on("report_peer", ({ roomId, reason = "unspecified" } = {}) => {
            if (!roomId) return;

            // Validate reason
            const validReasons = ["harassment", "nudity", "abusive_language", "spam", "inappropriate_behavior", "unspecified"];
            const cleanReason = validReasons.includes(reason) ? reason : "unspecified";

            // Find the peer in the room
            const roomSockets = io.sockets.adapter.rooms.get(roomId);
            if (!roomSockets) return;

            let peerSocket = null;
            for (const id of roomSockets) {
                if (id !== socket.id) {
                    peerSocket = io.sockets.sockets.get(id);
                    break;
                }
            }

            const result = handleReport(socket, peerSocket, cleanReason, io);
            socket.emit("report_success", { message: result.message });
        });

        // ── NSFW auto-report from client ──────────────────────────────────
        socket.on("nsfw_detected", ({ roomId } = {}) => {
            if (!roomId) return;
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
                const peerIp = socketIpMap.get(peerSocket.id);
                if (peerIp) {
                    const result = handleReport(socket, peerSocket, "nudity", io);
                    app.log.warn(`[NSFW] Auto-report for ${peerIp}. Result: ${result.message}`);
                }
            }
        });

        // ── Group Video Chat ─────────────────────────────────────────────
        socket.on("join_group", () => {
            const banInfo = isUserBanned(userIp);
            if (banInfo.banned) {
                const msg = banInfo.permanent
                    ? "You are permanently banned."
                    : `You are banned for ${banInfo.hours} more hour(s).`;
                socket.emit("user_banned", { message: msg });
                return;
            }

            let assignedGroup = null;
            for (const [groupId, group] of activeGroups) {
                if (!group.locked && group.members.size < MAX_GROUP_SIZE) {
                    assignedGroup = groupId;
                    break;
                }
            }

            if (!assignedGroup) {
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

            socket.emit("group_joined", {
                groupId: assignedGroup,
                members: memberList,
                iceServers,
                you: socket.id
            });

            socket.to(assignedGroup).emit("group_member_joined", {
                memberId: socket.id,
                members: memberList,
                iceServers
            });

            app.log.info(`[Group] ${socket.id.slice(0, 6)} joined ${assignedGroup} (${group.members.size}/${MAX_GROUP_SIZE})`);

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

        // Group WebRTC signaling
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

        // ── SECURE GROUP CHAT (with profanity filter) ─────────────────────
        socket.on("group_chat_message", ({ groupId, text } = {}) => {
            if (!groupId || typeof text !== "string") return;
            const safe = text.replace(/[<>]/g, "").slice(0, MAX_MSG);
            if (!safe) return;

            // Check mute
            if (isUserMuted(socket.id)) {
                const strikes = chatStrikes.get(socket.id);
                const remaining = Math.ceil((strikes.mutedUntil - Date.now()) / 60000);
                socket.emit("message_blocked", {
                    message: `You are muted for ${remaining} more minute(s).`,
                    warningCount: strikes.count,
                    maxWarnings: STRIKES_TO_BAN
                });
                return;
            }

            // Profanity check
            const profanityResult = checkProfanity(safe);
            if (profanityResult.isAbusive) {
                app.log.warn(`[PROFANITY/GROUP] Blocked message from ${socket.id.slice(0, 8)}: "${safe.slice(0, 50)}"`);
                handleChatStrike(socket.id, userIp, io);
                return;
            }

            socket.to(groupId).emit("group_chat_message", { senderId: socket.id, text: safe });
        });

        // ── Report in Group ───────────────────────────────────────────────
        socket.on("report_group_member", ({ groupId, targetId, reason = "unspecified" } = {}) => {
            if (!groupId || !targetId) return;
            const validReasons = ["harassment", "nudity", "abusive_language", "spam", "inappropriate_behavior", "unspecified"];
            const cleanReason = validReasons.includes(reason) ? reason : "unspecified";

            const peerSocket = io.sockets.sockets.get(targetId);
            const result = handleReport(socket, peerSocket, cleanReason, io);
            socket.emit("report_success", { message: result.message });
        });

        // ── disconnect ─────────────────────────────────────────────────────
        socket.on("disconnecting", () => {
            for (const room of socket.rooms) {
                if (room !== socket.id) {
                    if (room.startsWith("group_")) {
                        // handled in disconnect
                    } else {
                        socket.to(room).emit("peer_disconnected");
                    }
                }
            }
        });

        socket.on("disconnect", async (reason) => {
            app.log.info(`[Socket] disconnect ${socket.id.slice(0, 8)} (${reason})`);
            joinTracker.delete(socket.id);
            chatStrikes.delete(socket.id);
            reportCooldowns.delete(socket.id);
            socketIpMap.delete(socket.id);
            await removeFromQueue(socket.id);

            const groupId = socketGroupMap.get(socket.id);
            if (groupId) {
                handleGroupLeave(socket, groupId, io);
            }
        });
    });
});

// ─── Health / ICE / Admin routes ──────────────────────────────────────────
app.get("/health", async () => ({
    status: "ok",
    ts: Date.now(),
    queue: usingRedis ? "redis" : `memory:${localQueue.length}`,
    activeBans: Object.keys(banData).length,
    reportsLogged: reportLog.length,
}));

app.get("/ice-config", async () => getIceServers());

// ─── Start ─────────────────────────────────────────────────────────────────
const start = async () => {
    try {
        await app.listen({ port: PORT, host: "0.0.0.0" });
        console.log(`\n🚀  Server ready on port ${PORT}`);
        console.log(`🛡️  Security module loaded: ${EXACT_WORDS.size} blocked words, ${PHRASE_PATTERNS.length} blocked phrases`);
        console.log(`🔒  Active bans: ${Object.keys(banData).length}`);
        console.log(`📊  Reports logged: ${reportLog.length}\n`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
