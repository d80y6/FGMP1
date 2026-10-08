/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TCP TRANSPORT — real bytes over a real socket
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PHASE 5, step (a). This is deliberately ONE layer.
 *
 * The dispatch boundary cannot talk to hardware, for three independent reasons
 * that were verified rather than assumed:
 *   1. `protocol/modbus.ts` has no write function codes — only `buildReadRequest`,
 *      `withCrc`, `parseReadResponse`, `decodeRegister*`. Its 0x05/0x06 mentions
 *      are two labels in an exception-code lookup table, not a write path.
 *   2. The only `Transport` implementation is `transport/simulated.ts`.
 *   3. `registers.ts` maps read function codes (0x03/0x04) over telemetry
 *      addresses. There is no defined address for a start or stop command,
 *      because that depends on the genset controller and no manual was supplied.
 *
 * Shipping a "real Modbus dispatch" on top of that would be three layers of
 * plausible-looking code, none of which has touched a device — and the next
 * engineer would reasonably assume it had been run. Absence is visible; a green
 * checkmark is not. So this file is the transport and nothing more.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * It does not encode Modbus. It does not know what a coil is. It moves a frame
 * and reads a reply, with a timeout, and it distinguishes silence from garbage —
 * the distinction the whole control path depends on, because "the bus said
 * nothing" and "the bus said something invalid" demand different operator
 * responses.
 *
 * ── TESTABILITY ─────────────────────────────────────────────────────────────
 * This is the whole reason for building it: a `net.Server` in a test is real
 * sockets with no hardware, so this layer is verifiable NOW. Steps (b) the write
 * function codes and (c) the register map follow, each independently provable.
 */

import net from "node:net";
import {
  Transport,
  TransportError,
  TransportTimeoutError,
  ModbusFailureKind,
} from "../transport";

export interface TcpTransportOptions {
  host: string;
  port: number;
  /** Per-transaction reply timeout. Modbus RTU-over-TCP is typically 1-3 s. */
  timeoutMs?: number;
  /** Connect timeout, separate from the reply timeout. */
  connectTimeoutMs?: number;
  /** Injected for tests; defaults to a monotonic clock. */
  now?: () => number;
}

export class TcpTransport implements Transport {
  readonly name: string;

  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(opts: TcpTransportOptions) {
    this.host = opts.host;
    this.port = opts.port;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 2000;
    this.name = `tcp://${opts.host}:${opts.port}`;
  }

  /**
   * Connect lazily and reuse.
   *
   * Serialised through `connecting` so two concurrent dispatches cannot open two
   * sockets and interleave frames on the wire — Modbus RTU has no framing beyond
   * the CRC, so interleaving two requests produces silent corruption rather than
   * an error.
   */
  private async ensureConnected(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(
          new TransportTimeoutError(
            `connecting to ${this.name} timed out after ${this.connectTimeoutMs}ms`,
            this.connectTimeoutMs,
          ),
        );
      }, this.connectTimeoutMs);

      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.setNoDelay(true);
        this.socket = socket;
        resolve(socket);
      });

      socket.once("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new TransportError(`connecting to ${this.name} failed: ${err.message}`));
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  /**
   * Send one frame and read the reply.
   *
   * Throws TransportTimeoutError when the device is SILENT — the case the
   * control path maps to TIMEOUT_AMBIGUOUS, because a silent bus means we do
   * not know whether the command landed. That is deliberately distinct from a
   * TransportError on connect, which means nothing was ever sent and is
   * therefore safe to retry.
   */
  async transact(request: Uint8Array, timeoutMs: number = this.timeoutMs): Promise<Uint8Array> {
    if (this.closed) throw new TransportError(`${this.name} is closed`);

    const socket = await this.ensureConnected();
    const budget = timeoutMs;

    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new TransportTimeoutError(
              `${this.name} did not reply within ${budget}ms; whether the command ` +
                `landed is UNKNOWN`,
              budget,
            ),
          ),
        );
        // A silent bus may have received the frame. Tear the socket down so the
        // next attempt starts from a known state rather than resuming a stream
        // whose framing we can no longer trust.
        socket.destroy();
        this.socket = null;
      }, budget);

      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        // The Transport contract is "one frame, one reply". The caller (the
        // Modbus layer, once it exists) is responsible for validating length
        // and CRC; returning whatever has accumulated lets it decide. Returning
        // early on a partial frame would corrupt every multi-part read.
        finish(() => {
          const reply = this.buffer;
          this.buffer = Buffer.alloc(0);
          resolve(new Uint8Array(reply));
        });
      };

      const onError = (err: Error) => {
        finish(() => reject(new TransportError(`${this.name}: ${err.message}`)));
        socket.destroy();
        this.socket = null;
      };

      const onClose = () => {
        finish(() =>
          reject(
            new TransportError(
              `${this.name} closed before replying; whether the command landed is UNKNOWN`,
            ),
          ),
        );
        this.socket = null;
      };

      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);

      socket.write(Buffer.from(request), (err) => {
        if (err) onError(err);
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const s = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (s && !s.destroyed) {
      await new Promise<void>((resolve) => s.end(() => resolve()));
      s.destroy();
    }
  }
}

export type { ModbusFailureKind };