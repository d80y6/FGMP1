/**
 * mTLS transport for the IoT bridge (proposal §7 — الأمان والموثوقية:
 * "تشفير mTLS للاتصالات").
 *
 * When IOT_BRIDGE_TLS=1, calls to the platform ride the gateway's
 * internal mTLS listener (Caddyfile, 127.0.0.1:8443): every
 * connection must present the bridge's client certificate, so a
 * stolen API key alone cannot ingest telemetry from outside the
 * certificate boundary.
 *
 * Bun's fetch does not (yet) expose client certificates, so the
 * TLS path uses node:https directly and adapts the result to the
 * standard Response shape the call sites already consume.
 */

import https from "node:https";
import { readFileSync } from "node:fs";

export const MTLS_ENABLED = process.env.IOT_BRIDGE_TLS === "1";
const CA_PATH = process.env.IOT_BRIDGE_CA ?? "/certs/ca.crt";
const CERT_PATH = process.env.IOT_BRIDGE_CERT ?? "/certs/client.crt";
const KEY_PATH = process.env.IOT_BRIDGE_KEY ?? "/certs/client.key";

/** Read the client identity once — the files are mounted by the
 *  compose file and do not change during the process lifetime. */
let identity: { ca: Buffer; cert: Buffer; key: Buffer } | null = null;
function loadIdentity() {
  if (!identity) {
    identity = {
      ca: readFileSync(CA_PATH),
      cert: readFileSync(CERT_PATH),
      key: readFileSync(KEY_PATH),
    };
  }
  return identity;
}

/**
 * fetch() with mutual TLS. Identical signature for the disabled
 * case (plain http), so call sites stay transport-agnostic.
 */
export async function mtlsFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!MTLS_ENABLED) {
    return fetch(url, init);
  }

  const { ca, cert, key } = loadIdentity();
  const target = new URL(url);

  return new Promise<Response>((resolve, reject) => {
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 8443,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string> | undefined,
        ca,
        cert,
        key,
        // Fail closed: an unverifiable server certificate is a
        // MITM, not a warning.
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks).toString("utf8"), {
              status: res.statusCode ?? 502,
              // node:headers is a plain object of string|string[];
              // the Response constructor accepts the record form.
              headers: res.headers as Record<string, string>,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(String(init.body));
    req.end();
  });
}
