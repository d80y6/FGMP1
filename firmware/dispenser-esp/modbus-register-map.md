# FGMP Fuel Dispenser — Modbus RTU Register Map

This document specifies the wire-level Modbus RTU register map exposed by the
fuel dispenser, the JSON payload conventions used by the FGMP ESP firmware,
and worked examples of every Modbus function code the firmware actually emits.

## 1. Conventions

- **Modbus RTU** over **RS485**, 2-wire half-duplex.
- Default line parameters: **9600 baud, 8N1**, no parity.
- Slave address range **1–247**. The default address is `1`.
- 3.5-character inter-frame gap on the wire (~1.75 ms at 9600 baud).
- All multi-byte values are **big-endian** on the wire.
- 32-bit and float values occupy **two consecutive 16-bit registers**, high
  word first (big-endian word order). This matches the vast majority of
  dispensers; if your vendor uses low-word-first, swap the order in
  `decodeU32()` / `decodeFloat()` in the firmware.
- Register addresses in this document use the **5-digit Modicon convention**
  (e.g. `40001`); the value actually transmitted in the Modbus frame is the
  0-based protocol address (`0x0000`).

## 2. Holding-register map

| Modicon | Addr (hex) | Type  | R/W | Unit   | Field                  | Description                                                                  |
|---------|-----------|-------|-----|--------|------------------------|------------------------------------------------------------------------------|
| 40001   | 0x0000    | u16   | R   | enum   | device_status          | 0=OFFLINE, 1=IDLE, 2=AUTHORIZED, 3=DISPENSING, 4=COMPLETED, 5=FAULT         |
| 40002   | 0x0001    | u32   | R   | 0.1 L  | current_volume_l       | Active transaction volume. Encoded as u32 with 0.1 L resolution.            |
| 40003   | 0x0003    | float | R   | L/min  | flow_rate_lpm          | Instantaneous flow rate (IEEE-754 single precision).                         |
| 40004   | 0x0005    | u32   | R/W | 0.1 L  | preset_volume_l        | Authorized preset limit; 0 = no preset. Read by dispenser on authorize.     |
| 40005   | 0x0007    | u16   | R   | enum   | nozzle_state           | 0=IN_HOLSTER, 1=OUT, 2=OUT_LOCKED                                           |
| 40010   | 0x0009    | u32   | R   | 0.1 L  | totalizer_litres       | Lifetime non-resettable cumulative volume.                                   |
| 40011   | 0x000B    | u16   | R   | count  | transaction_count      | Cumulative transactions since manufacture.                                   |
| 40020   | 0x0013    | u16   | R/W | enum   | authorize_command      | Write `1` to authorize. The dispenser copies 40004 into its preset latch.   |
| 40021   | 0x0014    | u16   | R/W | enum   | stop_command           | Write `1` to halt the active transaction immediately.                       |
| 40022   | 0x0015    | u16   | R/W | enum   | reset_command          | Write `1` to clear transaction state and return to IDLE.                    |
| 40030   | 0x001D    | int16 | R   | °C     | temperature_c          | Fluid temperature at the nozzle (signed).                                   |
| 40040   | 0x0027    | u16   | R   | bitmap | error_code             | Bitfield, see §4.                                                            |
| 40050   | 0x0031    | u16   | R   | BCD    | firmware_version       | e.g. `0x0103` = 1.03.                                                        |

### 2.1 State machine values for `device_status` (40001)

```
   OFFLINE ─┐
            │ power-up
            ▼
          IDLE ───── authorize_command=1 ─────► AUTHORIZED
            ▲                                       │
            │                                       │ nozzle lifted +
            │                                       │ flow detected
            │                                       ▼
            │ reset_command=1                   DISPENSING
            │                                       │
            │                                       │ nozzle returned +
            │                                       │ preset reached
            │                                       ▼
            └────────────────────────────────── COMPLETED
                                                │
                                                │ error_code != 0
                                                ▼
                                              FAULT ───── reset_command=1 ─► IDLE
```

### 2.2 Notes on 32-bit / float encoding

`current_volume_l` (40002) occupies registers `0x0001` and `0x0002`. The
high word is at `0x0001`. So a value of 12.5 L is encoded as `0x0000007D`
(125 × 10⁻¹ L = 12.5 L), sent on the wire as:

