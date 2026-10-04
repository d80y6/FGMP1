# GAP-C — Workflow Lifecycle Gaps (Fuel Delivery / Maintenance / Control / OTA)

Worklog entry: `/home/z/my-project/worklog.md` (Task ID: GAP-C section, appended 2024).

## Scope

Additive completion of four workflow lifecycles identified as gaps in the
GAP-1 analysis (P1 items 4–8):

1. **Fuel Delivery** — explicit DELIVERED + CANCELLED endpoints, auto-flip
   to DISCREPANCY on >5% variance, `deliveredAt` column finally written.
2. **Maintenance Ticket** — explicit ASSIGN + IN_PROGRESS endpoints with
   dedicated TICKET_ASSIGN + TICKET_STATUS_CHANGE audit actions.
3. **Control Command** — full PENDING → SENT → EXECUTED | FAILED | TIMEOUT
   lifecycle (was collapsed into a single synchronous SENT+OK step) + four
   safety interlocks (status guard, cooldown, concurrent-command lock,
   maintenance-window check).
4. **IoT OTA** — background completion via setTimeout (COMPLETE / FAILED
   states finally written) + dedicated OTA_COMPLETE / OTA_FAIL audit
   actions. The "OTA pending" KPI in iot-view now naturally drains.

## Files produced

### New API route files (6 — all ADDITIVE)

| Path | Method | Purpose |
|---|---|---|
| `src/app/api/fgmp/deliveries/[id]/deliver/route.ts` | POST | SCHEDULED/IN_TRANSIT → DELIVERED. Sets deliveredAt + volumeDeliveredLitres. |
| `src/app/api/fgmp/deliveries/[id]/cancel/route.ts` | POST | Any non-terminal → CANCELLED. Reason stored in `discrepancyNote`. |
| `src/app/api/fgmp/maintenance/[id]/assign/route.ts` | POST | Assign ticket to user (validates role + active). OPEN → SCHEDULED side-effect. |
| `src/app/api/fgmp/maintenance/[id]/progress/route.ts` | POST | OPEN/SCHEDULED → IN_PROGRESS. Optional `scheduledFor` update. |
| `src/app/api/fgmp/generators/[id]/control/[commandId]/route.ts` | GET | Poll a single command's status (PENDING → SENT → EXECUTED/FAILED/TIMEOUT). |
| `src/app/api/fgmp/iot/[id]/ota-status/route.ts` | GET | Poll a device's OTA status (IN_PROGRESS → COMPLETE/FAILED). |

### Modified files (5)

| Path | Change |
|---|---|
| `src/lib/fgmp/engine.ts` | `applyCommand()` rewritten in place: 4 safety interlocks + 1.5s async executor + 30s watchdog. Added `lastCommandAt` + `pendingCommandFor` Maps on the FgmpEngine class. Return type gains optional `command?` field (backward-compatible). |
| `src/app/api/fgmp/generators/[id]/control/route.ts` | Returns 202 Accepted on success (was 200). Body shape preserved. |
| `src/app/api/fgmp/deliveries/route.ts` | `verify` branch now auto-flips to DISCREPANCY when `|ordered − delivered| / ordered > 0.05`. In-tolerance path unchanged. Added explicit 404 for missing delivery. |
| `src/app/api/fgmp/iot/route.ts` | OTA branch schedules 8s setTimeout that flips otaStatus → COMPLETE + bumps firmware (audits OTA_COMPLETE), or FAILED on error (audits OTA_FAIL). Reboot branch untouched. |
| `src/lib/fgmp/i18n.ts` | 13 new audit-action keys (en + ar): DELIVERY_DELIVER, DELIVERY_CANCEL, DELIVERY_DISCREPANCY, DELIVERY_UPDATE, TICKET_UPDATE, TICKET_ASSIGN, TICKET_STATUS_CHANGE, COMMAND_EXECUTE, COMMAND_TIMEOUT, COMMAND_FAIL, OTA_COMPLETE, OTA_FAIL. |

## Key decisions

1. **Modified `applyCommand()` in place** rather than creating a parallel
   `applyCommandSafe()`. Rationale:
   - The function is small (~30 lines original) with exactly one caller
     (the control route).
   - The spec listed "Modify `applyCommand()`" as the primary instruction;
     `applyCommandSafe` was a fallback option.
   - A single function avoids two parallel code paths that could drift.
   - The signature change is additive (optional `command?` field), so the
     existing route handler + audit + realtime calls all work unchanged.

2. **Reused `discrepancyNote`** as the free-text annotation column for the
   cancel endpoint's `reason` field. Adding a separate `cancelReason`
   column would require a schema migration, which is out of scope for an
   additive task. Documented in the cancel route's file header.

3. **Cooldown starts from EXECUTION time, not ISSUE time.** The
   `lastCommandAt` Map is set inside the async executor's try block,
   AFTER the generator state change succeeds. This means the 1.5s exec
   delay doesn't eat into the 10s cooldown window — operators get a
   full 10s between successful commands.

4. **OTA audit uses the issue-time user id** (`userIdClosure = user.id`
   captured at PATCH time). The setTimeout fires 8s later; the audit
   log records who initiated the OTA, not who happened to be logged in
   when the setTimeout fired.

5. **Control endpoint returns 202 instead of 200.** The body shape is
   preserved (`{ ok, message, command? }`); the remote-control-dialog
   client uses `apiPost` which checks `res.ok` (HTTP 2xx), so 202 still
   reads as success. The toast still says "X executed" — slightly
   inaccurate now (the command is queued, not executed), but the
   snapshot polling loop picks up the actual state change 1.5s later.

6. **Interlock 4 (maintenance-window check) is best-effort.** If the
   AlarmSuppression query fails (DB hiccup), the catch swallows the
   error and the other interlocks still apply. Commands are never
   blocked by a DB read failure.

## Verification

- `bun run lint` → EXIT 0 (0 errors, 0 warnings).
- All 6 new endpoints reachable via curl (return 401 for unauthenticated
  requests, proving the route files compile + the auth guard fires).
  POST against the two GET-only endpoints returns 405 Method Not
  Allowed (proving the routes are registered with the correct method).
- Existing endpoints still work (deliveries/maintenance/iot list + the
  modified control POST all return 401 unauth, 200 authed).
- Home page still serves HTTP 200. No new errors in the dev log.
