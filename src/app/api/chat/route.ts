import { getAuthSession } from "@/utils/supabase/db";
import {
  getOrCreateSettings,
  effectiveModel,
  quotaStatus,
} from "@/lib/userSettings";
import { createSSEStream } from "./sse";
import { runChat, type ChatBody } from "./chatHandler";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { user, accessToken } = await getAuthSession();
  if (!user || !accessToken) return new Response("Unauthorized", { status: 401 });
  const userId = user.id;

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.threadId || typeof body.threadId !== "string") {
    return new Response("threadId is required", { status: 400 });
  }

  const isFreshTurn = Array.isArray(body.messages) && body.messages.length > 0;
  const isResume = !!body.resume;
  if (!isFreshTurn && !isResume) {
    return new Response("Either `messages` or `resume` is required", { status: 400 });
  }

  const settings = await getOrCreateSettings(userId);
  const model = effectiveModel(settings);

  // Managed tier is metered. BYO-key users are unlimited. Resumes ride on the
  // turn that already passed the gate, so we only check fresh turns.
  if (model.managed && isFreshTurn) {
    const quota = quotaStatus(settings);
    if (quota.remaining <= 0) {
      return Response.json(
        {
          error: "quota_exceeded",
          message: `You've used all ${quota.limit} free messages this month. Add your own API key in Settings for unlimited chat.`,
          quota,
        },
        { status: 429 }
      );
    }
  }

  return createSSEStream((send) => runChat(userId, accessToken, body, send, model));
}
