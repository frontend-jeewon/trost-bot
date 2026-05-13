import { WebClient as SlackClient } from "@slack/web-api";
import { parseFlexMessage } from "./parser.js";
import type { ParsedFlexMessage, ParsedRegistration } from "./parser.js";

type Env = {
  SLACK_BOT_TOKEN: string;
  SLACK_SOURCE_CHANNEL_ID: string;
  SLACK_TARGET_CHANNEL_ID: string;
  SLACK_USER_GROUP_ID: string;
  SLACK_EXTRA_USER_IDS: string[];
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
    SLACK_EXTRA_USER_IDS: (process.env["SLACK_EXTRA_USER_IDS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
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

async function getTargetMemberNames(
  slack: SlackClient,
  groupId: string,
  extraUserIds: string[] = []
): Promise<Set<string>> {
  const res = await slack.usergroups.users.list({ usergroup: groupId });
  const groupIds = res.users ?? [];
  const ids = Array.from(new Set([...groupIds, ...extraUserIds]));
  if (ids.length === 0) {
    throw new Error(`No users to collect: group ${groupId} is empty and no extra IDs provided`);
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

const NOTION_URL =
  "https://www.notion.so/351a054b7d828067b6b8cab80f28956a?source=copy_link";

const DIVIDER = "￣￣￣￣￣￣￣￣￣￣";

const WEEK_LABELS = ["이번주", "다음주", "다다음주", "다다다음주"];

function kstWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function formatEntryLine(e: ParsedRegistration): string {
  const dateLabel =
    e.startDate.getTime() === e.endDate.getTime()
      ? fmtKst(e.startDate)
      : `${fmtKst(e.startDate)} ~ ${fmtKst(e.endDate)}`;
  const time = e.timeRange ? ` ${e.timeRange}` : e.allDay ? " (하루종일)" : "";
  return `• ${e.name} — ${dateLabel}${time}`;
}

function buildMessage(
  entries: ParsedRegistration[],
  rangeStart: Date,
  rangeEnd: Date
): string {
  const header = `:date: 향후 2주 휴가 일정 (${fmtKst(rangeStart)} ~ ${fmtKst(rangeEnd)})`;
  const notionLink = `자세한 내용은 <${NOTION_URL}|:노션: 노션 확인>`;

  if (entries.length === 0) {
    return `${header}\n등록된 일정이 없어요.\n${notionLink}`;
  }

  entries.sort(
    (a, b) =>
      a.startDate.getTime() - b.startDate.getTime() || a.name.localeCompare(b.name)
  );

  const todayWeekStart = kstWeekStart(rangeStart);
  const buckets = new Map<number, ParsedRegistration[]>();
  for (const e of entries) {
    const effectiveStart =
      e.startDate.getTime() < rangeStart.getTime() ? rangeStart : e.startDate;
    const weekStart = kstWeekStart(effectiveStart);
    const idx = Math.round(
      (weekStart.getTime() - todayWeekStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
    );
    if (!buckets.has(idx)) buckets.set(idx, []);
    buckets.get(idx)!.push(e);
  }

  const sections = Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([idx, bucketEntries]) => {
      const label = WEEK_LABELS[idx] ?? `${idx + 1}주 후`;
      return `-----${label}-----\n\n${bucketEntries.map(formatEntryLine).join("\n")}`;
    })
    .join("\n\n\n");

  return [
    header,
    `총 ${entries.length}건 등록되어 있어요.`,
    notionLink,
    "",
    DIVIDER,
    sections,
    DIVIDER,
  ].join("\n");
}

async function postMessage(
  slack: SlackClient,
  channel: string,
  text: string,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    console.log("--- DRY RUN ---\n" + text);
    return;
  }
  await slack.chat.postMessage({
    channel,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
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

  const names = await getTargetMemberNames(
    slack,
    env.SLACK_USER_GROUP_ID,
    env.SLACK_EXTRA_USER_IDS
  );
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

  const message = buildMessage(filtered, today, horizon);
  await postMessage(slack, env.SLACK_TARGET_CHANNEL_ID, message, env.DRY_RUN);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
