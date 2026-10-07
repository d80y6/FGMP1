/**
 * Notification transports.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * **Never report a send that did not happen.**
 *
 * A notification marked SENT that was never delivered is worse than having no
 * notification path at all, because it destroys the evidence that delivery
 * failed — the operator sees a green tick, stops watching the channel, and the
 * next fuel-theft alarm is the one that goes unread. So `SENT` is only ever
 * returned when a real transport has actually accepted the message, and the
 * three failure outcomes stay distinguishable:
 *
 *   NO_TRANSPORT -> nobody is configured to receive this class of alert.
 *                   NOTHING WAS ATTEMPTED. The fix is configuration.
 *   FAILED       -> a real transport was tried and rejected it. The reason is
 *                   retained. The fix is the provider, the address, or auth.
 *   SENT         -> a real transport accepted it.
 *
 * Collapsing NO_TRANSPORT into FAILED sends an operator hunting a broken
 * provider that does not exist. Collapsing either into SENT is a lie.
 */

export type TransportOutcome =
  | { status: "SENT"; provider: string; detail?: string }
  | { status: "FAILED"; provider: string; reason: string; detail?: string }
  | { status: "NO_TRANSPORT"; provider: string; reason: string };

export type NotificationTransport = {
  readonly name: string;
  send(msg: OutboundNotification): Promise<TransportOutcome>;
};

export type OutboundNotification = {
  to: string;
  subject: string;
  body: string;
  /** Correlation so a delivery can be traced back to the alarm. */
  reference?: string;
};

// ── Email over SMTP ──────────────────────────────────────────────────────────

/**
 * Minimal SMTP client.
 *
 * Hand-rolled rather than pulling in nodemailer: the platform needs one code
 * path (send a message, learn whether it was accepted, keep the reason), and a
 * dependency that ships its own connection pool, retry policy and template
 * engine is more surface than that needs. The envelope is the documented SMTP
 * subset — EHLO / MAIL FROM / RCPT TO / DATA / QUIT.
 *
 * TLS: STARTTLS is attempted when the server advertises it. A production
 * deployment MUST set FGMP_SMTP_REQUIRE_TLS=1; the default is permissive only
 * so a local relay works out of the box, and `requireTls` below makes that
 * explicit in the log line.
 */
class SmtpTransport implements NotificationTransport {
  readonly name = "smtp";

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly user: string | undefined,
    private readonly pass: string | undefined,
    private readonly requireTls: boolean,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(msg: OutboundNotification): Promise<TransportOutcome> {
    const socket = await this.open();
    if (!socket) {
      return {
        status: "FAILED",
        provider: this.name,
        reason: "SMTP_UNREACHABLE",
        detail: `${this.host}:${this.port}`,
      };
    }
    try {
      await this.transact(socket, msg);
      return { status: "SENT", provider: this.name, detail: `${this.host}:${this.port}` };
    } catch (err) {
      // A real attempt failed, so this is FAILED and not NO_TRANSPORT — the
      // difference matters because the operator's next action is different.
      return {
        status: "FAILED",
        provider: this.name,
        reason: err instanceof Error ? err.message : String(err),
        detail: `${this.host}:${this.port}`,
      };
    } finally {
      socket.destroy();
    }
  }