```
reg 0x0001 = 0x0000    high word
reg 0x0002 = 0x007D    low word
```

`flow_rate_lpm` (40003) occupies registers `0x0003` and `0x0004` and is the
4-byte IEEE-754 single-precision representation of the float, high word first.

## 3. Function codes used by the ESP firmware

| Function | Code | Used for                                      |
|----------|------|-----------------------------------------------|
| Read Holding Registers | 0x03 | All telemetry reads (the ESP batches 9 consecutive registers per poll for the status block, then a few single-reg reads). |
| Write Single Register  | 0x06 | authorize / stop / reset / preset writes.    |

The ESP does **not** use function codes 0x10 (write multiple) or 0x04 (read
input registers). If a future dispenser revision requires multi-register
preset writes, add a `modbusWriteMultiple()` helper using function 0x10.

## 4. `error_code` bitmap (40040)

| Bit | Mask    | Meaning                                                       |
|-----|---------|---------------------------------------------------------------|
| 0   | 0x0001  | flow_meter_fault — pulses stopped mid-dispense                |
| 1   | 0x0002  | nozzle_fault — reed switch stuck                              |
| 2   | 0x0004  | comm_fault — internal dispenser MCU lost contact with pump    |
| 3   | 0x0008  | over_temp — fluid temperature exceeded 60 °C                  |
| 4   | 0x0010  | over_pressure                                                |
| 5   | 0x0020  | preset_mismatch — delivered volume differs from preset > 2 % |
| 6   | 0x0040  | power_glitch — brown-out detected                            |
| 7   | 0x0080  | tamper — enclosure open / pulse-line cut                     |
| 8–15|         | vendor-specific — log only, do not auto-interpret.            |

`0x0000` = no error. Any non-zero bit auto-transitions the dispenser to
`FAULT` (state 5).

## 5. Worked Modbus frames

### 5.1 Read holding registers (function 0x03) — read `device_status` through `nozzle_state` (9 registers, 0x0000–0x0008)

**Request** (8 bytes, slave = 0x01):

```
01 03 00 00 00 09 CRC_LO CRC_HI
```

Computing the CRC-16 over `01 03 00 00 00 09`:

```
poly 0xA001, init 0xFFFF
byte 0x01  -> crc = 0xFFFE
byte 0x03  -> crc = 0xFFFD
byte 0x00  -> crc = 0xFFFD
byte 0x00  -> crc = 0xFFFD
byte 0x00  -> crc = 0xFFFD
byte 0x09  -> crc = 0xD5F4  -> swap bytes -> 0xF4D5
```

Final on-wire request (note Modbus RTU appends CRC low byte first):

```
01 03 00 00 00 09 F4 D5
```

**Response** (slave = 0x01, function = 0x03, byte count = 18 = 2 × 9):

Suppose the dispenser is currently **DISPENSING** (status = 3),
**current_volume_l = 12.5 L** (encoded as `0x0000007D`),
**flow_rate_lpm = 38.7** (IEEE-754 `0x421A6666`),
**preset_volume_l = 50.0 L** (encoded as `0x000001F4`),
**nozzle_state = 1 (OUT)**.

```
01 03 12
   00 03          device_status    = 0x0003 (DISPENSING)
   00 00          current_volume_l high word
   00 7D          current_volume_l low word  -> 0x0000007D = 125 -> 12.5 L
   42 1A          flow_rate_lpm    high word
   66 66          flow_rate_lpm    low word  -> 0x421A6666 = 38.7 L/min
   00 00          preset_volume_l  high word
   01 F4          preset_volume_l  low word  -> 0x000001F4 = 500 -> 50.0 L
   00 01          nozzle_state     = 0x0001 (OUT)
   CRC_LO CRC_HI
```

Final on-wire response (CRC computed over `01 03 12 00 03 00 00 00 7D 42 1A
66 66 00 00 01 F4 00 01` → `0xE591`, swapped on the wire as `91 E5`):

```
01 03 12 00 03 00 00 00 7D 42 1A 66 66 00 00 01 F4 00 01 91 E5
```

### 5.2 Write single register (function 0x06) — authorize command (40020 → 0x0013)

