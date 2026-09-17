import { NextResponse } from "next/server";
import { parseBaleSerial } from "@/domain/product";
import { currentUser, hasRole } from "@/lib/auth/session";
import { lookupBaleBySerial } from "@/server/services/product-sales";

/**
 * What the loading bay sees when a barcode is scanned.
 *
 * A GET, and deliberately: scanning is a read, it happens hundreds of times while a lorry
 * is loaded, and nothing about it should be able to change anything. The commit is one
 * POST at the end, with every scanned bale in it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const user = await currentUser();
  if (!user || !hasRole(user, ["merchandiser", "weigher", "cashier", "owner", "accountant"])) {
    return NextResponse.json({ error: "NOT_AUTHORISED" }, { status: 401 });
  }

  const serial = new URL(request.url).searchParams.get("serial") ?? "";
  if (!parseBaleSerial(serial)) {
    // Not one of ours. An ordinary event at a loading bay — the scanner fires at a
    // pallet label or the buyer's own sticker — so it is an answer, not an error.
    return NextResponse.json({ found: false, reason: "NOT_OURS" });
  }

  const bale = await lookupBaleBySerial(serial);
  if (!bale) return NextResponse.json({ found: false, reason: "UNKNOWN" });
  return NextResponse.json({ found: true, bale });
}
