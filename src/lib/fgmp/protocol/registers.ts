/**
 * Modbus register maps for the device classes this platform actually models.
 *
 * Register addresses and scaling factors are DEVICE-SPECIFIC. They are declared
 * here as data rather than scattered through decoding code because a register
 * map is a datasheet fact, not an algorithm: it belongs in one table a
 * technician can compare against a manual, with units attached, so a wrong
 * scale factor (mm vs cm, deci-degrees vs degrees) is visible on sight instead
 * of buried in an arithmetic expression.
 *
 * Address conventions used throughout:
 *   - Modbus PDU register addresses are ZERO-BASED and 16-bit. A datasheet
 *     saying "40001" is the zero-based address 0.
 *   - `register` below is the ZERO-BASED address to put on the wire.
 *
 * Scaling: Modbus has no notion of units, so a tank at 3500 mm may report 3500,
 * 350.0 or 35.00 depending on the instrument. `scale` converts the raw integer
 * to engineering units; `offset` handles devices that report a signed value
 * biased by a base. Getting this wrong yields plausible numbers that are wrong
 * by a factor of 10, which is worse than an obvious failure.
 */

/** Function codes this implementation supports, named for readability. */
export const READ_HOLDING_REGISTERS = 0x03
export const READ_INPUT_REGISTERS = 0x04

/**
 * Signed interpretation for a 16-bit register.
 *
 * Modbus 16-bit registers are unsigned as transmitted. Temperatures below zero
 * use two's complement, so decoding a negative reading as unsigned turns -5 °C
 * into 65531. Devices that need it set `signed: true`.
 */
export type RegisterDefinition = {
  /** Zero-based Modbus address (datasheet 40001 → 0). */
  readonly register: number
  /** Short name used as the decoded key, e.g. `levelMm`. */
  readonly name: string
  /** Engineering unit after scaling. Recorded explicitly so the UI never guesses. */
  readonly unit: string
  /** Divide the raw value by this to get engineering units. */
  readonly scale?: number
  /** Added after scaling. */
  readonly offset?: number
  /** Interpret the 16-bit value as two's complement. */
  readonly signed?: boolean
  /** Human-readable note from the datasheet. */
  readonly description: string
}

/** A device profile: one bus address, one function code, a set of registers. */
export type RegisterMap = {
  readonly deviceClass: DeviceClass
  /** Which function code this map is read with. */
  readonly functionCode: typeof READ_HOLDING_REGISTERS | typeof READ_INPUT_REGISTERS
  readonly registers: readonly RegisterDefinition[]
  /** Human-readable source of this map, e.g. a model + datasheet revision. */
  readonly source: string
}

/** The device classes the Prisma schema models. */
export const DEVICE_CLASSES = [
  'FuelTank',
  'Generator',
  'FuelDispenser',
  'BatteryBank',
] as const
export type DeviceClass = (typeof DEVICE_CLASSES)[number]

// ── Fuel tank level sensor ───────────────────────────────────────────────────
// Typical tank-level probe: reads level in millimetres via 32-bit MMX. The
// map covers a 16-bit profile; a 32-bit reading is assembled from two
// consecutive registers and handled by the decoder, not here.
const TANK_REGISTERS: readonly RegisterDefinition[] = [
  {
    register: 0,
    name: 'levelMm',
    unit: 'mm',
    scale: 1,
    description: 'Raw level above the probe datum, in millimetres.',
  },
  {
    register: 1,
    name: 'levelHighMm',
    unit: 'mm',
    scale: 1,
    description: 'High word of a 32-bit level reading when the device is MMX.',
  },
  {
    register: 2,
    name: 'temperatureDeciC',
    unit: '°C',
    scale: 0.1,
    signed: true,
    description: 'Probe temperature in tenths of a degree C, two’s complement.',
  },
  {
    register: 3,
    name: 'signalQuality',
    unit: '%',
    scale: 1,
    description: 'Ultrasonic signal quality, 0–100. Low values mean a poor echo.',
  },
]

// ── Generator ────────────────────────────────────────────────────────────────
// The load register is in deci-kW (0.1 kW). Diesel gensets routinely report
// 1 kW resolution, and 10 kW would make a 50 kW set look identical whether it
// is idle or at full load.
const GENERATOR_REGISTERS: readonly RegisterDefinition[] = [
  {
    register: 0,
    name: 'statusCode',
    unit: 'enum',
    scale: 1,
    description:
      '0 stopped, 1 starting, 2 running, 3 cooling down, 4 fault. See GeneratorStatusCode.',
  },
  {
    register: 1,
    name: 'loadDeciKw',
    unit: 'kW',
    scale: 0.1,
    description: 'Active power output in tenths of a kW.',
  },
  {
    register: 2,
    name: 'frequencyCentiHz',
    unit: 'Hz',
    scale: 0.01,
    description: 'Output frequency in hundredths of a hertz. 50.00 → 5000.',
  },
  {
    register: 3,
    name: 'coolantDeciC',
    unit: '°C',
    scale: 0.1,
    signed: true,
    description: 'Coolant temperature in tenths of a degree C.',
  },
  {
    register: 4,
    name: 'oilPressureKpa',
    unit: 'kPa',
    scale: 1,
    description: 'Oil pressure. Sustained values near zero are a shutdown risk.',
  },
  {
    register: 5,
    name: 'runHours',
    unit: 'h',
    scale: 1,
    description: 'Cumulative run hours since last service.',
  },
  {
    register: 6,
    name: 'batteryVoltageDeciV',
    unit: 'V',
    scale: 0.1,
    description: 'Starter battery voltage in tenths of a volt.',
  },
]

