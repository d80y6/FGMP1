import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { getCurrentUser } from "@/lib/fgmp/rbac";

/**
 * GET /api/fgmp/proposal
 * Serves the Arabic technical proposal Word document for download.
 * Query param: ?format=pdf to get the PDF version instead.
 *
 * Requires an authenticated session (Task 31-A) — the proposal download
 * button in the header is hidden behind the login gate.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const user = await getCurrentUser();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const format = req.nextUrl.searchParams.get("format") || "docx";
    const isPdf = format === "pdf";

    const filePath = isPdf
      ? "/home/z/my-project/download/FGMP_Arabic_Technical_Proposal.pdf"
      : "/home/z/my-project/download/FGMP_Arabic_Technical_Proposal.docx";

    if (!existsSync(filePath)) {
      const res = NextResponse.json(
        { error: "Proposal file not found. Please generate it first." },
        { status: 404 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const buffer = await readFile(filePath);
    const filename = isPdf
      ? "FGMP_Arabic_Technical_Proposal.pdf"
      : "FGMP_Arabic_Technical_Proposal.docx";

    const res = new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": isPdf
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": buffer.length.toString(),
        "Cache-Control": "no-cache",
      },
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
