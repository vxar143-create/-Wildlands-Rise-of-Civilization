"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");

// ==========================================
// НАЛАШТУВАННЯ
// ==========================================

const PORT = Number(process.env.PORT || 3000);

const DATA_DIR = fs.existsSync("/var/data")
    ? "/var/data"
    : path.join(__dirname, "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH =
    process.env.DATABASE_PATH ||
    path.join(DATA_DIR, "wildlands.db");

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");


// ==========================================
// БАЗА ДАНИХ
// ==========================================

db.exec(`
    CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#73d68b',
        x REAL NOT NULL DEFAULT 0,
        y REAL NOT NULL DEFAULT 0,
        wood INTEGER NOT NULL DEFAULT 0,
        stone INTEGER NOT NULL DEFAULT 0,
        berries INTEGER NOT NULL DEFAULT 0,
        shells INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        amount INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS world_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
`);


// ==========================================
// EXPRESS І CORS
// ==========================================

const app = express();

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type"
    );

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

app.use(express.json({ limit: "20kb" }));

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);


// ==========================================
// SOCKET.IO
// ==========================================

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});


// ==========================================
// ЗМІННІ
// ==========================================

const online = new Map();

const COLORS = new Set([
    "#73d68b",
    "#7db7ff",
    "#f2c46d",
    "#d99bff",
    "#ff8f8f",
    "#f4f4f4"
]);

const clamp = (v, min, max) =>
    Math.max(min, Math.min(max, v));

const now = () => Date.now();


// ==========================================
// ПРОЦЕДУРНА ГЕНЕРАЦІЯ
// ==========================================

function hash2(x, y, seed = 173) {

    let n =
        Math.imul(x ^ seed, 374761393) +
        Math.imul(y, 668265263);

    n = Math.imul(n ^ (n >>> 13), 1274126177);

    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}


// ==========================================
// БІОМИ
// ==========================================

function biomeAt(tx, ty) {

    const a = hash2(
        Math.floor(tx / 18),
        Math.floor(ty / 18),
        91
    );

    const b = hash2(
        Math.floor(tx / 8),
        Math.floor(ty / 8),
        29
    );

    if (a < 0.13) return "water";

    if (a < 0.22) return "beach";

    if (a > 0.86 && b > 0.55) return "taiga";

    if (a > 0.72) return "mountain";

    if (b < 0.19) return "meadow";

    if (b > 0.82) return "desert";

    return "forest";
}


// ==========================================
// ГЕНЕРАЦІЯ РЕСУРСІВ
// ==========================================

function resourceFor(tx, ty) {

    const biome = biomeAt(tx, ty);

    const r = hash2(tx, ty, 701);

    if (biome === "water") return null;

    if (biome === "mountain" && r > 0.90) {
        return {
            kind: "stone",
            amount: 3
        };
    }

    if (biome === "desert" && r > 0.94) {
        return {
            kind: "stone",
            amount: 2
        };
    }

    if (
        (biome === "forest" || biome === "taiga") &&
        r > 0.80
    ) {
        return {
            kind: "tree",
            amount: 3
        };
    }

    if (biome === "meadow" && r > 0.92) {
        return {
            kind: "berries",
            amount: 2
        };
    }

    if (biome === "beach" && r > 0.91) {
        return {
            kind: "shell",
            amount: 1
        };
    }

    if (biome === "forest" && r > 0.94) {
        return {
            kind: "stone",
            amount: 2
        };
    }

    return null;
}


// ==========================================
// РОБОТА З РЕСУРСАМИ
// ==========================================

function resourceId(x, y) {
    return `${x},${y}`;
}


function getResource(x, y) {

    const id = resourceId(x, y);

    const saved = db
        .prepare("SELECT * FROM resources WHERE id = ?")
        .get(id);

    if (saved) {
        return saved.amount > 0 ? saved : null;
    }

    const generated = resourceFor(x, y);

    if (!generated) return null;

    return {
        id,
        kind: generated.kind,
        x,
        y,
        amount: generated.amount
    };
}


