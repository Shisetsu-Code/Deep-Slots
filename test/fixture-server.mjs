// Demo local de un slot (dinero ficticio) para probar el MCP de punta a punta.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const state = { balance: 1000, bet: 1, round: 0 };

const SYMBOLS = ["🍒", "🍋", "🔔", "⭐", "💎", "7️⃣"];
const PAYOUTS = { "🍒": 2, "🍋": 3, "🔔": 5, "⭐": 10, "💎": 25, "7️⃣": 50 };

function spinRound() {
  const reels = [0, 1, 2, 3, 4].map(() => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]);
  let win = 0;
  const counts = {};
  for (const s of reels) counts[s] = (counts[s] ?? 0) + 1;
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (n === 5) win = state.bet * PAYOUTS[best] * 5;
  else if (n === 4) win = state.bet * PAYOUTS[best] * 2;
  else if (n === 3) win = state.bet * PAYOUTS[best];

  state.balance = Number((state.balance - state.bet + win).toFixed(2));
  state.round += 1;
  return { roundId: state.round, reels, bet: state.bet, win: Number(win.toFixed(2)), balance: state.balance };
}

const HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Demo Slots QA</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#0b1020;color:#e8ecff;display:grid;place-items:center;height:100vh}
  #game{background:#141b33;border:1px solid #2a3560;border-radius:16px;padding:24px;width:560px}
  .hud{display:flex;justify-content:space-between;padding:6px 10px;background:#0e1428;border-radius:8px;margin-bottom:8px}
  .hud b{font-variant-numeric:tabular-nums}
  #reels{display:flex;gap:8px;justify-content:center;margin:20px 0;font-size:44px;background:#080c18;border-radius:10px;padding:16px}
  #reels span{width:64px;height:64px;display:grid;place-items:center;background:#1b2447;border-radius:8px}
  .controls{display:flex;gap:8px;justify-content:center}
  button{font-size:16px;padding:12px 20px;border-radius:10px;border:0;background:#2f4bd8;color:#fff;cursor:pointer;font-weight:700}
  button:disabled{opacity:.45;cursor:not-allowed}
  #spin{min-width:180px}
  #log{margin-top:12px;font-size:12px;color:#8f9cc7;height:40px;overflow:hidden}
</style></head>
<body><div id="game">
  <div class="hud"><span>Balance</span><b id="balance">1000.00</b></div>
  <div class="hud"><span>Apuesta</span><b id="bet">1.00</b></div>
  <div class="hud"><span>Ganancia</span><b id="win">0.00</b></div>
  <div id="reels"><span></span><span></span><span></span><span></span><span></span></div>
  <div class="controls">
    <button id="bet-down" aria-label="Bajar apuesta">-</button>
    <button id="spin" aria-label="Girar">GIRAR</button>
    <button id="bet-up" aria-label="Subir apuesta">+</button>
    <button id="buy" aria-label="Comprar bonus">BONUS</button>
  </div>
  <div id="log"></div>
</div>
<div id="modal" role="dialog" aria-modal="true" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);place-items:center;z-index:50">
  <div style="background:#141b33;border:1px solid #2a3560;padding:22px;border-radius:12px;text-align:center">
    <p>Comprar bonus por 10.00?</p>
    <button id="cancel" aria-label="Cancelar">Cancelar</button>
    <button id="confirm" aria-label="Confirmar compra">Confirmar</button>
  </div>
</div>
<script>
  const el = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toFixed(2);
  const BETS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
  let bet = 1, spinning = false;

  async function spin() {
    if (spinning) return;
    spinning = true;
    el("spin").disabled = true;
    try {
      const res = await fetch("/api/spin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bet })
      });
      if (!res.ok) throw new Error("spin HTTP " + res.status);
      const data = await res.json();
      await new Promise((r) => setTimeout(r, 400)); // animacion falsa
      el("reels").innerHTML = data.reels.map((s) => "<span>" + s + "</span>").join("");
      el("balance").textContent = fmt(data.balance);
      el("win").textContent = fmt(data.win);
      el("log").textContent = "ronda " + data.roundId + " | apuesta " + fmt(data.bet) + " | premio " + fmt(data.win);
      console.log("[slot] spin", data.roundId, JSON.stringify(data));
    } catch (err) {
      console.error("[slot] fallo el giro:", err);
    } finally {
      spinning = false;
      el("spin").disabled = false;
    }
  }

  function setBet(dir) {
    const i = Math.max(0, BETS.indexOf(bet));
    bet = BETS[Math.min(BETS.length - 1, Math.max(0, i + dir))];
    el("bet").textContent = fmt(bet);
  }

  el("spin").addEventListener("click", spin);
  el("bet-up").addEventListener("click", () => setBet(1));
  el("bet-down").addEventListener("click", () => setBet(-1));
  el("buy").addEventListener("click", () => { el("modal").style.display = "grid"; });
  el("cancel").addEventListener("click", () => { el("modal").style.display = "none"; });
  el("confirm").addEventListener("click", async () => {
    el("modal").style.display = "none";
    el("buy").disabled = true;           // evita doble compra mientras responde
    try {
      const res = await fetch("/api/buy", { method: "POST" });
      const data = await res.json();
      el("balance").textContent = fmt(data.balance);
      el("log").textContent = "bonus comprado | saldo " + fmt(data.balance);
      console.log("[slot] bonus comprado", JSON.stringify(data));
    } catch (err) {
      console.error("[slot] fallo la compra:", err);
    } finally {
      el("buy").disabled = false;
    }
  });
  window.gameState = { get bet() { return bet; }, get spinning() { return spinning; } };
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/index"))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }
  if (req.method === "POST" && req.url === "/api/buy") {
    state.balance = Number((state.balance - 10).toFixed(2));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ bonus: true, cost: 10, balance: state.balance }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/spin") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw || "{}");
        if (typeof body.bet === "number" && body.bet > 0) state.bet = body.bet;
      } catch {
        /* usa la apuesta actual */
      }
      const out = spinRound();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fixture escuchando en http://127.0.0.1:${PORT}`);
});
