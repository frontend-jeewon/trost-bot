import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlexMessage } from "../src/parser.js";
import type { ParsedRegistration, ParsedCancellation } from "../src/parser.js";

const TS_2026_05_06 = "1778124000";

function msg(text: string, ts: string = TS_2026_05_06) {
  return { text, ts };
}

test("multi-day vacation registration", () => {
  const r = parseFlexMessage(
    msg(":palm_tree: [김준우A] - 6월 11일 ~ 7월 6일 휴가입니다.")
  ) as ParsedRegistration;
  assert.equal(r.kind, "register");
  assert.equal(r.name, "김준우A");
  assert.equal(r.startDate.getUTCMonth() + 1, 6);
  assert.equal(r.startDate.getUTCDate(), 11);
  assert.equal(r.endDate.getUTCMonth() + 1, 7);
  assert.equal(r.endDate.getUTCDate(), 6);
});

test("half-day with time range", () => {
  const r = parseFlexMessage(
    msg(":palm_tree: [최희건] - 5월 12일 오후 1:30 ~ 오후 5:30 휴가입니다.")
  ) as ParsedRegistration;
  assert.equal(r.kind, "register");
  assert.equal(r.timeRange, "오후 1:30 ~ 오후 5:30");
  assert.equal(r.allDay, false);
  assert.equal(r.startDate.getTime(), r.endDate.getTime());
});

test("all-day single-date vacation", () => {
  const r = parseFlexMessage(
    msg(":palm_tree: [경주원] - 5월 8일 하루종일 휴가입니다.")
  ) as ParsedRegistration;
  assert.equal(r.allDay, true);
  assert.equal(r.startDate.getUTCMonth() + 1, 5);
  assert.equal(r.startDate.getUTCDate(), 8);
});

test("cancellation message", () => {
  const r = parseFlexMessage(
    msg(":exclamation: [최동권] - 5월 8일 하루종일 휴가가 취소되었습니다.")
  ) as ParsedCancellation;
  assert.equal(r.kind, "cancel");
  assert.equal(r.name, "최동권");
  assert.equal(r.rawDate, "5월 8일 하루종일");
});

test("register and cancel produce matching keys", () => {
  const reg = parseFlexMessage(
    msg(":palm_tree: [최동권] - 5월 8일 하루종일 휴가입니다.")
  )!;
  const can = parseFlexMessage(
    msg(":exclamation: [최동권] - 5월 8일 하루종일 휴가가 취소되었습니다.")
  )!;
  assert.equal(`${reg.name}|${reg.rawDate}`, `${can.name}|${can.rawDate}`);
});

test("ignores unrelated messages", () => {
  assert.equal(parseFlexMessage(msg("hello world")), null);
  assert.equal(parseFlexMessage(msg("")), null);
  assert.equal(parseFlexMessage({}), null);
});

test("year rolls forward when month/day already passed", () => {
  const r = parseFlexMessage(
    msg(":palm_tree: [홍길동] - 1월 5일 하루종일 휴가입니다.", TS_2026_05_06)
  ) as ParsedRegistration;
  assert.equal(r.startDate.getUTCFullYear(), 2027);
});

test("year stays same when within 7-day grace before message ts", () => {
  const r = parseFlexMessage(
    msg(":palm_tree: [홍길동] - 5월 1일 하루종일 휴가입니다.", TS_2026_05_06)
  ) as ParsedRegistration;
  assert.equal(r.startDate.getUTCFullYear(), 2026);
  assert.equal(r.startDate.getUTCMonth() + 1, 5);
});

test("end-of-year range crossing into next year", () => {
  const r = parseFlexMessage(
    msg(":palm_tree: [홍길동] - 12월 28일 ~ 1월 3일 휴가입니다.", "1798912800")
  ) as ParsedRegistration;
  assert.equal(r.startDate.getUTCMonth() + 1, 12);
  assert.equal(r.endDate.getUTCMonth() + 1, 1);
  assert.equal(r.endDate.getUTCFullYear(), r.startDate.getUTCFullYear() + 1);
});
