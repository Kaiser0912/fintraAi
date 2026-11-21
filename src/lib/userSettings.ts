import { getRequestDb, type Db } from "@/utils/supabase/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { DEFAULT_MODEL_CONFIG, type ModelProvider } from "@/lib/langgraph/types";
import { FREE_CHAT_QUOTA, isValidModel } from "@/lib/aiModels";

// Server-side access to per-user settings: the BYO model/key and the monthly
// managed-chat quota. Secrets never leave this module decrypted except inside
// the effective model used to run the graph.

export interface UserSettingsRow {
  user_id: string;
  currency: string | null;
  model_provider: string | null;
  model_name: string | null;
  byo_key_cipher: string | null;
  byo_key_last4: string | null;
  chat_quota_used: number | null;
  chat_quota_month: string | null;
}

/** Current month as 'YYYY-MM' (UTC). */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export async function getOrCreateSettings(
  userId: string
): Promise<UserSettingsRow> {
  const db = await getRequestDb();
  // Insert a bare row if none exists; ignore the conflict if it does.
  await db
    .from("user_settings")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  const { data } = await db
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .single();
  return data as UserSettingsRow;
}

// ─── Effective model ──────────────────────────────────────────────────────────

export interface EffectiveModel {
  provider: ModelProvider;
  modelName: string;
  /** Present only when the user brought their own key. */
  apiKey?: string;
  /** True when running on the managed (quota-limited) tier. */
  managed: boolean;
}

/** Resolves which model + key to run for a user. Falls back to managed if the
 *  BYO key can't be decrypted (e.g. encryption secret rotated). */
export function effectiveModel(row: UserSettingsRow): EffectiveModel {
  if (row.byo_key_cipher && row.model_provider && row.model_name) {
    try {
      return {
        provider: row.model_provider as ModelProvider,
        modelName: row.model_name,
        apiKey: decryptSecret(row.byo_key_cipher),
        managed: false,
      };
    } catch {
      // fall through to managed
    }
  }
  return {
    provider: DEFAULT_MODEL_CONFIG.provider,
    modelName: DEFAULT_MODEL_CONFIG.modelName,
    managed: true,
  };
}

// ─── Quota ────────────────────────────────────────────────────────────────────

export interface QuotaStatus {
  used: number;
  limit: number;
  remaining: number;
  month: string;
}

/** Quota for the current month; treats a stale month as a fresh (zeroed) one. */
export function quotaStatus(row: UserSettingsRow): QuotaStatus {
  const month = currentMonth();
  const used = row.chat_quota_month === month ? row.chat_quota_used ?? 0 : 0;
  return {
    used,
    limit: FREE_CHAT_QUOTA,
    remaining: Math.max(0, FREE_CHAT_QUOTA - used),
    month,
  };
}

/** Charges one managed message; the counter resets on a new month. Runs in the
 *  database (consume_chat_quota) because users cannot write the quota columns.
 *  Takes a token-bound client: it is called from inside the chat stream, after
 *  the request's cookie scope has ended. */
export async function consumeChatQuota(db: Db): Promise<void> {
  const { error } = await db.rpc("consume_chat_quota");
  if (error) console.error("[consumeChatQuota]", error.message);
}

// ─── BYO key mutations ────────────────────────────────────────────────────────

export async function setByoKey(
  userId: string,
  provider: ModelProvider,
  modelName: string,
  apiKey: string
): Promise<void> {
  const db = await getRequestDb();
  await db.from("user_settings").upsert(
    {
      user_id: userId,
      model_provider: provider,
      model_name: modelName,
      byo_key_cipher: encryptSecret(apiKey),
      byo_key_last4: apiKey.slice(-4),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
}

/** Switches the model while keeping the stored key. */
export async function setByoModel(
  userId: string,
  modelName: string
): Promise<void> {
  const db = await getRequestDb();
  await db
    .from("user_settings")
    .update({ model_name: modelName, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
}

export async function removeByoKey(userId: string): Promise<void> {
  const db = await getRequestDb();
  await db
    .from("user_settings")
    .update({
      model_provider: null,
      model_name: null,
      byo_key_cipher: null,
      byo_key_last4: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
}

// ─── Public projection (safe for the client) ──────────────────────────────────

export interface PublicSettings {
  currency: string;
  ai: {
    managed: boolean;
    provider: ModelProvider;
    modelName: string;
    keyLast4: string | null;
  };
  quota: QuotaStatus;
}

export function publicSettings(row: UserSettingsRow): PublicSettings {
  const eff = effectiveModel(row);
  return {
    currency: row.currency ?? "INR",
    ai: {
      managed: eff.managed,
      provider: eff.provider,
      modelName: eff.modelName,
      keyLast4: eff.managed ? null : row.byo_key_last4 ?? null,
    },
    quota: quotaStatus(row),
  };
}

export { isValidModel };
