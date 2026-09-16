import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { ensureScaleReader, getScaleSnapshot } from "@/server/scale/reader";

export const dynamic = "force-dynamic";

/**
 * The weight the server is reading right now.
 *
 * Every signed-in station may look: the lab and the cash desk have a legitimate interest
 * in whether a truck is on the platform, and the reading is not a secret. Acting on it is
 * a different matter and is gated where the acting happens.
 */
export async function GET() {
  /*
   * Before the auth check, deliberately. Opening the port is not a disclosure — it starts
   * the reader and returns nothing — and this is what lets the server warm the scale up at
   * boot rather than waiting for the first operator to open a page. A weighbridge whose
   * port opens only when somebody looks at it misses every frame until then, including the
   * ones the protocol detection needs.
   */
  ensureScaleReader();

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "NOT_AUTHORISED" }, { status: 401 });
  return NextResponse.json(getScaleSnapshot());
}
