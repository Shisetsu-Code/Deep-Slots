import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRequest, parseXml, xmlAttr } from "../dist/elk/xml.js";
import { ElkGameSession } from "../dist/elk/session.js";
import { redactSession } from "../dist/elk/client.js";
import { loadHar } from "../dist/har/loader.js";
import { summarizeHar, opOf } from "../dist/har/summary.js";
import { buildElkCard } from "../dist/har/elk-card.js";
import { startFixture } from "./elk-fixture-server.mjs";

function makeSession(fixture) {
  return new ElkGameSession("test", {
    baseUrl: `${fixture.url}/capi/${fixture.gameId}/play`,
    currency: "EUR",
    locale: "en_gb",
    timeoutMs: 5000,
    retries: 0,
  });
}

test("xml: buildRequest conserva orden y escapa atributos", () => {
  const xml = buildRequest({ gamesession: "abc", amount: "1.00", bmode: "DEF", betdetails: "" });
  assert.equal(
    xml,
    '<?xml version="1.0"?><request gamesession="abc" amount="1.00" bmode="DEF" betdetails="" />',
  );

  const parsed = parseXml(
    '<response><method>init</method><errorcode>0</errorcode><gamesession><id>S1</id><minspindelay>1200</minspindelay></gamesession></response>',
  );
  assert.equal(xmlAttr(parsed.response, "method"), "init");
  assert.equal(xmlAttr(parsed.response.gamesession, "id"), "S1");
});

test("elk: init declara betlevels, bmodes y RTP", async () => {
  const fixture = await startFixture();
  try {
    const session = makeSession(fixture);
    const info = await session.initialize();
    assert.equal(info.balance, 100);
    assert.equal(info.rtp, 0.94);
    assert.equal(info.maxwin, 1000);
    assert.equal(info.betlevels.length, 2);
    assert.deepEqual(
      info.betlevels[0].bmodes.map((bmode) => bmode.id),
      ["DEF", "X01"],
    );
    assert.deepEqual(info.bmodes.map((bmode) => bmode.multiplier), [1, 3]);
    assert.equal(session.resolveBet(1, "DEF").amount, 1);
    assert.equal(session.resolveBet(2, "X01").amount, 6);
    assert.throws(() => session.resolveBet(1, "X05"), /bmode X05 no existe/);
  } finally {
    await fixture.close();
  }
});

test("elk: purchase + checkwin validan debito, premio y replay", async () => {
  const fixture = await startFixture();
  try {
    const session = makeSession(fixture);
    await session.initialize();

    const first = await session.spin({ betlevel: 1, bmode: "DEF" });
    assert.equal(first.ok, true);
    assert.equal(first.round.betamount, 1);
    assert.equal(first.round.winamount, 0);
    assert.equal(first.round.settled, true);
    assert.equal(first.round.validated, true);
    assert.equal(first.round.balanceAfterPurchase, 99);
    assert.equal(first.round.balanceAfterSettle, 99);
    assert.equal(first.round.pubdata.seed, "seed-ROUND000001");
    assert.deepEqual(first.round.pubdata.actions, ["drop", "evaluate"]);
    assert.equal(session.balance, 99);

    const second = await session.spin({ betlevel: 1, bmode: "DEF" });
    assert.equal(second.round.winamount, 2);
    assert.equal(second.round.validated, true);
    assert.equal(session.balance, 100);
  } finally {
    await fixture.close();
  }
});

test("elk: run N giros calcula RTP observado y conserva el saldo", async () => {
  const fixture = await startFixture();
  try {
    const session = makeSession(fixture);
    await session.initialize();
    const result = await session.run({ spins: 4, betlevel: 1, bmode: "DEF" });
    assert.equal(result.completed, 4);
    assert.equal(result.failed, 0);
    assert.equal(result.mismatches, 0);
    assert.equal(result.totalBet, 4);
    assert.equal(result.totalWin, 4);
    assert.equal(result.rtpPct, 100);
    assert.equal(result.balanceStart, 100);
    assert.equal(result.balanceEnd, 100);
    assert.equal(session.rounds.length, 4);
  } finally {
    await fixture.close();
  }
});

test("elk: detecta premio mal acreditado en checkwin", async () => {
  const fixture = await startFixture({ corruptCredit: 1 });
  try {
    const session = makeSession(fixture);
    await session.initialize();
    const result = await session.run({ spins: 4, betlevel: 1, bmode: "DEF" });
    assert.equal(result.mismatches > 0, true);
    assert.equal(result.stopped, "balance-mismatch");
    assert.match(result.errors[0].message, /checkwin: saldo/);
  } finally {
    await fixture.close();
  }
});

test("elk: init con errorcode lanza ElkError", async () => {
  const fixture = await startFixture({ failInit: true });
  try {
    const session = makeSession(fixture);
    await assert.rejects(() => session.initialize(), /errorcode=7/);
  } finally {
    await fixture.close();
  }
});

test("elk: redactSession oculta gamesession y playerhash", () => {
  const xml =
    '<response><gamesession><id>8610261548180500034vg5dk1bj3c0qz0ov0mq99sts8asodm7ad</id></gamesession><playerhash>26b8f9bab8cf150aac1f91d159658f94</playerhash></response>';
  const redacted = redactSession(xml);
  assert.doesNotMatch(redacted, /8610261548180500034/);
  assert.doesNotMatch(redacted, /26b8f9bab8cf150aac1f91d159658f94/);
  assert.match(redacted, /861026…m7ad/);
});

