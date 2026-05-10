export type ParsedRegistration = {
  kind: "register";
  name: string;
  rawDate: string;
  ts: number;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  timeRange: string | null;
};

export type ParsedCancellation = {
  kind: "cancel";
  name: string;
  rawDate: string;
  ts: number;
};

export type ParsedFlexMessage = ParsedRegistration | ParsedCancellation;

export type SlackMessageLike = {
  text?: string | undefined;
  ts?: string | number | undefined;
};

const REGISTER_RE =
  /:palm_tree:\s*\[([^\]]+)\]\s*-\s*(.+?)\s*휴가입니다\./;
const CANCEL_RE =
  /:exclamation:\s*\[([^\]]+)\]\s*-\s*(.+?)\s*휴가가\s*취소되었습니다\./;
const MD_RE = /(\d{1,2})월\s*(\d{1,2})일/g;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function tsToKstDate(ts: string | number): Date {
  return new Date(Math.floor(Number(ts) * 1000) + KST_OFFSET_MS);
}

function makeKstDate(year: number, month: number, day: number): Date {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function pickYear(month: number, day: number, anchorKst: Date): Date {
  const candidate = makeKstDate(anchorKst.getUTCFullYear(), month, day);
  const grace = new Date(anchorKst);
  grace.setUTCDate(grace.getUTCDate() - 7);
  if (candidate >= grace) return candidate;
  return makeKstDate(anchorKst.getUTCFullYear() + 1, month, day);
}

type DateRange = {
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  timeRange: string | null;
};

function extractDateRange(rawDate: string, messageTs: string | number): DateRange | null {
  const anchor = tsToKstDate(messageTs);
  anchor.setUTCHours(0, 0, 0, 0);

  const matches = [...rawDate.matchAll(MD_RE)];
  if (matches.length === 0) return null;

  const [startMd] = matches;
  if (!startMd) return null;
  const startDate = pickYear(Number(startMd[1]), Number(startMd[2]), anchor);

  let endDate: Date;
  if (matches.length >= 2) {
    const endMd = matches[1]!;
    const endMonth = Number(endMd[1]);
    const endDay = Number(endMd[2]);
    let year = startDate.getUTCFullYear();
    if (
      endMonth < startDate.getUTCMonth() + 1 ||
      (endMonth === startDate.getUTCMonth() + 1 && endDay < startDate.getUTCDate())
    ) {
      year += 1;
    }
    endDate = makeKstDate(year, endMonth, endDay);
  } else {
    endDate = startDate;
  }

  const allDay = /하루종일/.test(rawDate);
  const timeMatch = rawDate.match(
    /(오전|오후)\s*\d{1,2}:\d{2}\s*~\s*(오전|오후)\s*\d{1,2}:\d{2}/
  );
  const timeRange = timeMatch ? timeMatch[0] : null;

  return { startDate, endDate, allDay, timeRange };
}

export function parseFlexMessage(message: SlackMessageLike): ParsedFlexMessage | null {
  const text = message.text;
  if (typeof text !== "string") return null;

  const cancelMatch = text.match(CANCEL_RE);
  if (cancelMatch) {
    return {
      kind: "cancel",
      name: cancelMatch[1]!.trim(),
      rawDate: cancelMatch[2]!.trim(),
      ts: Number(message.ts ?? 0),
    };
  }

  const registerMatch = text.match(REGISTER_RE);
  if (!registerMatch) return null;

  const name = registerMatch[1]!.trim();
  const rawDate = registerMatch[2]!.trim();
  const range = extractDateRange(rawDate, message.ts ?? 0);
  if (!range) return null;

  return {
    kind: "register",
    name,
    rawDate,
    ts: Number(message.ts ?? 0),
    startDate: range.startDate,
    endDate: range.endDate,
    allDay: range.allDay,
    timeRange: range.timeRange,
  };
}
