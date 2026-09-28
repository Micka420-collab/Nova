// P13 notification policy (NOMI.md §3): a system notification only for a fact that BLOCKS or
// ENDS requested work, only when the window is unfocused, at most one per group (mission) per
// 30 s — later facts of the window are coalesced into one updated notification. Quiet mode holds
// everything except approvals. Every fact is also a notice (read back in the app): nothing lives
// only in a system notification. Never: inactivity reminders, pushed briefs, sounds.

import type { CompanionNotice, CompanionNoticeDelivery, CompanionNoticeInput, CompanionNoticeKind } from "@nova/shared";

// The notice shapes are part of the IPC contract (`companion.notices`): defined in @nova/shared.
export type NoticeKind = CompanionNoticeKind;
export type NoticeDelivery = CompanionNoticeDelivery;
export type NoticeInput = CompanionNoticeInput;
export type { CompanionNotice };

export interface SystemNotification {
  groupKey: string;
  /** Replaces the group's previous notification when still shown (one visible per group). */
  replacesGroup: boolean;
  body: string;
  /** Opened on click. */
  target: { entityType: NoticeInput["entityType"]; entityId: string };
  noticeIds: string[];
}

export interface NotificationContext {
  focused: boolean;
  now: number;
  /** Quiet mode end (epoch ms), null when off. */
  quietUntil: number | null;
}

export interface PushResult {
  notice: CompanionNotice;
  system: SystemNotification | null;
}

export const NOTIFICATION_COALESCE_MS = 30_000;
/** Notices kept in memory for the in-app journal. */
export const NOTICE_JOURNAL_MAX = 200;

interface GroupState {
  lastSystemAt: number;
  /** Notices of the current window, including the one already shown (for the coalesced text). */
  window: CompanionNotice[];
  pending: CompanionNotice[];
}

export function isQuiet(ctx: Pick<NotificationContext, "now" | "quietUntil">): boolean {
  return ctx.quietUntil !== null && ctx.quietUntil > ctx.now;
}

export class NotificationPolicy {
  private readonly groups = new Map<string, GroupState>();
  private readonly journal: CompanionNotice[] = [];
  private seq = 0;

  constructor(
    private readonly describeGroup: (notices: readonly CompanionNotice[]) => string,
    private readonly coalesceMs = NOTIFICATION_COALESCE_MS,
  ) {}

  push(input: NoticeInput, ctx: NotificationContext): PushResult {
    const quietHeld = isQuiet(ctx) && input.kind !== "approval";
    const delivered: NoticeDelivery = quietHeld ? "held" : ctx.focused ? "bubble" : "system";
    const notice: CompanionNotice = { ...input, id: `notice-${++this.seq}`, createdAt: ctx.now, delivered, readAt: null };
    this.journal.push(notice);
    if (this.journal.length > NOTICE_JOURNAL_MAX) this.journal.shift();
    if (delivered !== "system") return { notice, system: null };

    const group = this.groups.get(input.groupKey);
    if (!group || ctx.now - group.lastSystemAt >= this.coalesceMs) {
      this.groups.set(input.groupKey, { lastSystemAt: ctx.now, window: [notice], pending: [] });
      return { notice, system: this.notification(input.groupKey, [notice], false) };
    }
    group.window.push(notice);
    group.pending.push(notice);
    return { notice, system: null };
  }

  /** Earliest time a coalesced notification is due, or null. */
  nextFlushAt(): number | null {
    let next: number | null = null;
    for (const group of this.groups.values()) {
      if (group.pending.length === 0) continue;
      const due = group.lastSystemAt + this.coalesceMs;
      if (next === null || due < next) next = due;
    }
    return next;
  }

  /** Coalesced notifications due at `ctx.now`. Focus regained: pending facts stay as bubbles. */
  flushDue(ctx: NotificationContext): SystemNotification[] {
    const out: SystemNotification[] = [];
    for (const [key, group] of this.groups) {
      if (group.pending.length === 0 || ctx.now - group.lastSystemAt < this.coalesceMs) continue;
      const pending = group.pending;
      group.pending = [];
      if (ctx.focused) {
        for (const notice of pending) notice.delivered = "bubble";
        continue;
      }
      out.push(this.notification(key, group.window, true));
      group.lastSystemAt = ctx.now;
      group.window = [];
    }
    return out;
  }

  /** Journal, newest first. */
  notices(): CompanionNotice[] {
    return [...this.journal].reverse();
  }

  markRead(id: string, at: number): boolean {
    const notice = this.journal.find((item) => item.id === id);
    if (!notice || notice.readAt !== null) return false;
    notice.readAt = at;
    return true;
  }

  private notification(groupKey: string, notices: readonly CompanionNotice[], replacesGroup: boolean): SystemNotification {
    const last = notices.at(-1);
    if (!last) throw new Error("notification without notice");
    return {
      groupKey,
      replacesGroup,
      body: notices.length === 1 ? last.text : this.describeGroup(notices),
      target: { entityType: last.entityType, entityId: last.entityId },
      noticeIds: notices.map((notice) => notice.id),
    };
  }
}

/** Coalesced text: "2 approbations en attente." or "3 nouvelles notices de mission.". */
export function describeNoticeGroup(
  notices: readonly CompanionNotice[],
  copy: { approvals: (count: number) => string; grouped: (count: number) => string },
): string {
  return notices.every((notice) => notice.kind === "approval")
    ? copy.approvals(notices.length)
    : copy.grouped(notices.length);
}
