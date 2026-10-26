// Servidor capi minimo que imita a Elk para los tests del adaptador.
// No usa red externa ni datos reales: todo es ficticio y determinista.
import http from "node:http";

const GAME_ID = "99999";
const SESSION = "TESTSESSION00000000000000000001";

function variantsXml(variants) {
  if (!variants || variants.length === 0) return "";
  const blocks = variants
    .map((variant) => {
      // `SYMBOL-GROUPS` no debe contar como simbolo: el parser exige `<SYMBOL ... id=`.
      const symbols = Array.from(
        { length: variant.symbols ?? 0 },
        (_, index) => `<SYMBOL id="${index}" type="normal" values="0,1,2"/>`,
      ).join("");
      return `<variant id="${variant.id}"><game><paytable><![CDATA[<SETUP gameid="${GAME_ID}" maxwin="1000" protocol-version="2" variant="${variant.id}">${symbols}<SYMBOL-GROUPS count="1"/></SETUP>]]></paytable></game></variant>`;
    })
    .join("");
  return `<variants><pubstate><init><![CDATA[<VARS></VARS>]]></init></pubstate>${blocks}</variants>`;
}

function initXml(state) {
  const bmodeEnabled = state.bmodeEnabled;
  const extraMode = bmodeEnabled
    ? `<bmode id="X01" amount="${(state.betAmount * 3).toFixed(2)}" maxwinamount="1000" coinvalue="0.01000" autospin="true"></bmode>`
    : "";
  return `<response><method>init</method><errorcode>0</errorcode><gamesession><id>${SESSION}</id><totbet>0.00</totbet><totwon>0.00</totwon><netposition>0.00</netposition><onetimetoken>false</onetimetoken><minspindelay>0</minspindelay><regulateminbetlevel>false</regulateminbetlevel></gamesession><servertime>1700000000</servertime><roundid>0</roundid><player><playerhash>deadbeefdeadbeefdeadbeefdeadbeef</playerhash><currency>EUR</currency><balance>${state.balance.toFixed(2)}</balance></player><currencydetails><rightsidesign>false</rightsidesign><currencysymbol>€</currencysymbol><thousandseparator>,</thousandseparator><decimalseparator>.</decimalseparator></currencydetails><betlevels maxwin="1000" default="1" rtp="0.940000" hf="0.250000" cpbb="100" bmode="${bmodeEnabled}"><betlevel id="1"><bmodes><bmode id="DEF" amount="${state.betAmount.toFixed(2)}" maxwinamount="1000" coinvalue="0.01000" autospin="true"></bmode>${extraMode}</bmodes></betlevel><betlevel id="2"><bmodes><bmode id="DEF" amount="${(state.betAmount * 2).toFixed(2)}" maxwinamount="2000" coinvalue="0.02000" autospin="true"></bmode>${
    bmodeEnabled
      ? `<bmode id="X01" amount="${(state.betAmount * 6).toFixed(2)}" maxwinamount="2000" coinvalue="0.02000" autospin="true"></bmode>`
      : ""
  }</bmodes></betlevel></betlevels><gameprops><bmode enabled="${bmodeEnabled}"></bmode><jackpot enabled="false"></jackpot><rtpdisplay>94.0%</rtpdisplay><multiplierdisplay>1 000x</multiplierdisplay><bmodemultipliers>${
    bmodeEnabled ? '<bmode id="DEF" display="1x"></bmode><bmode id="X01" display="3x"></bmode>' : ""
  }</bmodemultipliers></gameprops><papi><url>https://papi.example.invalid</url></papi><jurisdiction><intjur>MGA</intjur><features><spin><mindelay>0</mindelay></spin><autospin><enabled>true</enabled><value>10,25</value></autospin><quickplay><enabled>true</enabled></quickplay><realitycheck><enabled>true</enabled></realitycheck><buybonus><enabled>${bmodeEnabled}</enabled></buybonus></features></jurisdiction>${variantsXml(state.variants)}</response>`;
}

