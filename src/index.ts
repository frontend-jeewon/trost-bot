import { WebClient as SlackClient } from "@slack/web-api";
import { parseFlexMessage } from "./parser.js";
import type { ParsedFlexMessage, ParsedRegistration } from "./parser.js";

type Env = {
  SLACK_BOT_TOKEN: string;
  SLACK_SOURCE_CHANNEL_ID: string;
  SLACK_TARGET_CHANNEL_ID: string;
  SLACK_USER_GROUP_ID: string;
  LOOKBACK_DAYS: number;
  HORIZON_DAYS: number;
  DRY_RUN: boolean;
};

function loadEnv(): Env {
  const required = [
    "SLACK_BOT_TOKEN",
    "SLACK_SOURCE_CHANNEL_ID",
    "SLACK_TARGET_CHANNEL_ID",
    "SLACK_USER_GROUP_ID",
  ] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }
  return {
    SLACK_BOT_TOKEN: process.env["SLACK_BOT_TOKEN"]!,
    SLACK_SOURCE_CHANNEL_ID: process.env["SLACK_SOURCE_CHANNEL_ID"]!,
    SLACK_TARGET_CHANNEL_ID: process.env["SLACK_TARGET_CHANNEL_ID"]!,
    SLACK_USER_GROUP_ID: process.env["SLACK_USER_GROUP_ID"]!,
    LOOKBACK_DAYS: Number(process.env["LOOKBACK_DAYS"] ?? "60"),
    HORIZON_DAYS: Number(process.env["HORIZON_DAYS"] ?? "14"),
    DRY_RUN: Boolean(process.env["DRY_RUN"]),
  };
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function nowKstDate(): Date {
  const d = new Date(Date.now() + KST_OFFSET_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function fmtKst(date: Date): string {
  const dow = ["일", "월", "화", "수", "목", "금", "토"][date.getUTCDay()];
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}(${dow})`;
}

async function getTargetMemberNames(slack: SlackClient, groupId: string): Promise<Set<string>> {
  const res = await slack.usergroups.users.list({ usergroup: groupId });
  const ids = res.users ?? [];
  if (ids.length === 0) {
    throw new Error(`User group ${groupId} has no members`);
  }
  const infos = await Promise.all(
    ids.map((id) => slack.users.info({ user: id }).then((r) => r.user))
  );
  const names = new Set<string>();
  for (const u of infos) {
    if (!u || u.deleted || u.is_bot) continue;
    const candidates = [
      u.profile?.real_name,
      u.profile?.display_name,
      u.real_name,
      u.name,
    ].filter((n): n is string => Boolean(n));
    for (const n of candidates) names.add(n);
  }
  return names;
}

async function fetchSourceMessages(
  slack: SlackClient,
  channel: string,
  oldestEpochSec: number
): Promise<{ text?: string; ts?: string }[]> {
  const messages: { text?: string; ts?: string }[] = [];
  let cursor: string | undefined;
  do {
    const res = await slack.conversations.history({
      channel,
      oldest: String(oldestEpochSec),
      limit: 200,
      cursor,
    });
    for (const m of res.messages ?? []) {
      messages.push({ text: m.text, ts: m.ts });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return messages;
}

function applyCancellations(parsed: (ParsedFlexMessage | null)[]): ParsedRegistration[] {
  const cancellations = new Set<string>();
  const registrations: ParsedRegistration[] = [];
  for (const p of parsed) {
    if (!p) continue;
    const key = `${p.name}|${p.rawDate}`;
    if (p.kind === "cancel") cancellations.add(key);
    else registrations.push(p);
  }
  registrations.sort((a, b) => b.ts - a.ts);
  const seen = new Set<string>();
  const result: ParsedRegistration[] = [];
  for (const r of registrations) {
    const key = `${r.name}|${r.rawDate}`;
    if (cancellations.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }
  return result;
}

function overlaps(entry: ParsedRegistration, rangeStart: Date, rangeEnd: Date): boolean {
  return entry.startDate <= rangeEnd && entry.endDate >= rangeStart;
}

type Thread = {
  parent: string;
  replies: string[];
};

function buildThread(
  entries: ParsedRegistration[],
  rangeStart: Date,
  rangeEnd: Date
): Thread {
  const header = `📅 *향후 2주 휴가 일정* (${fmtKst(rangeStart)} ~ ${fmtKst(rangeEnd)})`;
  if (entries.length === 0) {
    return { parent: `${header}\n등록된 일정이 없어요.`, replies: [] };
  }

  entries.sort(
    (a, b) =>
      a.startDate.getTime() - b.startDate.getTime() || a.name.localeCompare(b.name)
  );

  const parent = `${header}\n총 *${entries.length}건* 등록되어 있어요. 자세한 내용은 스레드 확인 👇`;

  const lines = entries.map((e) => {
    const dateLabel =
      e.startDate.getTime() === e.endDate.getTime()
        ? fmtKst(e.startDate)
        : `${fmtKst(e.startDate)} ~ ${fmtKst(e.endDate)}`;
    const time = e.timeRange ? ` ${e.timeRange}` : e.allDay ? " (하루종일)" : "";
    return `• ${e.name} — ${dateLabel}${time}`;
  });

  const replies: string[] = [];
  const CHUNK = 30;
  for (let i = 0; i < lines.length; i += CHUNK) {
    replies.push(lines.slice(i, i + CHUNK).join("\n"));
  }
  return { parent, replies };
}

async function postThread(
  slack: SlackClient,
  channel: string,
  thread: Thread,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    console.log("--- DRY RUN ---");
    console.log("[parent]\n" + thread.parent);
    for (const r of thread.replies) console.log("\n[reply]\n" + r);
    return;
  }
  const parentRes = await slack.chat.postMessage({
    channel,
    text: thread.parent,
    unfurl_links: false,
    unfurl_media: false,
  });
  const ts = parentRes.ts;
  if (!ts) throw new Error("Failed to retrieve thread_ts from parent message");
  for (const reply of thread.replies) {
    await slack.chat.postMessage({
      channel,
      text: reply,
      thread_ts: ts,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const slack = new SlackClient(env.SLACK_BOT_TOKEN);

  const today = nowKstDate();
  const horizon = new Date(today);
  horizon.setUTCDate(today.getUTCDate() + env.HORIZON_DAYS - 1);

  const lookbackSec = Math.floor(Date.now() / 1000) - env.LOOKBACK_DAYS * 24 * 60 * 60;

  console.log(
    `Range: ${fmtKst(today)} ~ ${fmtKst(horizon)} | lookback ${env.LOOKBACK_DAYS} days`
  );

  const names = await getTargetMemberNames(slack, env.SLACK_USER_GROUP_ID);
  console.log(`Target group has ${names.size} unique name aliases`);

  const messages = await fetchSourceMessages(
    slack,
    env.SLACK_SOURCE_CHANNEL_ID,
    lookbackSec
  );
  console.log(`Fetched ${messages.length} messages from source channel`);

  const parsed = messages.map(parseFlexMessage);
  const valid = applyCancellations(parsed);
  const filtered = valid.filter((e) => names.has(e.name) && overlaps(e, today, horizon));
  console.log(`Filtered to ${filtered.length} entries for target members`);

  const thread = buildThread(filtered, today, horizon);
  await postThread(slack, env.SLACK_TARGET_CHANNEL_ID, thread, env.DRY_RUN);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