function takeResource(x, y) {

    const node = getResource(x, y);

    if (!node) return null;

    const id = node.id;

    const old = db
        .prepare("SELECT * FROM resources WHERE id = ?")
        .get(id);

    const next =
        (old ? old.amount : node.amount) - 1;

    db.prepare(`
        INSERT INTO resources(id, kind, x, y, amount)
        VALUES(?, ?, ?, ?, ?)

        ON CONFLICT(id)
        DO UPDATE SET amount = excluded.amount
    `).run(
        id,
        node.kind,
        x,
        y,
        next
    );

    return {
        ...node,
        amount: next
    };
}


// ==========================================
// ГРАВЦІ
// ==========================================

function cleanName(value) {

    return String(value || "Мандрівник")
        .replace(/[<>\x00-\x1F]/g, "")
        .trim()
        .slice(0, 18) || "Мандрівник";
}


function playerPublic(p) {

    return {
        id: p.id,
        nickname: p.nickname,
        color: p.color,

        x: p.x,
        y: p.y,

        wood: p.wood,
        stone: p.stone,
        berries: p.berries,
        shells: p.shells || 0
    };
}


// ==========================================
// HTTP API
// ==========================================

// Перевірка сервера

app.get("/health", (_req, res) => {

    res.json({
        ok: true,
        service: "wildlands",
        players: online.size
    });

});


// Отримання частини світу

app.get("/api/world", (req, res) => {

    const x = clamp(
        Number(req.query.x) || 0,
        -100000,
        100000
    );

    const y = clamp(
        Number(req.query.y) || 0,
        -100000,
        100000
    );

    const radius = clamp(
        Number(req.query.radius) || 16,
        4,
        24
    );

    const tiles = [];
    const nodes = [];

    for (
        let ty = Math.floor(y) - radius;
        ty <= Math.floor(y) + radius;
        ty++
    ) {

        for (
            let tx = Math.floor(x) - radius;
            tx <= Math.floor(x) + radius;
            tx++
        ) {

            tiles.push({
                x: tx,
                y: ty,
                biome: biomeAt(tx, ty)
            });

            const node = getResource(tx, ty);

            if (node) {
                nodes.push(node);
            }

        }

    }

    res.json({
        tiles,
        resources: nodes
    });

});


// ==========================================
// SOCKET.IO: ГРА
// ==========================================

