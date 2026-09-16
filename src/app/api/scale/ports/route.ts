import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { listScalePorts } from "@/server/scale/reader";

export const dynamic = "force-dynamic";

/** Serial ports the server can see, for choosing the indicator's during setup. */
export async function GET() {
  try {
    await requireRole("weigher", "owner", "admin");
  } catch {
    return NextResponse.json({ error: "NOT_AUTHORISED" }, { status: 401 });
  }
  return NextResponse.json({ ports: await listScalePorts() });
}
