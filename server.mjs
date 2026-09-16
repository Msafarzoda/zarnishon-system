import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { parse } from "node:url";
import next from "next";

/**
 * The factory server: Next.js over HTTPS, bound to every interface, plus a small plain
 * HTTP helper on the next port up.
 *
 * **Why HTTPS on a private LAN.** The weighbridge reads the indicator through the
 * browser's Web Serial API, and browsers only expose serial ports on a *secure origin* —
 * https, or http://localhost. Served as plain http on a LAN address the weighbridge page
 * loads perfectly and its Connect button does nothing, which is a far worse failure than
 * not loading at all. The certificate is not about secrecy on a cable nobody is tapping;
 * it is the price of reaching the scale from any machine but the server itself.
 *
 * **Why the HTTP helper.** A new machine cannot fetch the certificate authority over a
 * connection it does not yet trust. The helper exists to break that circle: it serves the
 * root certificate, and redirects everything else to the real address. It carries nothing
 * else — no part of the application is reachable on it.
 *
 * See docs/deployment.md.
 */

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const helperPort = Number(process.env.HELPER_PORT ?? port + 1);

const CERT = process.env.SSL_CERT ?? "./certs/zarnishon.pem";
const KEY = process.env.SSL_KEY ?? "./certs/zarnishon-key.pem";
const CA = process.env.SSL_CA ?? "./certs/rootCA.pem";

/*
 * HTTPS when there is a certificate, plain HTTP when there is not.
 *
 * Whether the certificate is *needed* depends entirely on where the scale is read. If the
 * server holds the indicator's port (SCALE_PORT set) then no browser ever touches a
 * serial device, no secure origin is required, and plain HTTP over the LAN is fine — which
 * is far less to go wrong than a private certificate authority installed on every machine.
 *
 * If instead each station reads its own port through Web Serial, HTTPS is not optional:
 * without it the weighbridge page loads, looks normal, and its Connect button does nothing.
 *
 * So this refuses to start only in the combination that would fail silently later.
 */
const secure = existsSync(CERT) && existsSync(KEY);

if (!secure && !process.env.SCALE_PORT && process.env.ALLOW_INSECURE !== "1") {
  console.error(
    `\nСертификат ёфт нашуд / No certificate, and no SCALE_PORT.\n\n` +
      `  Тарозуро дар браузер хондан бе https кор намекунад.\n` +
      `  Web Serial needs a secure origin, so the weighbridge would silently fail.\n\n` +
      `Яке аз инҳоро интихоб кунед / Pick one:\n` +
      `  npm run certs                 — serve https, stations read their own port\n` +
      `  SCALE_PORT=/dev/ttyUSB0 ...   — the server reads the scale, http is fine\n` +
      `  ALLOW_INSECURE=1 ...          — http anyway, no scale\n`,
  );
  process.exit(1);
}

/** Every address this machine can be reached on, so the operator is told where to go. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

const app = next({ dev });
const handle = app.getRequestHandler();
await app.prepare();

// The indicator's port is opened by src/instrumentation.ts, which Next runs once at
// startup — inside its module system, so the reader resolves imports as the app does.

const serve = (req, res) => handle(req, res, parse(req.url ?? "/", true));

// 0.0.0.0, not localhost: the weighbridge, the lab and the cash desk are other machines.
if (secure) {
  createHttpsServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, serve)
    .listen(port, "0.0.0.0");
} else {
  createHttpServer(serve).listen(port, "0.0.0.0");
}

/**
 * Plain HTTP, and deliberately almost empty. Its whole job is handing over the root
 * certificate to a machine being set up, and pointing everything else at HTTPS.
 *
 * Only worth running when there *is* a certificate. On a plain-HTTP server it would be a
 * second copy of the app's own address offering a file that does not exist.
 */
function startCertificateHelper() {
  createHttpServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const target = `https://${host}:${port}`;

    if (req.url === "/ca" || req.url === "/ca.crt") {
      if (!existsSync(CA)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Сертификати реша ёфт нашуд. / Root certificate not found — run npm run certs.");
        return;
      }
      res.writeHead(200, {
        // application/x-x509-ca-cert is what makes iOS offer to install it rather than
        // showing the file as text.
        "content-type": "application/x-x509-ca-cert",
        "content-disposition": 'attachment; filename="zarnishon-ca.crt"',
      });
      res.end(readFileSync(CA));
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ЧДММ «ЗАРНИШОН» — насб</title>
<style>
 body{font:16px/1.5 system-ui;margin:0;padding:2rem 1.25rem;background:#faf9f7;color:#1c1b19}
 main{max-width:34rem;margin:0 auto}
 h1{font-size:1.3rem;margin:0 0 .25rem}
 p{color:#4a4844}
 a.btn{display:block;margin:1rem 0;padding:.9rem 1rem;border-radius:.6rem;
       background:#1f5c3d;color:#fff;text-decoration:none;text-align:center;font-weight:600}
 a.plain{color:#1f5c3d}
 ol{padding-inline-start:1.25rem}
</style>
<main>
 <h1>ЧДММ «ЗАРНИШОН»</h1>
 <p>Ин суроға танҳо барои насб кардани сертификат аст.</p>
 <ol>
  <li>Сертификатро зер кунед ва насб кунед.</li>
  <li>Баъд ба суроғаи аслӣ гузаред.</li>
 </ol>
 <a class="btn" href="/ca">1 — Сертификатро гирифтан</a>
 <a class="btn" href="${target}">2 — Ба система даромадан</a>
 <p><a class="plain" href="${target}">${target}</a></p>
</main>`);
  }).listen(helperPort, "0.0.0.0");
}

if (secure) startCertificateHelper();

const scheme = secure ? "https" : "http";
const addrs = lanAddresses();

console.log(
  `\nЧДММ «ЗАРНИШОН» — ${dev ? "dev" : "production"}\n\n` +
    `Кор / Work:\n` +
    `  ${scheme}://localhost:${port}   (ҳамин компютер)\n` +
    addrs.map((a) => `  ${scheme}://${a}:${port}`).join("\n") +
    `\n`,
);

if (secure) {
  console.log(
    `Насби компютери нав / Setting up a new machine:\n` +
      addrs.map((a) => `  http://${a}:${helperPort}`).join("\n") +
      `\n`,
  );
} else {
  console.log(
    `Тарозу дар сервер хонда мешавад — сертификат лозим нест.\n` +
      `The server reads the scale, so no certificate is needed.\n`,
  );
}

/*
 * Open the indicator's port now, rather than when somebody first opens a page.
 *
 * The reader lives inside Next — it has to, because `serialport` is a native addon and
 * Next compiles `instrumentation.ts` for the edge runtime too, where webpack traces the
 * import and the build fails on `stream`. So the server asks itself for a scale snapshot
 * once, which starts the reader in the one place it can work.
 *
 * Without this the port opens on the first page load and every frame before that is lost,
 * including the ones the protocol detection needs — so the first truck of the day would
 * wait while the scale "warmed up".
 */
if (process.env.SCALE_PORT) {
  console.log(`Тарозу / Scale: ${process.env.SCALE_PORT}`);
  setTimeout(() => {
    fetch(`http://127.0.0.1:${port}/api/scale/snapshot`)
      .then(() => console.log("Тарозу: порт кушода шуд / scale port opened"))
      .catch((e) => console.error("Тарозу: порт кушода нашуд / could not open:", e.message));
  }, 1500);
}
console.log(`docs/deployment.md\n`);
