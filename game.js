(() => {
    "use strict";

    // АДРЕСА СЕРВЕРА
    const SERVER_URL = "https://wildlands-rise-of-civilization.onrender.com";

    // ПЕРЕВІРКА SOCKET.IO
    if (typeof io === "undefined") {
        alert("Не вдалося завантажити Socket.IO. Перевір підключення до сервера.");
        return;
    }

    // ПІДКЛЮЧЕННЯ ДО СЕРВЕРА
    const socket = io(SERVER_URL, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000
    });

    // ЕЛЕМЕНТИ
    const $ = id => document.getElementById(id);

    const canvas = $("world");
    const ctx = canvas.getContext("2d");

    // КЛЮЧ ГРАВЦЯ
    let playerKey = localStorage.getItem("wildlands-player-key");

    if (!playerKey) {
        playerKey = crypto.randomUUID
            ? crypto.randomUUID()
            : "p" + Date.now() + Math.random().toString(36).slice(2);

        localStorage.setItem("wildlands-player-key", playerKey);
    }

    // СТАН ГРИ
    const state = {
        me: null,

        players: new Map(),
        tiles: new Map(),
        resources: new Map(),

        keys: new Set(),

        direction: {
            dx: 0,
            dy: 0
        },

        selectedColor: "#73d68b",

        lastMove: 0,
        lastWorldFetch: 0,

        dayTime: 0.28,

        tileSize: 42
    };


    // БІОМИ
    const biomeColors = {
        water: "#326f83",
        beach: "#c5b77e",
        meadow: "#75a95f",
        forest: "#477d4c",
        taiga: "#426b55",
        desert: "#c6a15e",
        mountain: "#777e76"
    };

    const biomeNames = {
        water: "Море",
        beach: "Узбережжя",
        meadow: "Луки",
        forest: "Ліс",
        taiga: "Тайга",
        desert: "Пустеля",
        mountain: "Гори"
    };


    const tileKey = (x, y) => `${x},${y}`;

    let toastTimer;


    // ПОВІДОМЛЕННЯ
    function toast(message) {
        const el = $("toast");

        el.textContent = message;
        el.classList.add("show");

        clearTimeout(toastTimer);

        toastTimer = setTimeout(() => {
            el.classList.remove("show");
        }, 2200);
    }


    // РОЗМІР CANVAS
    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        canvas.width = Math.floor(innerWidth * dpr);
        canvas.height = Math.floor(innerHeight * dpr);

        canvas.style.width = innerWidth + "px";
        canvas.style.height = innerHeight + "px";

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    window.addEventListener("resize", resize);

    resize();


    // ВИБІР КОЛЬОРУ
    document.querySelectorAll(".color-choice").forEach(button => {

        button.addEventListener("click", () => {

            document.querySelectorAll(".color-choice").forEach(b => {
                b.classList.remove("selected");
            });

            button.classList.add("selected");

            state.selectedColor = button.dataset.color;
        });

    });


    // ВХІД У ГРУ
    $("playBtn").addEventListener("click", () => {

        const nickname =
            $("nickname").value.trim().slice(0, 18) || "Мандрівник";

        const error = $("joinError");
        const playButton = $("playBtn");

        error.textContent = "";

        if (!socket.connected) {
            error.textContent = "Очікування з'єднання із сервером...";
            return;
        }

        playButton.disabled = true;
        playButton.textContent = "Підключення...";

        socket.timeout(10000).emit(
            "join",
            {
                nickname,
                color: state.selectedColor,
                playerKey
            },
            (timeoutError, result) => {

                playButton.disabled = false;
                playButton.textContent = "Увійти у світ";

                if (timeoutError) {
                    error.textContent = "Сервер не відповідає. Спробуй ще раз.";
                    return;
                }

                if (!result || !result.ok) {
                    error.textContent =
                        result?.error || "Не вдалося увійти.";
                    return;
                }

                // ЗБЕРЕЖЕННЯ ГРАВЦЯ
                state.me = result.self;

                state.players.clear();

                result.players.forEach(player => {
                    state.players.set(player.id, player);
                });

                $("playerName").textContent = state.me.nickname;

                $("joinScreen").classList.add("hidden");
                $("game").classList.remove("hidden");

                refreshWorld(true);

                updateHud();

                requestAnimationFrame(loop);
            }
        );

    });


    $("nickname").addEventListener("keydown", event => {
        if (event.key === "Enter") {
            $("playBtn").click();
        }
    });


    // СТАН ПІДКЛЮЧЕННЯ
    socket.on("connect", () => {
        $("joinError").textContent = "";
    });

    socket.on("connect_error", () => {
        if (!state.me) {
            $("joinError").textContent =
                "Немає зв'язку із сервером. Перевір інтернет.";
        } else {
            toast("Втрачено зв'язок із сервером.");
        }
    });

    socket.on("disconnect", () => {
        if (state.me) {
            toast("З'єднання перервано. Перепідключення...");
        }
    });


    // НОВИЙ ГРАВЕЦЬ
    socket.on("player:joined", player => {

        state.players.set(player.id, player);

        updateHud();

        toast(player.nickname + " приєднався до світу.");
    });


    // ГРАВЕЦЬ ВИЙШОВ
    socket.on("player:left", player => {

        state.players.delete(player.id);

        updateHud();
    });


    // РУХ ГРАВЦІВ
    socket.on("player:moved", player => {

        if (state.me && state.me.id === player.id) {

            state.me.x = player.x;
            state.me.y = player.y;

        } else {

            const oldPlayer = state.players.get(player.id);

            if (oldPlayer) {
                Object.assign(oldPlayer, player);
            }

        }

        updateHud();
    });


    // ОНОВЛЕННЯ ІНВЕНТАРЮ
    socket.on("inventory", player => {

        if (state.me && player.id === state.me.id) {

            state.me = player;

            updateHud();
        }

    });


    // ЗМІНА РЕСУРСУ
    socket.on("resource:changed", resource => {

        const node = state.resources.get(resource.id);

        if (node) {

            if (resource.amount <= 0) {
                state.resources.delete(resource.id);
            } else {
                node.amount = resource.amount;
            }

        }

    });


    // ЧАТ
    socket.on("chat", item => {
        addChat(item);
    });


    function addChat(item) {

        const line = document.createElement("p");

        line.className = "chat-line";

        const name = document.createElement("b");

        name.textContent = item.nickname + ": ";

        const message = document.createElement("span");

        message.textContent = item.message;

        line.append(name, message);

        $("chatMessages").append(line);

        $("chatMessages").scrollTop =
            $("chatMessages").scrollHeight;

        while ($("chatMessages").children.length > 35) {
            $("chatMessages").firstChild.remove();
        }

    }


    // ВІДПРАВЛЕННЯ ПОВІДОМЛЕННЯ
    $("chatForm").addEventListener("submit", event => {

        event.preventDefault();

        const input = $("chatInput");

        const message = input.value.trim();

        if (!message || !state.me) return;

        socket.emit("chat", message);

        input.value = "";

    });


    // ДОПОМОГА
    $("helpBtn").onclick = () => {
        $("helpModal").classList.remove("hidden");
    };

    $("closeHelp").onclick = () => {
        $("helpModal").classList.add("hidden");
    };

    $("closeHelp2").onclick = () => {
        $("helpModal").classList.add("hidden");
    };


    // ОНОВЛЕННЯ ІНТЕРФЕЙСУ
    function updateHud() {

        if (!state.me) return;

        $("woodCount").textContent = state.me.wood || 0;

        $("stoneCount").textContent = state.me.stone || 0;

        $("berryCount").textContent = state.me.berries || 0;

        $("coords").textContent =
            `${Math.round(state.me.x)}, ${Math.round(state.me.y)}`;

        $("onlineCount").textContent =
            `${state.players.size + 1} онлайн`;

        const list = [
            state.me,
            ...state.players.values()
        ].slice(0, 8);

        $("playerList").textContent =
            list.map(player => player.nickname).join(" • ");

    }


    // ЗАВАНТАЖЕННЯ СВІТУ
    async function refreshWorld(force = false) {

        if (!state.me) return;

        const now = Date.now();

        if (!force && now - state.lastWorldFetch < 1800) {
            return;
        }

        state.lastWorldFetch = now;

        try {

            const url =
                `${SERVER_URL}/api/world?x=${Math.round(state.me.x)}&y=${Math.round(state.me.y)}&radius=20`;

            const response = await fetch(url);

            if (!response.ok) {
                throw new Error("Помилка завантаження світу");
            }

            const data = await response.json();

            if (!data.tiles || !data.resources) {
                throw new Error("Неправильна відповідь сервера");
            }

            data.tiles.forEach(tile => {

                state.tiles.set(
                    tileKey(tile.x, tile.y),
                    tile
                );

            });

            state.resources.clear();

            data.resources.forEach(resource => {

                state.resources.set(
                    resource.id,
                    resource
                );

            });

        } catch (error) {

            console.error(error);

            toast("Не вдалося завантажити світ.");

        }

    }


    // КЕРУВАННЯ КЛАВІАТУРОЮ
    function movementVector() {

        let dx = 0;
        let dy = 0;

        if (
            state.keys.has("w") ||
            state.keys.has("arrowup")
        ) dy--;

        if (
            state.keys.has("s") ||
            state.keys.has("arrowdown")
        ) dy++;

        if (
            state.keys.has("a") ||
            state.keys.has("arrowleft")
        ) dx--;

        if (
            state.keys.has("d") ||
            state.keys.has("arrowright")
        ) dx++;

        return { dx, dy };

    }


    window.addEventListener("keydown", event => {

        const key = event.key.toLowerCase();

        if ([
            "w", "a", "s", "d",
            "arrowup", "arrowdown",
            "arrowleft", "arrowright", " "
        ].includes(key)) {
            event.preventDefault();
        }

        state.keys.add(key);

        if (key === "e" || key === " ") {
            gatherNearest();
        }

    });


    window.addEventListener("keyup", event => {

        state.keys.delete(event.key.toLowerCase());

    });


    window.addEventListener("blur", () => {

        state.keys.clear();

        state.direction = {
            dx: 0,
            dy: 0
        };

    });


    // МОБІЛЬНІ КНОПКИ
    document.querySelectorAll("[data-dir]").forEach(button => {

        const directions = {
            up: [0, -1],
            down: [0, 1],
            left: [-1, 0],
            right: [1, 0]
        };

        const start = event => {

            event.preventDefault();

            const direction = directions[button.dataset.dir];

            state.direction = {
                dx: direction[0],
                dy: direction[1]
            };

        };

        const stop = event => {

            event.preventDefault();

            state.direction = {
                dx: 0,
                dy: 0
            };

        };

        button.addEventListener("pointerdown", start);

        button.addEventListener("pointerup", stop);

        button.addEventListener("pointerleave", stop);

        button.addEventListener("pointercancel", stop);

    });


    // КНОПКА ЗБОРУ
    $("gatherBtn").addEventListener("click", gatherNearest);


    // ЗБІР РЕСУРСІВ
    function gatherNearest() {

        if (!state.me) return;

        let best = null;

        let bestDistance = 2.25;

        for (const resource of state.resources.values()) {

            const distance = Math.hypot(
                resource.x - state.me.x,
                resource.y - state.me.y
            );

            if (distance < bestDistance) {

                best = resource;

                bestDistance = distance;

            }

        }

        if (!best) {

            toast("Поруч немає ресурсів.");

            return;

        }


        socket.emit(
            "gather",
            {
                x: best.x,
                y: best.y
            },
            result => {

                if (!result || !result.ok) {

                    toast(
                        result?.error || "Не вдалося зібрати ресурс."
                    );

                    return;

                }

                state.me = result.inventory;

                updateHud();

                const labels = {
                    tree: "деревину",
                    stone: "камінь",
                    berries: "ягоди",
                    shell: "мушлю"
                };

                toast(
                    `Зібрано: ${labels[result.kind] || "ресурс"}!`
                );

            }
        );

    }


    // ПЕРЕТВОРЕННЯ КООРДИНАТ
    function worldToScreen(x, y) {

        return {

            x: innerWidth / 2 +
                (x - state.me.x) * state.tileSize,

            y: innerHeight / 2 +
                (y - state.me.y) * state.tileSize

        };

    }


    // МАЛЮВАННЯ КЛІТИНИ
    function drawTile(tile) {

        const position = worldToScreen(tile.x, tile.y);

        const size = state.tileSize + 1;

        ctx.fillStyle =
            biomeColors[tile.biome] || "#638a55";

        ctx.fillRect(
            position.x - size / 2,
            position.y - size / 2,
            size,
            size
        );

        const h =
            ((tile.x * 13 + tile.y * 7) % 11 + 11) % 11;

        if (tile.biome === "water") {

            ctx.strokeStyle = "rgba(195,235,235,.22)";

            ctx.lineWidth = 1;

            ctx.beginPath();

            ctx.moveTo(
                position.x - 11,
                position.y + h - 5
            );

            ctx.quadraticCurveTo(
                position.x,
                position.y + h - 9,
                position.x + 12,
                position.y + h - 5
            );

            ctx.stroke();

        } else if (
            tile.biome === "meadow" ||
            tile.biome === "forest" ||
            tile.biome === "taiga"
        ) {

            ctx.strokeStyle = "rgba(222,242,169,.2)";

            ctx.lineWidth = 1;

            ctx.beginPath();

            ctx.moveTo(position.x - 7, position.y + 5);

            ctx.lineTo(position.x - 9, position.y - 2);

            ctx.moveTo(position.x, position.y + 7);

            ctx.lineTo(position.x + 2, position.y - 1);

            ctx.stroke();

        }

        ctx.strokeStyle = "rgba(15,35,20,.08)";

        ctx.strokeRect(
            position.x - size / 2,
            position.y - size / 2,
            size,
            size
        );

    }


    // МАЛЮВАННЯ РЕСУРСІВ
    function drawResource(resource) {

        const position = worldToScreen(
            resource.x,
            resource.y
        );

        ctx.save();

        ctx.translate(position.x, position.y);


        if (resource.kind === "tree") {

            // СТОВБУР
            ctx.fillStyle = "#63472e";

            ctx.fillRect(-3, 0, 6, 13);

            // КРОНА
            ctx.fillStyle = "#1e5734";

            ctx.beginPath();

            ctx.arc(0, -4, 13, 0, Math.PI * 2);

            ctx.fill();

            ctx.fillStyle = "#347b43";

            ctx.beginPath();

            ctx.arc(-5, -8, 7, 0, Math.PI * 2);

            ctx.fill();

        }


        else if (resource.kind === "stone") {

            ctx.fillStyle = "#929b98";

            ctx.beginPath();

            ctx.moveTo(-10, 7);

            ctx.lineTo(-7, -5);

            ctx.lineTo(1, -11);

            ctx.lineTo(10, -4);

            ctx.lineTo(8, 8);

            ctx.closePath();

            ctx.fill();

            ctx.strokeStyle = "#c5ceca";

            ctx.stroke();

        }


        else if (resource.kind === "berries") {

            ctx.fillStyle = "#397849";

            ctx.beginPath();

            ctx.arc(0, 0, 8, 0, Math.PI * 2);

            ctx.fill();

            ctx.fillStyle = "#8c5cc1";

            [
                [-4, -2],
                [3, -4],
                [2, 3]
            ].forEach(([x, y]) => {

                ctx.beginPath();

                ctx.arc(x, y, 2.5, 0, Math.PI * 2);

                ctx.fill();

            });

        }


        else if (resource.kind === "shell") {

            ctx.fillStyle = "#ead8b4";

            ctx.beginPath();

            ctx.arc(0, 0, 7, Math.PI, Math.PI * 2);

            ctx.lineTo(7, 4);

            ctx.lineTo(-7, 4);

            ctx.closePath();

            ctx.fill();

        }


        ctx.restore();

    }


    // МАЛЮВАННЯ ГРАВЦЯ
    function drawPlayer(player, isMe = false) {

        const position = worldToScreen(
            player.x,
            player.y
        );

        ctx.save();

        ctx.translate(position.x, position.y);


        // ТІНЬ
        ctx.fillStyle = "#0005";

        ctx.beginPath();

        ctx.ellipse(
            0, 10,
            10, 4,
            0, 0, Math.PI * 2
        );

        ctx.fill();


        // ТІЛО
        ctx.fillStyle = player.color || "#73d68b";

        ctx.beginPath();

        ctx.arc(0, 0, 9, 0, Math.PI * 2);

        ctx.fill();


        // КОНТУР
        ctx.strokeStyle = isMe ? "#ffffff" : "#142318";

        ctx.lineWidth = isMe ? 2 : 1.5;

        ctx.stroke();


        // ОЧІ
        ctx.fillStyle = "#183024";

        ctx.beginPath();

        ctx.arc(-3, -2, 1.2, 0, Math.PI * 2);

        ctx.arc(3, -2, 1.2, 0, Math.PI * 2);

        ctx.fill();


        // НІКНЕЙМ
        ctx.font = "10px Manrope, Arial";

        ctx.textAlign = "center";

        ctx.fillStyle = "#ffffff";

        ctx.shadowColor = "#000000";

        ctx.shadowBlur = 4;

        ctx.fillText(
            player.nickname,
            0,
            -16
        );

        ctx.restore();

    }


    // ГОЛОВНИЙ ІГРОВИЙ ЦИКЛ
    function loop(time) {

        if (!state.me) return;

        ctx.clearRect(
            0,
            0,
            innerWidth,
            innerHeight
        );


        // НАПРЯМОК РУХУ
        const direction =
            state.direction.dx || state.direction.dy
                ? state.direction
                : movementVector();


        // ВІДПРАВЛЕННЯ РУХУ
        if (
            (direction.dx || direction.dy) &&
            time - state.lastMove > 75 &&
            socket.connected
        ) {

            socket.emit("move", direction);

            state.lastMove = time;

        }


        // ПОТОЧНА КЛІТИНА
        const cx = Math.round(state.me.x);

        const cy = Math.round(state.me.y);

        const currentTile =
            state.tiles.get(tileKey(cx, cy));

        const biome =
            currentTile?.biome || "forest";

        $("biomeName").textContent =
            biomeNames[biome] || "Невідомо";


        // РАДІУС МАЛЮВАННЯ
        const radius =
            Math.ceil(
                Math.max(innerWidth, innerHeight) /
                state.tileSize / 2
            ) + 2;


        // МАЛЮВАННЯ СВІТУ
        for (
            let y = cy - radius;
            y <= cy + radius;
            y++
        ) {

            for (
                let x = cx - radius;
                x <= cx + radius;
                x++
            ) {

                const tile =
                    state.tiles.get(tileKey(x, y));

                if (tile) {
                    drawTile(tile);
                }

            }

        }


        // РЕСУРСИ
        for (const resource of state.resources.values()) {
            drawResource(resource);
        }


        // ІНШІ ГРАВЦІ
        state.players.forEach(player => {
            drawPlayer(player, false);
        });


        // НАШ ГРАВЕЦЬ
        drawPlayer(state.me, true);


        // ЗМІНА ЧАСУ ДОБИ
        state.dayTime =
            (state.dayTime + 0.000025) % 1;

        const night = Math.max(
            0,
            (Math.cos(state.dayTime * Math.PI * 2) + 0.15) / 1.15
        );


        // НІЧНЕ ЗАТЕМНЕННЯ
        ctx.fillStyle =
            `rgba(8,16,34,${night * 0.38})`;

        ctx.fillRect(
            0,
            0,
            innerWidth,
            innerHeight
        );


        // НАЗВА ЧАСУ
        $("timeLabel").textContent =
            night > 0.55
                ? "Ніч"
                : night > 0.2
                    ? "Вечір"
                    : "День";


        // ОНОВЛЕННЯ СВІТУ
        refreshWorld();


        requestAnimationFrame(loop);

    }

})();
