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

// Voliteľné: ručná route pre "/", ak by náhodou public/index.html nebolo.
// (Ak ho máš, toto kľudne môžeš vynechať.)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

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
    if (isMod) return;
    if (!players[socket.id]) return;
    players[socket.id].name = teamName.trim() || "Neznámy tím";
    broadcastPlayerList();
  });

  socket.on("buzz", () => {
    if (isMod) return;
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
        socket.emit("loser"); // neskorší klikač dostane "loser"
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
function buildScoreboardArray() {
  const arr = Object.values(players).map((p) => ({
    name: p.name,
    time: p.clickTime,
    difference: 0,
  }));

  // Najrýchlejší čas
  let fastest = Infinity;
  arr.forEach((item) => {
    if (item.time !== null && item.time < fastest) {
      fastest = item.time;
    }
  });

  // difference
  arr.forEach((item) => {
    if (item.time === null) {
      item.difference = null;
    } else {
      item.difference = item.time - fastest;
    }
  });

  // Zoradenie
  arr.sort((a, b) => {
    const aNull = a.time === null;
    const bNull = b.time === null;
    if (aNull && bNull) return 0;
    if (aNull) return 1; // a dole
    if (bNull) return -1; // b dole
    return a.time - b.time;
  });

  return arr;
}

function broadcastScoreboard() {
  io.emit("updateScoreboard", buildScoreboardArray());
}

function sendScoreboardToOne(socket) {
  socket.emit("updateScoreboard", buildScoreboardArray());
}

//------------------------------------------------------
// Body
//------------------------------------------------------
function buildPointsArray(forMod = false) {
  return Object.values(players).map((p) => {
    let thePoints = p.points;
    if (!forMod && !showPoints) {
      thePoints = null;
    }
    return { name: p.name, points: thePoints };
  });
}

function sendPointsToOne(socket, isMod) {
  socket.emit("pointsUpdated", buildPointsArray(isMod));
}

function broadcastPointsUpdate() {
  for (const [socketId, sock] of io.sockets.sockets) {
    const m = sock.handshake.query.mod === "true";
    sock.emit("pointsUpdated", buildPointsArray(m));
  }
}

//------------------------------------------------------
// Zoznam hráčov
//------------------------------------------------------
function broadcastPlayerList() {
  const names = Object.values(players).map((p) => p.name);
  io.emit("playerList", names);

  // Zavoláme scoreboard, aby sa noví hráči zobrazili hneď.
  broadcastScoreboard();
}

//------------------------------------------------------
// Spustenie kola na `resetTime` sekúnd
//------------------------------------------------------
function startRoundTimer() {
  if (roundTimer) return;
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
  io.emit("reset");
  broadcastPlayerList();
}

//------------------------------------------------------
// Lokálne spustenie (len ak nie sme na Verceli)
//------------------------------------------------------
const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`Server beží lokálne na porte ${PORT}`);
  });
}

//------------------------------------------------------
// Export pre Vercel serverless
//------------------------------------------------------
module.exports = server;