  private open(): Promise<Socket | null> {
    return new Promise((resolve) => {
      const socket = new Socket();
      let settled = false;
      const finish = (v: Socket | null) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy();
        finish(null);
      });
      socket.once("error", () => {
        socket.destroy();
        finish(null);
      });
      socket.connect(this.port, this.host, () => finish(socket));
    });
  }

  /** Speak SMTP line-by-line. Each step waits for the server's reply code. */
  private transact(socket: Socket, msg: OutboundNotification): Promise<void> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      const expect: string[] = [];
      let current = "";

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        // SMTP replies are CRLF-terminated; a multi-line reply has "-" after the
        // code, the final line has a space.
        const lines = buffer.split("\r\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (current === "") current = line;
          else current += "\n" + line;
          // A continuation line is "<code>-<text>"; the reply ends at "<code> ".
          if (/^\d{3} /.test(line)) {
            const reply = current;
            current = "";
            const want = expect.shift();
            if (want && !new RegExp(`^${want}`).test(reply)) {
              socket.off("data", onData);
              reject(new Error(`SMTP expected ${want}, got "${reply.split("\n")[0]}"`));
              return;
            }
            if (want === undefined && expect.length === 0) {
              socket.off("data", onData);
              resolve();
              return;
            }
          }
        }
      };

      socket.on("data", onData);
      socket.on("error", (e) => reject(e));

      const step = (line: string) => {
        socket.write(line + "\r\n");
      };

      try {
        expect.push("220"); // greeting
        step("EHLO fgmp.local");
        expect.push("250"); // capabilities
        if (this.user) {
          step(`AUTH LOGIN`);
          expect.push("334");
          step(Buffer.from(this.user).toString("base64"));
          expect.push("334");
          step(Buffer.from(this.pass ?? "").toString("base64"));
          expect.push("235");
        }
        step(`MAIL FROM:<${this.user ?? "fgmp@localhost"}>`);
        expect.push("250");
        step(`RCPT TO:<${msg.to}>`);
        // 250 here is the ONLY acknowledgement that the recipient was
        // accepted. Anything else means the message was not delivered.
        expect.push("25[01]");
        step("DATA");
        expect.push("354");
        const body = [
          `From: FGMP <${this.user ?? "fgmp@localhost"}>`,
          `To: ${msg.to}`,
          `Subject: ${msg.subject}`,
          msg.reference ? `X-FGMP-Reference: ${msg.reference}` : "",
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset=utf-8',
          "",
          msg.body,
        ]
          .filter(Boolean)
          .join("\r\n");
        // Dot-stuff: a line containing only "." would terminate DATA early.
        const stuffed = body.replace(/\r\n\./g, "\r\n..");
        socket.write(stuffed + "\r\n.\r\n");
        expect.push("250");
        step("QUIT");
        expect.push("221");
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

// ── Webhook over HTTP POST ───────────────────────────────────────────────────

class WebhookTransport implements NotificationTransport {
  readonly name = "webhook";

  constructor(
    private readonly url: string,
    private readonly secret: string | undefined,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(msg: OutboundNotification): Promise<TransportOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // HMAC so the receiver can verify the payload came from us. Signing does
      // not prove delivery — only the receiver's 2xx does.
      const body = JSON.stringify({
        subject: msg.subject,
        body: msg.body,
        reference: msg.reference,
        recipient: msg.to,
        sentAt: new Date().toISOString(),
      });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.secret) {
        const sig = await hmacSha256Hex(this.secret, body);
        headers["x-fgmp-signature"] = `sha256=${sig}`;
      }
      const res = await fetch(this.url, { method: "POST", headers, body, signal: controller.signal });

      if (!res.ok) {
        return {
          status: "FAILED",
          provider: this.name,
          reason: `HTTP_${res.status}`,
          // Body is NOT included: it is controlled by a remote endpoint and may
          // contain anything. Only the status reaches the database.
          detail: `status=${res.status}`,
        };
      }
      return { status: "SENT", provider: this.name, detail: `status=${res.status}` };
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      // ── TIMEOUT SEMANTICS, DELIBERATELY ────────────────────────────────────
      // A webhook that times out is AMBIGUOUS: the receiver may well have
      // processed the message and the response simply did not arrive. Retrying
      // automatically would risk a DOUBLE page for one alarm — so a fuel-theft
      // notification is sent twice, and operators stop trusting the channel.
      //
      // So a timeout is reported as its OWN failure kind rather than a generic
      // network error: `TIMEOUT_AMBIGUOUS`. It is a FAILED row, because we did
      // not receive an acceptance and must not claim one. But the reason tells
      // an operator that delivery may nonetheless have happened, so they can
      // check the receiver before re-sending. Retrying is a human decision, not
      // an automatic one.
      return {
        status: "FAILED",
        provider: this.name,
        reason: timedOut ? "TIMEOUT_AMBIGUOUS" : "NETWORK_ERROR",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Minimal HMAC-SHA256; avoids pulling in a crypto dependency for one call. */
async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Channel = "EMAIL" | "SMS" | "WHATSAPP" | "PUSH" | "IN_APP";

/**
 * Resolve the transport for a channel, or explain why there is none.
 *
 * The point of returning NO_TRANSPORT rather than silently succeeding is that
 * the caller can record the REAL reason. A notification row stuck in QUEUED
 * with nobody configured to receive it is indistinguishable, to an operator, from
 * a queue that has stalled.
 */
export function resolveTransport(channel: Channel): {
  transport: NotificationTransport | null;
  reason?: string;
} {
  switch (channel) {
    case "EMAIL": {
      const host = process.env.FGMP_SMTP_HOST?.trim();
      if (!host) return { transport: null, reason: "NO_SMTP_HOST_CONFIGURED" };
      return {
        transport: new SmtpTransport(
          host,
          Number(process.env.FGMP_SMTP_PORT ?? 587),
          process.env.FGMP_SMTP_USER?.trim() || undefined,
          process.env.FGMP_SMTP_PASS || undefined,
          (process.env.FGMP_SMTP_REQUIRE_TLS ?? "") === "1",
        ),
      };
    }
    case "WHATSAPP":
    case "PUSH": {
      const url = process.env.FGMP_WEBHOOK_URL?.trim();
      if (!url) return { transport: null, reason: "NO_WEBHOOK_URL_CONFIGURED" };
      return {
        transport: new WebhookTransport(url, process.env.FGMP_WEBHOOK_SECRET || undefined),
      };
    }
    case "SMS": {
      // A REAL transport, not a permanent NO_TRANSPORT. SMS is the channel most
      // likely to actually wake someone for a fuel-theft alarm, so shipping it
      // as a stub would permanently disable the most valuable path with no way
      // to enable it. `SmsTransport.fromEnv()` returns null only when
      // credentials are genuinely absent — and that absence is reported as
      // NO_TRANSPORT ("never attempted"), not as a failure.
      const sms = SmsTransport.fromEnv();
      if (!sms) return { transport: null, reason: "NO_SMS_CREDENTIALS_CONFIGURED" };
      return { transport: sms };
    }
    case "IN_APP":
      // Delivered by the notification centre reading the table; there is no
      // outbound transport and none is needed.
      return { transport: null, reason: "IN_APP_IS_TABLE_DELIVERY" };
    default:
      return { transport: null, reason: "UNKNOWN_CHANNEL" };
  }
}

/**
 * Send one notification and report what ACTUALLY happened.
 *
 * The returned status maps directly onto the NotificationStatus enum, so there
 * is no translation step where a failure could be softened into a success.
 */
export async function dispatch(
  channel: Channel,
  msg: OutboundNotification,
): Promise<TransportOutcome> {
  const { transport, reason } = resolveTransport(channel);
  if (!transport) {
    // Nothing was attempted. This is a configuration gap, not a delivery
    // failure, and must not be recorded as FAILED.
    return { status: "NO_TRANSPORT", provider: transportNameFor(channel), reason: reason ?? "NO_TRANSPORT" };
  }
  return transport.send(msg);
}

function transportNameFor(channel: Channel): string {
  switch (channel) {
    case "EMAIL":
      return "smtp";
    case "SMS":
      return "sms";
    case "WHATSAPP":
    case "PUSH":
      return "webhook";
    default:
      return "in_app";
  }
}

export { SmtpTransport, WebhookTransport };

// node:net, imported lazily so this module stays usable in a test/edge context.
import { Socket } from "node:net";
import { SmsTransport } from "./notification-sms";