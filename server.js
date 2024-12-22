//------------------------------------------------------
// server.js
//------------------------------------------------------
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Ukladáme info o hráčoch:
let players = {}; 
//   players[socketId] = { name, clickTime, points };

let roundActive = false;
let roundStartTime = null;
let winner = null;
let roundTimer = null;

// Nastavenia, ktoré vie meniť moderátor:
let resetTime = 10;    // Počet sekúnd do automatického resetu
let showPoints = false; // Či hráči vidia stĺpec s bodmi

//------------------------------------------------------
// Servovanie statických súborov z "public" priečinka
//------------------------------------------------------
app.use(express.static("public"));

//------------------------------------------------------
// Socket.IO logika
//------------------------------------------------------
io.on("connection", (socket) => {
  // Rozlíšime, či je to moderátor => ?mod=true
  const isMod = socket.handshake.query.mod === "true";

  // Ak nie je moderátor, pridaj do players
  if (!isMod) {
    players[socket.id] = {
      name: "Neznámy tím",
      clickTime: null,
      points: 0,
    };
    broadcastPlayerList();
  }

  // Hneď po pripojení (či už hráč, alebo moderátor) mu pošleme "initial data"
  sendInitialData(socket, isMod);

  //-------------------------------
  // Udalosti (events) od hráča
  //-------------------------------
  socket.on("setName", (teamName) => {
    if (isMod) return; // moderátor nerieši meno
    if (!players[socket.id]) return;
    players[socket.id].name = teamName.trim() || "Neznámy tím";
    broadcastPlayerList();
  });

  socket.on("buzz", () => {
    if (isMod) return; // moderátor nekliká
    if (!players[socket.id]) return;

    // Spustenie kola (ak ešte nie je)
    if (!roundActive) {
      roundActive = true;
      roundStartTime = Date.now();
      startRoundTimer();
    }

    // Nastavenie času kliknutia
    const p = players[socket.id];
    if (p.clickTime === null) {
      p.clickTime = Date.now() - roundStartTime;

      // Nastavenie víťaza
      if (!winner) {
        winner = socket.id;
        io.emit("winner", p.name); // všetci vidia víťaza
      } else {
        socket.emit("loser");     // neskorší klikač dostane "loser"
      }
    }

    // Aktualizácia scoreboardu
    broadcastScoreboard();
  });

  //-------------------------------
  // Udalosti (events) od moderátora
  //-------------------------------
  socket.on("setResetTime", (newTime) => {
    if (!isMod) return;
    resetTime = parseInt(newTime, 10) || 10;
    io.emit("resetTimeChanged", resetTime);
  });

  socket.on("setPoints", ({ teamName, points }) => {
    if (!isMod) return;
    for (const id in players) {
      if (players[id].name === teamName) {
        players[id].points = points;
        break;
      }
    }
    broadcastPointsUpdate();
  });

  socket.on("toggleShowPoints", () => {
    if (!isMod) return;
    showPoints = !showPoints;
    // Všetkým povieme, či sa majú body zobrazovať
    io.emit("showPointsUpdated", showPoints);
    // ... a každému zvlášť pošleme aktuálnu hodnotu bodov (mod vs hráč)
    broadcastPointsUpdate();
  });

  //-------------------------------
  // Odpojenie
  //-------------------------------
  socket.on("disconnect", () => {
    if (!isMod) {
      // Odstrániť hráča
      delete players[socket.id];
      broadcastPlayerList();
    }
  });
});

//------------------------------------------------------
// Posielanie "initial data" jednému klientovi
//------------------------------------------------------
function sendInitialData(socket, isMod) {
  socket.emit("showPointsUpdated", showPoints);
  socket.emit("resetTimeChanged", resetTime);

  sendScoreboardToOne(socket);
  sendPointsToOne(socket, isMod);
}

//------------------------------------------------------
// Scoreboard
//------------------------------------------------------
// Vytvor pole { name, time, difference } a zoradí hráčov
function buildScoreboardArray() {
  // Z mapy players vyrobíme pole
  const arr = Object.values(players).map((p) => {
    return {
      name: p.name,
      time: p.clickTime,
      difference: 0,
    };
  });

  // Nájdeme najrýchlejší čas
  let fastest = Infinity;
  arr.forEach((item) => {
    if (item.time !== null && item.time < fastest) {
      fastest = item.time;
    }
  });

  // Vypočítame difference (null, ak time = null)
  arr.forEach((item) => {
    if (item.time === null) {
      item.difference = null;
    } else {
      item.difference = item.time - fastest;
    }
  });

  // Zoradenie: tí, čo klikli, hore, podľa time vzostupne, nezúčastnení dole
 arr.sort((a, b) => {
    const aNull = a.time === null;
    const bNull = b.time === null;
    if (aNull && bNull) return 0;
    if (aNull) return 1;  // a ide dole
    if (bNull) return -1; // b ide dole
    return a.time - b.time;
  });

  return arr;
}

function broadcastScoreboard() {
  const arr = buildScoreboardArray();
  io.emit("updateScoreboard", arr);
}

function sendScoreboardToOne(socket) {
  const arr = buildScoreboardArray();
  socket.emit("updateScoreboard", arr);
}

//------------------------------------------------------
// Body
//------------------------------------------------------
function buildPointsArray(forMod = false) {
  return Object.values(players).map((p) => {
    let thePoints = p.points;
    // Ak je to hráč a showPoints je false => body = null
    if (!forMod && !showPoints) {
      thePoints = null;
    }
    return {
      name: p.name,
      points: thePoints,
    };
  });
}

// Pošle body len jednému socketu
function sendPointsToOne(socket, isMod) {
  const arr = buildPointsArray(isMod);
  socket.emit("pointsUpdated", arr);
}

// Každému socketu zvlášť => ak je to mod, dostane reálne body, ak hráč, tak zohľadní showPoints
function broadcastPointsUpdate() {
  for (const [socketId, sock] of io.sockets.sockets) {
    const isMod = sock.handshake.query.mod === "true";
    const arr = buildPointsArray(isMod);
    sock.emit("pointsUpdated", arr);
  }
}

//------------------------------------------------------
// Zoznam hráčov
//------------------------------------------------------
function broadcastPlayerList() {
  const names = Object.values(players).map((p) => p.name);
  io.emit("playerList", names);
}

//------------------------------------------------------
// Spustenie kola na `resetTime` sekúnd
//------------------------------------------------------
function startRoundTimer() {
  if (roundTimer) return; // už beží
  roundTimer = setTimeout(() => {
    resetGame();
    roundTimer = null;
  }, resetTime * 1000);
}

//------------------------------------------------------
// Reset kola
//------------------------------------------------------
function resetGame() {
  roundActive = false;
  roundStartTime = null;
  winner = null;
  for (const id in players) {
    players[id].clickTime = null;
  }
  io.emit("reset");         // povieme klientom, že všetko nech resetnú
  broadcastPlayerList();    // aby sa aktualizoval zoznam (časy = null)
}

//------------------------------------------------------
// Spustenie servera
//------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server beží na porte", PORT);
});
