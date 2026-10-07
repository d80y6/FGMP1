/**
 * SMS transport — a REAL send over a provider's HTTP API.
 *
 * ── WHY THIS EXISTS RATHER THAN A PERMANENT NO_TRANSPORT ─────────────────────
 * An earlier revision returned NO_TRANSPORT unconditionally for SMS. That is
 * not a transport; it is a second way of saying "not configured", and it would
 * have left a CRITICAL channel permanently dead with no path to enable it. SMS
 * is the channel most likely to actually wake someone for a fuel-theft alarm,
 * so it is the one least acceptable to ship as a stub.
 *
 * So this performs a genuine HTTPS send when credentials are present, and
 * reports NO_TRANSPORT — never attempted — when they are absent.
 *
 * ── PROVIDER: Twilio ─────────────────────────────────────────────────────────
 * Twilio's Messages API is used because it is the common case and the request is
 * plain form-encoded HTTPS with Basic auth. The shape is provider-specific and
 * this class is exported so another provider can be added without touching the
 * dispatcher.
 *
 * ── WHAT COUNTS AS SUCCESS ───────────────────────────────────────────────────
 * ONLY an HTTP 2xx from the provider counts. A 200 carrying an error payload, a
 * timeout, or an empty response are all failures, and each retains its own
 * reason. There is no path through this class that returns SENT without a real
 * 2xx having been received.
 */

import type { NotificationTransport, OutboundNotification, TransportOutcome } from "./notification-transport";

type TwilioConfig = {
  accountSid: string;
  authToken: string;
  from: string;
};

function readTwilioConfig(): TwilioConfig | null {
  const accountSid = process.env.FGMP_SMS_ACCOUNT_SID?.trim();
  const authToken = process.env.FGMP_SMS_AUTH_TOKEN?.trim();
  const from = process.env.FGMP_SMS_FROM?.trim();
  if (!accountSid || !authToken || !from) return null;
  return { accountSid, authToken, from };
}

export class SmsTransport implements NotificationTransport {
  readonly name = "twilio";

  constructor(
    private readonly cfg: TwilioConfig,
    private readonly timeoutMs = 10_000,
  ) {}

  static fromEnv(): SmsTransport | null {
    const cfg = readTwilioConfig();
    return cfg ? new SmsTransport(cfg) : null;
  }

  async send(msg: OutboundNotification): Promise<TransportOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          // Basic auth over TLS. The token is never logged and never included
          // in the returned detail — only the status and provider SID are.
          authorization:
            "Basic " +
            Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: msg.to,
          From: this.cfg.from,
          Body: `${msg.subject}: ${msg.body}`,
        }),
        signal: controller.signal,
      });

      // Read the body regardless of status: Twilio returns a structured error
      // with a code and message on failure, and that reason is exactly what an
      // operator needs to act. Bounded, because the provider is not trusted.
      const text = (await res.text().catch(() => "")).slice(0, 500);

      if (!res.ok) {
        const parsed = parseTwilioError(text);
        return {
          status: "FAILED",
          provider: this.name,
          // Twilio error codes are actionable: 21211 is an invalid number,
          // 21614 is an unverified sender. Losing them makes the failure
          // unactionable.
          reason: parsed ? `TWILIO_${parsed.code}: ${parsed.message}` : `HTTP_${res.status}`,
          detail: `status=${res.status}`,
        };
      }

      // A 2xx with an unparseable or error-shaped body is NOT treated as
      // success. This is the "200 with an error body" case: the status alone is
      // not evidence of delivery.
      const sid = extractSid(text);
      if (!sid) {
        return {
          status: "FAILED",
          provider: this.name,
          reason: "MALFORMED_SUCCESS_RESPONSE",
          detail: `status=${res.status} body did not contain a message SID`,
        };
      }
      // SID only, never the body — it could echo recipient content.
      return { status: "SENT", provider: this.name, detail: `sid=${sid}` };
    } catch (err) {
      const reason = err instanceof Error && err.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
      return { status: "FAILED", provider: this.name, reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Pull the message SID out of a Twilio JSON response. */
function extractSid(body: string): string | null {
  try {
    const json = JSON.parse(body) as { sid?: unknown };
    return typeof json.sid === "string" && json.sid.length > 0 ? json.sid : null;
  } catch {
    return null;
  }
}

function parseTwilioError(body: string): { code: number; message: string } | null {
  try {
    const json = JSON.parse(body) as { code?: unknown; message?: unknown };
    if (typeof json.code === "number" && typeof json.message === "string") {
      return { code: json.code, message: json.message.slice(0, 120) };
    }
    return null;
  } catch {
    return null;
  }
}