function miniHar() {
  const now = new Date().toISOString();
  const initResponse =
    '<response><method>init</method><errorcode>0</errorcode><servertime>1</servertime><roundid>0</roundid><player><playerhash>11112222333344445555666677778888</playerhash><currency>EUR</currency><balance>5000.00</balance></player><betlevels maxwin="1000000" default="4" rtp="0.940000" hf="0.250000" cpbb="100" bmode="true"><betlevel id="4"><bmodes><bmode id="DEF" amount="1.00" maxwinamount="10000" coinvalue="0.01000" autospin="true"></bmode><bmode id="X01" amount="3.00" maxwinamount="10000" coinvalue="0.01000" autospin="true"></bmode></bmodes></betlevel></betlevels><gameprops><bmode enabled="true"></bmode><bmodemultipliers><bmode id="DEF" display="1x"></bmode><bmode id="X01" display="3x"></bmode></bmodemultipliers></gameprops><jurisdiction><intjur>MGA</intjur><features><autospin><enabled>true</enabled></autospin></features></jurisdiction></response>';
  const purchaseResponse =
    '<response><method>purchase</method><errorcode>0</errorcode><servertime>2</servertime><roundid>R1</roundid><player><playerhash>11112222333344445555666677778888</playerhash><currency>EUR</currency><balance>4999.00</balance></player><roundinfo><roundid>R1</roundid><betlevel>4</betlevel><betamount>1.00</betamount><winamount>40.00</winamount><bmode>DEF</bmode><currency>EUR</currency><balanceafterwin>5039.00</balanceafterwin></roundinfo><game><pubdata><![CDATA[<PURCHASES><PURCHASE coinvalue="0.01000" betamount="1.00000" betcoins="100" betlevel="4" win="4000" winamount="40.00000" currency="EUR" clientseed="41bd4365f73208e39701ea58e91cca27" revision="226461" bmode="DEF"><RESULT mode="BASE" resultIndex="0"><ACTIONS><ACTION name="drop"></ACTION><ACTION name="multiplier-battle" winner-id="25" loser-id="2b"></ACTION><ACTION name="evaluate"></ACTION></ACTIONS></RESULT></PURCHASE></PURCHASES>]]></pubdata></game></response>';
  const checkwinResponse =
    '<response><method>checkwin</method><errorcode>0</errorcode><player><currency>EUR</currency><balance>5039.00</balance></player></response>';

  const entry = (url, method, requestBody, responseBody, index, responseEncoding) => ({
    index,
    startedDateTime: now,
    time: 10,
    request: { method, url, headers: [], postData: { mimeType: "text/xml", text: requestBody } },
    response: {
      status: 200,
      statusText: "OK",
      headers: [],
      content: { mimeType: "application/xml", text: responseBody, encoding: responseEncoding },
    },
    _resourceType: "xhr",
  });

  return {
    log: {
      version: "1.2",
      creator: { name: "test", version: "1" },
      pages: [],
      entries: [
        entry(
          "https://gc5-stage.contentmedia.eu/capi/10222/play/init?gl=true&standalone=false&iframe=true",
          "POST",
          '<?xml version="1.0"?><request opid="44" cur="EUR" />',
          Buffer.from(initResponse).toString("base64"),
          0,
          "base64",
        ),
        entry(
          "https://gc5-stage.contentmedia.eu/capi/10222/play/purchase",
          "POST",
          '<?xml version="1.0"?><request gamesession="SESSION00000000000000000000001" amount="1.00" cur="EUR" bmode="DEF" betlevel="4" />',
          purchaseResponse,
          1,
        ),
        entry(
          "https://gc5-stage.contentmedia.eu/capi/10222/play/checkwin",
          "POST",
          '<?xml version="1.0"?><request roundid="R1" gamesession="SESSION00000000000000000000001" />',
          checkwinResponse,
          2,
        ),
        entry(
          "https://static-stage.contentmedia.eu/ecf3/index.html?gameid=10222&gamename=clusterkingdom",
          "GET",
          null,
          "<html></html>",
          3,
        ),
        entry(
          "https://static-stage.contentmedia.eu/clusterkingdom/build-263580/game.js",
          "GET",
          null,
          "console.log(1)",
          4,
        ),
        {
          index: 5,
          startedDateTime: now,
          request: { method: "GET", url: "data:image/png;base64,AAAA", headers: [] },
          response: { status: 200, content: { mimeType: "image/png", text: "AAAA" } },
        },
      ],
    },
  };
}

test("har: loader decodifica base64, resume y deriva ficha Elk", () => {
  const file = path.join(os.tmpdir(), `deep-slots-mini-${process.pid}.har`);
  fs.writeFileSync(file, JSON.stringify(miniHar()), "utf8");
  try {
    const har = loadHar(file);
    assert.equal(har.entries.length, 6);
    assert.equal(har.entries[0].responseEncoding, "base64");

    const summary = summarizeHar(har);
    assert.equal(summary.dataUris, 1);
    assert.equal(summary.api.length, 3);
    assert.equal(summary.games[0].gameId, "10222");
    assert.equal(summary.games[0].slugs.length, 1);
    assert.equal(summary.builds[0].build, "263580");
    assert.equal(opOf(har.entries[2]), "checkwin");

    const card = buildElkCard([har], { redact: true });
    assert.equal(card.games.length, 1);
    const game = card.games[0];
    assert.equal(game.executionSupported, true);
    assert.equal(game.declared.rtp, 0.94);
    assert.equal(game.declared.maxwin, 1000000);
    assert.equal(game.declared.betlevels, 1);
    assert.equal(game.rounds.length, 1);
    assert.equal(game.rounds[0].winamount, 40);
    assert.equal(game.rounds[0].balanced, true);
    assert.equal(game.balanceAudit.ok, 1);
    assert.equal(game.observed.rtpObservedPct, 4000);
    assert.equal(game.samples.purchase.request.includes("S1"), false);
    assert.match(game.samples.init.response, /<redacted>|1111…/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
