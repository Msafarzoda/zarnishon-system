"use server";

import { redirect } from "next/navigation";
import { homePathFor, signIn } from "@/lib/auth/session";
import { tg } from "@/lib/i18n/tg";

export async function signInAction(_prev: { error?: string }, formData: FormData) {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const stationId = String(formData.get("stationId") ?? "") || undefined;

  if (!username.trim() || !password) {
    return { error: tg.common.required };
  }

  const user = await signIn(username, password, stationId);
  if (!user) return { error: tg.auth.wrongCredentials };

  redirect(homePathFor(user.role));
}
