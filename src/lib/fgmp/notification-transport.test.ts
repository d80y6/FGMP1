/**
 * Notification transport tests.
 *
 * Run: bun test src/lib/fgmp/notification-transport.test.ts
 *
 * Pure — no SMTP server, no SMS provider, no webhook endpoint. Transport
 * resolution is exercised through the environment, and the network paths are
 * covered by stubbing `fetch`.
 *
 * The property that matters and is asserted here: **no code path can produce
 * SENT without a real transport having reported success.** Everything else is
 * bookkeeping by comparison.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dispatch, resolveTransport } from "./notification-transport";
import { SmsTransport } from "./notification-sms";

const MSG = { to: "+967700000000", subject: "FUEL THEFT", body: "340 L missing at SITE-043" };

const ENV_KEYS = [
  "FGMP_SMTP_HOST",
  "FGMP_SMTP_PORT",
  "FGMP_SMTP_USER",
  "FGMP_SMTP_PASS",
  "FGMP_WEBHOOK_URL",
  "FGMP_WEBHOOK_SECRET",
  "FGMP_SMS_ACCOUNT_SID",
  "FGMP_SMS_AUTH_TOKEN",
  "FGMP_SMS_FROM",
];

let saved: Record<string, string | undefined> = {};

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("transport resolution — NO_TRANSPORT means never attempted", () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    clearEnv();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  test("email with no SMTP host is NO_TRANSPORT, not FAILED", async () => {
    const r = await dispatch("EMAIL", MSG);
    // NOT "FAILED": nothing was attempted. An operator told "failed" would go
    // hunting a broken SMTP server that does not exist.
    //
    // Narrowed rather than asserted-then-read: `reason` exists only on the
    // failure branches (a SENT outcome legitimately has none), so reading it
    // off the bare union was a type error AND would have silently passed for
    // the wrong reason had the assertion above been removed.
    expect(r.status).toBe("NO_TRANSPORT");
    if (r.status !== "NO_TRANSPORT") throw new Error("expected NO_TRANSPORT");
    expect(r.reason).toBe("NO_SMTP_HOST_CONFIGURED");
  });

  test("SMS with no credentials is NO_TRANSPORT", async () => {
    const r = await dispatch("SMS", MSG);
    expect(r.status).toBe("NO_TRANSPORT");
    if (r.status !== "NO_TRANSPORT") throw new Error("expected NO_TRANSPORT");
    expect(r.reason).toBe("NO_SMS_CREDENTIALS_CONFIGURED");
  });

  test("webhook with no URL is NO_TRANSPORT", async () => {
    const r = await dispatch("WHATSAPP", MSG);
    expect(r.status).toBe("NO_TRANSPORT");
    if (r.status !== "NO_TRANSPORT") throw new Error("expected NO_TRANSPORT");
    expect(r.reason).toBe("NO_WEBHOOK_URL_CONFIGURED");
  });

  test("SMS is a REAL transport when credentials exist, not a stub", () => {
    process.env.FGMP_SMS_ACCOUNT_SID = "ACxxxx";
    process.env.FGMP_SMS_AUTH_TOKEN = "token";
    process.env.FGMP_SMS_FROM = "+15550000000";
    const { transport } = resolveTransport("SMS");
    expect(transport).not.toBeNull();
    expect(transport!.name).toBe("twilio");
  });

  test("partial SMS credentials still yield NO_TRANSPORT", async () => {
    // A SID without a token is a misconfiguration, and attempting a send would
    // just produce an auth failure — better to say nothing is configured.
    process.env.FGMP_SMS_ACCOUNT_SID = "ACxxxx";
    const r = await dispatch("SMS", MSG);
    expect(r.status).toBe("NO_TRANSPORT");
  });
});

describe("SMS transport — only a real 2xx is SENT", () => {
  const cfg = { accountSid: "ACtest", authToken: "tok", from: "+15550000000" };
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  const stubFetch = (status: number, body: string) => {
    globalThis.fetch = (async () =>
      new Response(body, { status })) as unknown as typeof globalThis.fetch;
  };

  test("a 2xx carrying a message SID is SENT", async () => {
    stubFetch(201, JSON.stringify({ sid: "SM123", status: "queued" }));
    const r = await new SmsTransport(cfg).send(MSG);
    expect(r.status).toBe("SENT");
  });

  test("a 2xx with an ERROR body is NOT success", async () => {
    // The case the brief calls out: HTTP 200 does not mean delivered. Twilio
    // returns a structured error even on some 2xx paths, and a malformed body
    // with no SID is not evidence of a queued message.
    stubFetch(200, JSON.stringify({ error: true, message: "unroutable" }));
    const r = await new SmsTransport(cfg).send(MSG);
    expect(r.status).toBe("FAILED");
    expect(r.status === "FAILED" && r.reason).toBe("MALFORMED_SUCCESS_RESPONSE");
  });

  test("a non-2xx retains the provider error code", async () => {
    stubFetch(400, JSON.stringify({ code: 21211, message: "invalid 'To' number" }));
    const r = await new SmsTransport(cfg).send(MSG);
    expect(r.status).toBe("FAILED");
    if (r.status === "FAILED") {
      expect(r.reason).toContain("TWILIO_21211");
      expect(r.reason).toContain("invalid 'To' number");
    }
  });

  test("a network error is FAILED with NETWORK_ERROR", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const r = await new SmsTransport(cfg).send(MSG);
    expect(r.status).toBe("FAILED");
    if (r.status === "FAILED") expect(r.reason).toBe("NETWORK_ERROR");
  });

  test("the auth token never appears in the returned detail", async () => {
    stubFetch(400, JSON.stringify({ code: 20003, message: "auth failed" }));
    const r = await new SmsTransport(cfg).send(MSG);
    expect(JSON.stringify(r)).not.toContain(cfg.authToken);
    expect(JSON.stringify(r)).not.toContain("ACtest");
  });
});

describe("webhook transport — status is not evidence of delivery", () => {
  let savedFetch: typeof globalThis.fetch;
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedUrl = process.env.FGMP_WEBHOOK_URL;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.FGMP_WEBHOOK_URL;
    else process.env.FGMP_WEBHOOK_URL = savedUrl;
  });

  const withWebhook = async (status: number, body = "ok") => {
    process.env.FGMP_WEBHOOK_URL = "https://hooks.example/fgmp";
    globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;
    return dispatch("WHATSAPP", MSG);
  };

  test("a 2xx is SENT", async () => {
    const r = await withWebhook(200);
    expect(r.status).toBe("SENT");
  });

  test("a 4xx is FAILED and retains the status code", async () => {
    const r = await withWebhook(422, '{"error":"unknown alarm"}');
    expect(r.status).toBe("FAILED");
    if (r.status === "FAILED") expect(r.reason).toBe("HTTP_422");
  });

  test("a 5xx is FAILED", async () => {
    const r = await withWebhook(503);
    expect(r.status).toBe("FAILED");
  });

  test("a timeout is FAILED but flagged AMBIGUOUS, not silently retried", async () => {
    // Retrying an ambiguous webhook risks a double page for one alarm.
    process.env.FGMP_WEBHOOK_URL = "https://hooks.example/fgmp";
    globalThis.fetch = (async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof globalThis.fetch;
    const r = await dispatch("WHATSAPP", MSG);
    expect(r.status).toBe("FAILED");
    if (r.status === "FAILED") expect(r.reason).toBe("TIMEOUT_AMBIGUOUS");
  });

  test("the webhook secret never appears in the outcome", async () => {
    process.env.FGMP_WEBHOOK_URL = "https://hooks.example/fgmp";
    process.env.FGMP_WEBHOOK_SECRET = "whsec_topsecret";
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch;
    const r = await dispatch("WHATSAPP", MSG);
    expect(JSON.stringify(r)).not.toContain("whsec_topsecret");
    delete process.env.FGMP_WEBHOOK_SECRET;
  });
});

describe("the three outcomes stay distinguishable", () => {
  let savedFetch: typeof globalThis.fetch;
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedUrl = process.env.FGMP_WEBHOOK_URL;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.FGMP_WEBHOOK_URL;
    else process.env.FGMP_WEBHOOK_URL = savedUrl;
  });

  test("NO_TRANSPORT, FAILED and SENT are three distinct results", async () => {
    delete process.env.FGMP_WEBHOOK_URL;
    const notConfigured = await dispatch("WHATSAPP", MSG);
    expect(notConfigured.status).toBe("NO_TRANSPORT");

    process.env.FGMP_WEBHOOK_URL = "https://hooks.example/fgmp";
    globalThis.fetch = (async () => new Response("x", { status: 500 })) as unknown as typeof globalThis.fetch;
    const failed = await dispatch("WHATSAPP", MSG);
    expect(failed.status).toBe("FAILED");

    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof globalThis.fetch;
    const sent = await dispatch("WHATSAPP", MSG);
    expect(sent.status).toBe("SENT");

    // The three must not collapse into one.
    expect(new Set([notConfigured.status, failed.status, sent.status]).size).toBe(3);
    // And the two failure modes must carry different reasons.
    expect((notConfigured as { reason: string }).reason).not.toBe(
      (failed as { reason: string }).reason,
    );
  });
});