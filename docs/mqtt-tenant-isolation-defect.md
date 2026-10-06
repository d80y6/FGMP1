# MQTT tenant isolation — two defects that looked healthy

**Status:** closed, verified against a live broker.
**Found by:** `bun test src/lib/fgmp/protocol/mqtt-live.test.ts` failing against a broker
that reported `Up (healthy)` and was serving every connection correctly.

---

## Why this file exists

Every finding below was invisible from inside the application. The broker
authenticated users, accepted connections, published retained messages, and
reported no error. PostgreSQL RLS — which protects the other 30 tables — cannot
help here, because MQTT has no database. The tenant boundary has to be the broker
refusing an operation, so a silent failure in the broker's authorization is a
silent failure of tenant isolation everywhere on the telemetry path.

Nothing in the code diff would have revealed any of this. It was found only
because an assertion failed and the failure was investigated instead of retried.

---

## Defect 1 — the ACL file was not being enforced at all

`docker/mosquitto/config/acl` was bind-mounted into the container:

```yaml
- ./docker/mosquitto/config/acl:/mosquitto/config/acl:ro
```

A bind mount carries the **host** file's uid and gid into the container, so the
file is owned by the host user (uid 1000) rather than by `mosquitto` (uid 1883).

Mosquitto 2 does not reject this. It logs six warnings at startup:

```
Warning: File /mosquitto/config/acl has world readable permissions.
Warning: File /mosquitto/config/acl owner is not mosquitto.
Warning: File /mosquitto/config/acl group is not mosquitto.
```

…and then **keeps running with the ACL not enforced**.

The dangerous part is that this is a *half*-working security state.
`allow_anonymous false` was still honoured, because it is a config directive
rather than a file read by the same mechanism. So:

| Property | Expected | Actual |
|---|---|---|
| Anonymous refused | yes | **yes** |
| Wrong password refused | yes | **yes** |
| Own subtree readable | yes | yes |
| Cross-tenant subtree readable | **no** | **yes** |

Every visible signal said healthy. Every client authenticated correctly. The
healthcheck passed, because it tested authentication — which worked.

**Fix:** copy the files into a named volume at start-up and `chown` them to
`mosquitto`, rather than bind-mounting them read-only.

---

## Defect 2 — `topic readwrite fgmp/tenant-a/` is a malformed filter

The ACL granted, for each tenant:

```
topic readwrite fgmp/tenant-a/
```

That trailing `/` is not shorthand for the subtree. An MQTT topic filter matches
level by level, and a trailing `/` matches only the literal empty level that
follows it — so the grant covered `fgmp/tenant-a/` itself and nothing beneath it.

The effect was the **opposite** of what the file claimed:

```
user tenant-a
topic readwrite fgmp/tenant-a/#   →  read own subtree, publish own subtree
topic readwrite fgmp/tenant-a/    →  read own subtree, CANNOT publish
```

Every device upload failed:

```
ErrorWithReasonCode: Publish error: Not authorized
 code: 135,
```

This was invisible to the isolation suite, because the isolation suite only
asserted that one tenant cannot see another — a permission that was never
granted, so it never failed. Nothing in the tests published as a tenant into its
own subtree.

The same error hid the *absence* of a real signal: until a tenant tried to publish,
there was no test that could distinguish "ACL correctly denies cross-tenant" from
"ACL grants nothing to anyone".

**Fix:** `topic readwrite fgmp/tenant-a/#`.

---

## Defect 3 — the isolation tests asserted on a signal mosquitto does not send

The original assertions were:

```ts
const verdict = await subscribeAndReport(a, "fgmp/tenant-b/#", QOS.AT_LEAST_ONCE)
expect(verdict.granted).toBe(false)
```

On MQTT 3.1.1 a denied subscription is reported by the broker as a SUBACK reason
code of `0x80`. Mosquitto 2.1.2 does not do this. It returns success codes for
every filter and enforces the ACL when it **routes** each message:

```
$ mosquitto_sub -V 5 -u tenant-a -P ... -t 'fgmp/tenant-a/#' -t 'fgmp/tenant-b/#' -d -W 3
Subscribed (mid: 1): 0, 0        # own = granted, foreign = "granted"
```

So `verdict.granted` is `true` for a cross-tenant filter that is in fact correctly
refused. Those tests failed against a working ACL — and would have **passed**
against a completely broken one, which is the worst direction for a security test
to fail in.

**Fix:** assert on delivery. `canReceive()` publishes from a real second tenant and
reports whether the message arrived:

```ts
const received = await canReceive(a, b, "fgmp/tenant-b/tank/dev-secret/telemetry", payload)
expect(received).toBe(false)
```

Arrival is the thing that must not happen, and arrival is observable. Paired with a
same-tenant control test, so that "nothing arrived" cannot pass by a broker that
delivers nothing at all:

```ts
test("tenant A does receive its OWN subtree — the control for the tests above")
```

That control is what gives the denial tests meaning. Without it, a broker that
delivers zero messages to everyone satisfies every assertion in the file.

---

## Defect 4 — a healthcheck that can never pass

```yaml
test: ["CMD-SHELL", "mosquitto_sub ... -t 'fgmp/tenant-a/#' -C 1 -W 5 >/dev/null 2>&1 || exit 1"]
```

`-C 1` means "exit after 1 message". The probe waits for a message on a broker
nobody publishes to, so it timed out on every run:

```
"FailingStreak": 383
```

while the broker was in fact serving correctly. A healthcheck that cannot succeed is
worse than none — it trains everyone to read `unhealthy` as noise, and it would have
masked the genuine failure in defect 1.

**Fix:** assert the property that matters, in both directions — authenticate,
deliver own subtree, refuse cross-tenant.

---

## Verification

```bash
docker compose up -d --force-recreate fgmp-broker
bun test src/lib/fgmp/protocol/mqtt-live.test.ts
# 14 pass, 0 fail
```

Startup must be clean — any warning about ownership means the ACL is not enforced:

```bash
docker logs fgmp-broker 2>&1 | grep -icE 'warning|error'   # must be 0
```

---

## What generalises

1. **A security control that is present, greppable, and reviewed can still enforce
   nothing.** Only an assertion against live behaviour distinguishes them.
2. **Test the failure direction, not the mechanism.** "Tenant A cannot read tenant
   B" is the requirement. Whether the broker signals that via SUBACK, via routing,
   or by dropping the connection is an implementation detail that differed from the
   test's assumption and produced the wrong verdict in both directions.
3. **Every denial test needs a matching permission test.** Without the control, a
   deny-all broker passes the suite.
4. **A healthcheck that always fails is a disabled healthcheck.** It had been
   reporting unhealthy for 383 consecutive intervals, and nobody read it because it
   was always red.