function roundXml(state, round) {
  return `<response><method>purchase</method><errorcode>0</errorcode><gamesession><id>${SESSION}</id><totbet>${round.bet.toFixed(2)}</totbet><totwon>${round.win.toFixed(2)}</totwon><netposition>${(round.win - round.bet).toFixed(2)}</netposition><onetimetoken>false</onetimetoken><minspindelay>0</minspindelay></gamesession><servertime>1700000001</servertime><roundid>${round.roundid}</roundid><player><playerhash>deadbeefdeadbeefdeadbeefdeadbeef</playerhash><currency>EUR</currency><balance>${state.balance.toFixed(2)}</balance></player><roundinfo><roundid>${round.roundid}</roundid><betlevel>${round.betlevel}</betlevel><betamount>${round.bet.toFixed(2)}</betamount><winamount>${round.win.toFixed(2)}</winamount><bmode>${round.bmode}</bmode><currency>EUR</currency><balanceafterwin>${(state.balance + round.win).toFixed(2)}</balanceafterwin></roundinfo><game><pubdata><![CDATA[<PURCHASES><PURCHASE coinvalue="0.01000" betamount="${round.bet.toFixed(5)}" betcoins="100" betlevel="${round.betlevel}" win="${Math.round(round.win * 100)}" winamount="${round.win.toFixed(5)}" currency="EUR" clientseed="seed-${round.roundid}" revision="42" bmode="${round.bmode}"><RESULT mode="BASE" resultIndex="0" winamount="${round.win.toFixed(5)}"><ACTIONS><ACTION name="drop"></ACTION><ACTION name="evaluate"></ACTION></ACTIONS></RESULT></PURCHASE></PURCHASES>]]></pubdata></game></response>`;
}

function checkwinXml(balance) {
  return `<response><method>checkwin</method><errorcode>0</errorcode><gamesession><id>${SESSION}</id><minspindelay>0</minspindelay></gamesession><servertime>1700000002</servertime><roundid>0</roundid><player><playerhash>deadbeefdeadbeefdeadbeefdeadbeef</playerhash><currency>EUR</currency><balance>${balance.toFixed(2)}</balance></player></response>`;
}

function attrsOf(body) {
  const attrs = {};
  for (const match of body.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
}

export function startFixture(options = {}) {
  const state = {
    balance: options.balance ?? 100,
    roundSeq: 0,
    rounds: new Map(),
    calls: [],
    corruptCredit: options.corruptCredit ?? 0,
    failInit: options.failInit ?? false,
    bmodeEnabled: options.bmodeEnabled ?? true,
    betAmount: options.betAmount ?? 1,
    variants: options.variants ?? [],
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url, "http://fixture");
      const parts = url.pathname.split("/").filter(Boolean);
      // /capi/:gameId/play/:op
      const op = parts[parts.length - 1];
      const gameId = parts[1];
      state.calls.push({ op, gameId, path: url.pathname, query: url.search, body });
      res.setHeader("content-type", "application/xml");
      const attrs = attrsOf(body);

      if (gameId !== GAME_ID) {
        res.end("<response><method>init</method><errorcode>1010</errorcode><errormessage>unknown game</errormessage></response>");
        return;
      }

      if (op === "init") {
        if (state.failInit) {
          res.end("<response><method>init</method><errorcode>7</errorcode><errormessage>blocked</errormessage></response>");
          return;
        }
        res.end(initXml(state));
        return;
      }

      if (op === "purchase" || op === "claim") {
        if (attrs.gamesession !== SESSION) {
          res.end("<response><method>purchase</method><errorcode>1010</errorcode><errormessage>bad session</errormessage></response>");
          return;
        }
        const bet = Number(attrs.amount);
        const betlevel = Number(attrs.betlevel);
        if (!Number.isFinite(bet) || bet <= 0 || state.balance < bet) {
          res.end("<response><method>purchase</method><errorcode>3</errorcode><errormessage>insufficient</errormessage></response>");
          return;
        }
        state.roundSeq += 1;
        const win = state.roundSeq % 2 === 0 ? bet * 2 : 0;
        const round = {
          roundid: `ROUND${String(state.roundSeq).padStart(6, "0")}`,
          bet,
          win,
          betlevel,
          bmode: attrs.bmode ?? "DEF",
          credited: false,
        };
        state.rounds.set(round.roundid, round);
        state.balance -= bet;
        res.end(roundXml(state, round));
        return;
      }

      if (op === "checkwin") {
        const round = state.rounds.get(attrs.roundid);
        if (!round) {
          res.end(checkwinXml(state.balance));
          return;
        }
        if (!round.credited) {
          round.credited = true;
          state.balance += round.win + state.corruptCredit;
        }
        res.end(checkwinXml(state.balance));
        return;
      }

      if (op === "reject") {
        res.end(`<response><method>reject</method><errorcode>0</errorcode><gamesession><id>${SESSION}</id></gamesession></response>`);
        return;
      }

      res.end(`<response><method>${op}</method><errorcode>0</errorcode><gamesession><id>${SESSION}</id></gamesession></response>`);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        gameId: GAME_ID,
        sessionId: SESSION,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (process.argv[1]?.endsWith("elk-fixture-server.mjs")) {
  const fixture = await startFixture();
  console.log(`fixture en ${fixture.url} (gameId ${fixture.gameId})`);
}
