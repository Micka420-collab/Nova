import { describe, expect, it } from "vitest";
import { NOMI_COPY } from "./copy";
import { NotificationPolicy, describeNoticeGroup, type NoticeInput } from "./notifications";

const policy = () => new NotificationPolicy((notices) => describeNoticeGroup(notices, NOMI_COPY.notify));

const approvalNotice = (id: string): NoticeInput => ({
  kind: "approval",
  entityType: "approval",
  entityId: id,
  groupKey: "mission-1",
  text: NOMI_COPY.notify.approval("Facturation", "exécuter pnpm install"),
});
const done: NoticeInput = {
  kind: "mission_succeeded",
  entityType: "mission",
  entityId: "mission-1",
  groupKey: "mission-1",
  text: NOMI_COPY.notify.succeeded("Facturation"),
};

describe("notification policy (P13)", () => {
  it("focused window: a bubble, never a system notification; the notice is journaled", () => {
    const p = policy();
    const result = p.push(done, { focused: true, now: 0, quietUntil: null });
    expect(result.system).toBeNull();
    expect(result.notice.delivered).toBe("bubble");
    expect(p.notices()).toHaveLength(1);
  });

  it("two approvals within 10 s: one visible notification, updated to « 2 approbations en attente », two notices", () => {
    const p = policy();
    const first = p.push(approvalNotice("a1"), { focused: false, now: 0, quietUntil: null });
    const second = p.push(approvalNotice("a2"), { focused: false, now: 10_000, quietUntil: null });
    expect(first.system?.body).toBe("« Facturation » attend ta réponse : exécuter pnpm install.");
    expect(second.system).toBeNull();
    expect(p.nextFlushAt()).toBe(30_000);
    expect(p.flushDue({ focused: false, now: 29_999, quietUntil: null })).toEqual([]);
    const [coalesced, ...rest] = p.flushDue({ focused: false, now: 30_000, quietUntil: null });
    expect(rest).toEqual([]);
    expect(coalesced).toMatchObject({ body: "2 approbations en attente.", replacesGroup: true, groupKey: "mission-1" });
    expect(coalesced?.noticeIds).toHaveLength(2);
    expect(p.notices()).toHaveLength(2);
    expect(p.nextFlushAt()).toBeNull();
  });

  it("other groups are not coalesced together", () => {
    const p = policy();
    p.push(done, { focused: false, now: 0, quietUntil: null });
    const other = p.push({ ...done, entityId: "mission-2", groupKey: "mission-2" }, { focused: false, now: 1, quietUntil: null });
    expect(other.system).not.toBeNull();
  });

  it("quiet mode holds everything except approvals; held notices stay in the journal", () => {
    const p = policy();
    const quiet = { focused: false, now: 0, quietUntil: 3_600_000 };
    expect(p.push(done, quiet)).toMatchObject({ system: null, notice: { delivered: "held" } });
    expect(p.push(approvalNotice("a1"), quiet).system).not.toBeNull();
    expect(p.notices().map((notice) => notice.delivered)).toEqual(["system", "held"]);
  });

  it("focus regained before the flush: the coalesced facts become bubbles, no system notification", () => {
    const p = policy();
    p.push(approvalNotice("a1"), { focused: false, now: 0, quietUntil: null });
    p.push(approvalNotice("a2"), { focused: false, now: 5_000, quietUntil: null });
    expect(p.flushDue({ focused: true, now: 30_000, quietUntil: null })).toEqual([]);
    expect(p.notices()[0]?.delivered).toBe("bubble");
  });

  it("marks notices read once", () => {
    const p = policy();
    const { notice } = p.push(done, { focused: true, now: 0, quietUntil: null });
    expect(p.markRead(notice.id, 5)).toBe(true);
    expect(p.markRead(notice.id, 6)).toBe(false);
    expect(p.notices()[0]?.readAt).toBe(5);
  });
});
