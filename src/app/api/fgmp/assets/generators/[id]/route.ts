import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

const FUEL_TYPES = ["DIESEL", "PETROL", "BIOFUEL"] as const;
const GEN_STATUSES = ["RUNNING", "STOPPED", "FAULT", "MAINTENANCE", "OFFLINE"] as const;
const GEN_MODES = ["AUTO", "MANUAL", "REMOTE"] as const;

const updateGeneratorSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  manufacturer: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(120).optional(),
  ratedPowerKw: z.number().positive().optional(),
  fuelType: z.enum(FUEL_TYPES).optional(),
  status: z.enum(GEN_STATUSES).optional(),
  mode: z.enum(GEN_MODES).optional(),
  oilChangeIntervalHrs: z.number().min(0).optional(),
  lastOilChangeHrs: z.number().min(0).optional(),
  nextMaintenanceHrs: z.number().min(0).optional(),
});

const generatorInclude = {
  site: { select: { name: true, code: true } },
} as const;

/**
 * PUT /api/fgmp/assets/generators/[id]
 * Update editable generator fields (config + maintenance schedule). Live
 * telemetry (load, temp, fuelRate …) is owned by the engine and not editable
 * here — use the control API to start/stop the generator.
 *
 * ADMIN-only.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const parsed = updateGeneratorSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await asTenant(me, (tx) =>
      tx.generator.findFirst({
        where: { id },
      select: { id: true, site: { select: { tenantId: true } } },
      }),
    );
    const tenantDenied = assertSiteTenantOwned(existing?.site ?? null, me);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Generator not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const data: Record<string, unknown> = {};
    const fields: Array<keyof typeof parsed.data> = [
      "label", "manufacturer", "model", "ratedPowerKw", "fuelType",
      "status", "mode", "oilChangeIntervalHrs", "lastOilChangeHrs", "nextMaintenanceHrs",
    ];
    for (const f of fields) {
      if (parsed.data[f] !== undefined) data[f] = parsed.data[f];
    }

    // `update` takes a unique selector, so tenantId cannot be part of the
// where clause; the `existing` guard above already asserted ownership and
// the nested include of site is itself RLS-protected, so it belongs here.
    const updated = await asTenant(me, (tx) =>
      tx.generator.update({
        where: { id },
      data,
      include: generatorInclude,
      }),
    );

    await audit({
      userId: me.id,
      tenantId: tenantIdOrThrow(me.tenantId),
      action: "GENERATOR_UPDATE",
      entity: "Generator",
      entityId: id,
      details: data,
    });

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/assets/generators/[id]
 * Hard-delete a generator. Blocked (409) if it has any ControlCommand history
 * — those commands are an audit trail and must not be orphaned.
 *
 * ADMIN-only.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    const existing = await asTenant(me, (tx) =>
      tx.generator.findFirst({
        where: { id },
      select: { id: true, label: true, siteId: true, _count: { select: { commands: true } }, site: { select: { tenantId: true } } },
      }),
    );
    const tenantDenied = assertSiteTenantOwned(existing?.site ?? null, me);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Generator not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (existing._count.commands > 0) {
      const res = NextResponse.json(
        {
          error:
            "Cannot delete a generator that has control-command history. Decommission it instead.",
          code: "GENERATOR_HAS_COMMANDS",
          commandCount: existing._count.commands,
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await asTenant(me, (tx) =>
      // deleteMany, not delete: `delete` THROWS when the row is absent, so a
      // cross-tenant id would 500 and distinguish itself from a missing one.
      tx.generator.deleteMany({ where: { id } }),
    );

    await audit({
      userId: me.id,
      tenantId: tenantIdOrThrow(me.tenantId),
      action: "GENERATOR_DELETE",
      entity: "Generator",
      entityId: id,
      details: { label: existing.label, siteId: existing.siteId },
      });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