io.on("connection", (socket) => {

    console.log("Гравець підключився:", socket.id);

    let player = null;


    // ======================================
    // ВХІД У СВІТ
    // ======================================

    socket.on("join", (payload = {}, ack = () => {}) => {

        if (player) return;

        const nickname = cleanName(payload.nickname);

        const color = COLORS.has(payload.color)
            ? payload.color
            : "#73d68b";

        const playerKey = String(payload.playerKey || "")
            .replace(/[^a-zA-Z0-9_-]/g, "")
            .slice(0, 64);

        if (playerKey.length < 12) {

            return ack({
                ok: false,
                error: "Не вдалося створити профіль."
            });

        }


        const id = playerKey;

        const saved = db
            .prepare("SELECT * FROM players WHERE id = ?")
            .get(id);


        player = {

            id,
            nickname,
            color,

            x: saved
                ? saved.x
                : Math.floor(
                    hash2(id.length, Date.now() % 10000) * 9
                ) - 4,

            y: saved
                ? saved.y
                : Math.floor(
                    hash2(Date.now() % 10000, id.length) * 9
                ) - 4,

            wood: saved ? saved.wood : 0,
            stone: saved ? saved.stone : 0,
            berries: saved ? saved.berries : 0,
            shells: saved ? saved.shells : 0,

            lastMove: 0

        };


        player.socketId = socket.id;

        online.set(socket.id, player);


        // Збереження гравця

        db.prepare(`
            INSERT INTO players(
                id,
                nickname,
                color,
                x,
                y,
                wood,
                stone,
                berries,
                shells,
                updated_at
            )

            VALUES(
                @id,
                @nickname,
                @color,
                @x,
                @y,
                @wood,
                @stone,
                @berries,
                @shells,
                @updated_at
            )

            ON CONFLICT(id)
            DO UPDATE SET
                nickname = @nickname,
                color = @color,
                updated_at = @updated_at
        `).run({
            ...player,
            updated_at: now()
        });


        // Відповідь гравцю

        ack({

            ok: true,

            self: playerPublic(player),

            players: [...online.values()]
                .filter(p => p.id !== id)
                .map(playerPublic)

        });


        socket.broadcast.emit(
            "player:joined",
            playerPublic(player)
        );


        console.log("Гравець увійшов:", nickname);

    });


    // ======================================
    // РУХ
    // ======================================

    socket.on("move", (direction = {}) => {

        if (!player) return;

        const t = now();

        if (t - player.lastMove < 45) return;

        player.lastMove = t;


        const dx = clamp(
            Number(direction.dx) || 0,
            -1,
            1
        );

        const dy = clamp(
            Number(direction.dy) || 0,
            -1,
            1
        );

        const len = Math.hypot(dx, dy) || 1;

        const speed = 0.22;

        const nx = player.x + (dx / len) * speed;

        const ny = player.y + (dy / len) * speed;


        // Не дозволяти заходити у воду

        if (
            biomeAt(Math.round(nx), Math.round(ny)) !== "water"
        ) {

            player.x = nx;
            player.y = ny;


            db.prepare(`
                UPDATE players
                SET x = ?, y = ?, updated_at = ?
                WHERE id = ?
            `).run(
                player.x,
                player.y,
                t,
                player.id
            );


            io.emit("player:moved", {

                id: player.id,
                x: player.x,
                y: player.y

            });

        }

    });


    // ======================================
    // ЗБІР РЕСУРСІВ
    // ======================================

    socket.on("gather", (payload = {}, ack = () => {}) => {

        if (!player) return;

        const x = Math.round(Number(payload.x));

        const y = Math.round(Number(payload.y));


        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            Math.hypot(
                x - player.x,
                y - player.y
            ) > 2.2
        ) {

            return ack({
                ok: false,
                error: "Підійди ближче до ресурсу."
            });

        }


        const node = takeResource(x, y);


        if (!node || node.amount < 0) {

            return ack({
                ok: false,
                error: "Тут більше немає ресурсу."
            });

        }


        // Додавання ресурсів

        if (node.kind === "tree") {
            player.wood += 1;
        }

        if (node.kind === "stone") {
            player.stone += 1;
        }

        if (node.kind === "berries") {
            player.berries += 1;
        }

        if (node.kind === "shell") {
            player.shells += 1;
        }


        // Збереження інвентарю

        db.prepare(`
            UPDATE players

            SET
                wood = ?,
                stone = ?,
                berries = ?,
                shells = ?,
                updated_at = ?

            WHERE id = ?
        `).run(
            player.wood,
            player.stone,
            player.berries,
            player.shells,
            now(),
            player.id
        );


        // Оновлення ресурсу для всіх

        io.emit("resource:changed", {

            id: node.id,
            amount: node.amount

        });


        // Відповідь гравцю

        ack({

            ok: true,

            inventory: playerPublic(player),

            kind: node.kind

        });


        socket.emit(
            "inventory",
            playerPublic(player)
        );

    });


    // ======================================
    // ЧАТ
    // ======================================

    socket.on("chat", (raw) => {

        if (!player) return;

        const message = String(raw || "")
            .replace(/[<>\x00-\x1F]/g, "")
            .trim()
            .slice(0, 180);

        if (!message) return;


        const item = {

            nickname: player.nickname,

            message,

            createdAt: now()

        };


        db.prepare(`
            INSERT INTO chat(
                nickname,
                message,
                created_at
            )

            VALUES(?, ?, ?)
        `).run(
            item.nickname,
            item.message,
            item.createdAt
        );


        io.emit("chat", item);

    });


    // ======================================
    // ВИХІД ГРАВЦЯ
    // ======================================

    socket.on("disconnect", () => {

        if (!player) return;

        online.delete(socket.id);


        socket.broadcast.emit("player:left", {
            id: player.id
        });


        console.log(
            "Гравець вийшов:",
            player.nickname
        );

    });

});


// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================

server.listen(PORT, "0.0.0.0", () => {

    console.log(
        `Wildlands server listening on ${PORT}`
    );

    console.log(
        `Database: ${DB_PATH}`
    );

});