**Request** (8 bytes, slave = 0x01, register 0x0013, value 0x0001):

```
01 06 00 13 00 01 CRC_LO CRC_HI
```

CRC-16 over `01 06 00 13 00 01` = `0x0897` → wire `97 08`.

Final on-wire request:

```
01 06 00 13 00 01 97 08
```

**Response** (echo of the request, validated by the ESP):

```
01 06 00 13 00 01 97 08
```

The ESP treats the write as successful only when the echoed response matches
the request byte-for-byte (slave, function, register, value) AND the CRC is
valid. Any mismatch (or a timeout / 0x86 exception frame) is logged and the
command is ACKed back to the platform as `failed`.

### 5.3 Authorize with preset (combined write sequence)

To authorize a transaction for **50.0 L** the ESP first writes the preset
register `40004` (two writes because function 0x06 only handles one 16-bit
register at a time), then writes `1` to `40020`:

```
Step 1: 01 06 00 05 00 00 99 CA      <- preset_volume_l high word = 0
Step 2: 01 06 00 06 01 F4 18 0A      <- preset_volume_l low word  = 0x01F4 (500)
Step 3: 01 06 00 13 00 01 97 08      <- authorize_command = 1
```

> If a future firmware revision moves to function 0x10 (Write Multiple
> Registers), steps 1+2 collapse into a single 5-byte write. Until then the
> firmware issues two consecutive 0x06 frames; the dispenser's internal logic
> does not latch the preset until `authorize_command=1` is received, so the
> ordering is safe.

### 5.4 Exception responses

If the dispenser cannot execute a request it returns a Modbus exception
frame. The function code has its high bit set (e.g. `0x83` for `0x03`,
`0x86` for `0x06`) and a single exception code byte follows:

```
01 86 02 99 30      <- slave=01, fn=0x06 exception, code=02 (illegal data address)
```

Common codes seen in the field:

| Code | Meaning                     | Most common cause                                       |
|------|-----------------------------|---------------------------------------------------------|
| 01   | Illegal function            | Dispenser firmware does not implement 0x06 on this reg. |
| 02   | Illegal data address        | Register offset out of range for this vendor.           |
| 03   | Illegal data value          | e.g. writing 0 to authorize_command.                    |
| 04   | Slave device failure        | Internal dispenser MCU fault — see register 40040.      |
| 06   | Slave device busy           | Try again later (dispenser still pumping).              |

The ESP firmware logs any exception response as `[mb] fn=0x8X code=NN` and
treats the operation as failed; the platform receives an ACK with
`status="failed"` for the corresponding command.

## 6. CRC-16 reference (Modbus RTU variant)

The CRC is the CRC-16/ARC variant: polynomial `0xA001`, initial value
`0xFFFF`, reflected input/output, final XOR `0x0000`. Reference C code (this
is what the ESP firmware uses):

```c
uint16_t modbusCrc(const uint8_t* buf, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)buf[i];
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : (crc >> 1);
    }
  }
  return crc;          // transmit low byte first, then high byte
}
```

Cross-check with `pip install crcmod` and `crcmod.mkCrcFun(0x18005, rev=True,
initCrc=0xFFFF, xorOut=0x0000)`.

## 7. Validation cheatsheet

| Test                                                  | Expected result                                                                 |
|-------------------------------------------------------|---------------------------------------------------------------------------------|
| Disconnect A/B at the dispenser                       | ESP log: `[mb] read block ... failed`; LED goes to triple-pulse pattern.        |
| Short A to B                                          | Dispenser reports comm fault; ESP never receives a valid frame.                 |
| Swap A and B (polarity inverted)                      | All reads fail; flip the wires at one node and re-test.                         |
| Send `authorize_command=1` while dispenser is FAULT   | Exception 0x86 code 04; ESP ACKs as `failed`.                                   |
| Power-cycle ESP mid-dispense                          | ESP reboots; on next 2 s poll reads `device_status=DISPENSING` and resumes accumulating without double-counting. |
| Send `reset_command=1` while dispensing               | Dispenser transitions to IDLE; `transaction_count` does **not** increment (reset is not a transaction completion). |
| Send `stop_command=1` after transaction completes     | No-op; ACK `applied` (the dispenser accepts the write but state is already IDLE/COMPLETED). |