// ── Fuel dispenser ───────────────────────────────────────────────────────────
const DISPENSER_REGISTERS: readonly RegisterDefinition[] = [
  {
    register: 0,
    name: 'statusCode',
    unit: 'enum',
    scale: 1,
    description: '0 idle, 1 dispensing, 2 authorised, 3 locked, 4 fault.',
  },
  {
    register: 1,
    name: 'nozzleActive',
    unit: 'index',
    scale: 1,
    description: 'Index of the nozzle currently dispensing, or 0 when idle.',
  },
  {
    register: 2,
    name: 'totalLitresDeci',
    unit: 'L',
    scale: 0.1,
    description: 'Lifetime volume dispensed, in tenths of a litre.',
  },
  {
    register: 3,
    name: 'flowLpmDeci',
    unit: 'L/min',
    scale: 0.1,
    description: 'Current flow rate in tenths of a litre per minute.',
  },
  {
    register: 4,
    name: 'priceMilli',
    unit: 'currency/L',
    scale: 0.001,
    description: 'Unit price in thousandths of a currency unit.',
  },
]

// ── Battery bank ─────────────────────────────────────────────────────────────
// Strings are reported in millivolts, banks in milliamps-hours scaled by 10.
const BATTERY_REGISTERS: readonly RegisterDefinition[] = [
  {
    register: 0,
    name: 'voltageMv',
    unit: 'V',
    scale: 0.001,
    description: 'Bank voltage in millivolts. A 48 V bank reports ~48000.',
  },
  {
    register: 1,
    name: 'socPermille',
    unit: '%',
    scale: 0.1,
    description: 'State of charge in tenths of a percent, 0–1000.',
  },
  {
    register: 2,
    name: 'currentDeciAmp',
    unit: 'A',
    scale: 0.1,
    signed: true,
    description: 'Charge (+) / discharge (−) current in tenths of an amp.',
  },
  {
    register: 3,
    name: 'temperatureDeciC',
    unit: '°C',
    scale: 0.1,
    signed: true,
    description: 'Bank temperature in tenths of a degree C.',
  },
  {
    register: 4,
    name: 'cellBalanceMv',
    unit: 'V',
    scale: 0.001,
    signed: true,
    description: 'Largest cell-to-cell voltage deviation; a battery-health alarm.',
  },
]

/**
 * The register maps, keyed by device class.
 *
 * DISPENSER uses 0x04 (input registers) and the rest use 0x03 (holding). That is
 * not arbitrary: input registers are read-only by definition, which is the
 * correct register bank for a measurement, while holding registers are the
 * writable set. Sending 0x03 against a meter that only exposes input registers
 * yields an ILLEGAL FUNCTION exception (0x01), and 0x04 against a controller
 * that keeps its state in holding registers yields the same. Getting the
 * function code wrong is the most common "device doesn't respond" cause.
 */
export const REGISTER_MAPS: Readonly<Record<DeviceClass, RegisterMap>> = {
  FuelTank: {
    deviceClass: 'FuelTank',
    functionCode: READ_INPUT_REGISTERS,
    registers: TANK_REGISTERS,
    source: 'Generic tank-level probe profile (input registers)',
  },
  Generator: {
    deviceClass: 'Generator',
    functionCode: READ_HOLDING_REGISTERS,
    registers: GENERATOR_REGISTERS,
    source: 'Generic genset controller profile (holding registers)',
  },
  FuelDispenser: {
    deviceClass: 'FuelDispenser',
    functionCode: READ_INPUT_REGISTERS,
    registers: DISPENSER_REGISTERS,
    source: 'Generic fuel-dispenser profile (input registers)',
  },
  BatteryBank: {
    deviceClass: 'BatteryBank',
    functionCode: READ_HOLDING_REGISTERS,
    registers: BATTERY_REGISTERS,
    source: 'Generic battery-management profile (holding registers)',
  },
}

/** Lowest and highest zero-based address a given map needs read. */
export function registerSpan(map: RegisterMap): { start: number; count: number } {
  const addresses = map.registers.map((r) => r.register)
  const start = Math.min(...addresses)
  // count is the span, not the number of named registers: a map may read a
  // 32-bit value across two words while naming three fields.
  return { start, count: Math.max(...addresses) - start + 1 }
}

/** Look up a named register definition. */
export function findRegister(
  map: RegisterMap,
  name: string,
): RegisterDefinition | undefined {
  return map.registers.find((r) => r.name === name)
}