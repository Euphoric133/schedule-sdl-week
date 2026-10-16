/**
 * StudySession 领域模型测试。
 *
 * 核心规则（对应硬约束 H6/H9/H10）：
 * - plannedMinutes 必须与起止时间一致（不允许出现"写着 45 分钟实际 60 分钟"的时段）
 * - 跨午夜用 endMinutes > 1440 表示，且业务日归属按规则计算
 * - 进行中的时段必须锁定；已完成是终态，只能通过"撤销完成"这一显式操作离开
 * - 移动锁定时段/已完成时段必须被拒绝，而不是悄悄生效
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_DISPLAY_STATE,
  SESSION_MAX_MINUTES,
  SESSION_SOURCE,
  SESSION_STATE,
  businessDateOf,
  canTransitionSession,
  completeSession,
  createSession,
  displayStateOf,
  effectiveCompletedMinutes,
  isLockedForScheduling,
  isOvernight,
  lockSession,
  moveSession,
  reopenSession,
  sessionLength,
  sessionsForBusinessDate,
  sessionsOverlap,
  sortSessions,
  startSession,
  unlockSession,
  validateSession,
} from '../../src/domain/session.js';
import { VALIDATION_CODES } from '../../src/domain/validation.js';
import { FIXED_NOW_ISO } from '../helpers/clock.js';
import { makeSession, testContext } from '../helpers/fixtures.js';

test('createSession 计算 plannedMinutes，并规范锁定时段', () => {
  const ctx = testContext();
  const session = createSession({ taskId: 'tsk_1', date: '2025-10-16', startMinutes: 960, endMinutes: 1005 }, ctx);

  assert.match(session.id, /^ses_/);
  assert.equal(session.plannedMinutes, 45);
  assert.equal(session.state, SESSION_STATE.FLEXIBLE);
  assert.equal(session.locked, false);
  assert.equal(session.source, SESSION_SOURCE.USER_CREATE);
  assert.equal(session.actualMinutes, null);
});

test('createSession 支持 "HH:mm" 输入，并把 end ≤ start 视为跨夜', () => {
  const ctx = testContext();
  const sameDay = createSession({ taskId: 'tsk_1', date: '2025-10-16', startMinutes: '16:00', endMinutes: '17:30' }, ctx);
  assert.equal(sameDay.startMinutes, 960);
  assert.equal(sameDay.endMinutes, 1050);

  const overnight = createSession({ taskId: 'tsk_1', date: '2025-10-16', startMinutes: '23:30', endMinutes: '00:30' }, ctx);
  assert.equal(overnight.startMinutes, 1410);
  assert.equal(overnight.endMinutes, 1470, '跨夜应表达为 endMinutes > 1440');
  assert.equal(isOvernight(overnight), true);
  assert.equal(sessionLength(overnight), 60);
});

test('进行中的时段会被自动锁定（避免规划过程中被移走）', () => {
  const ctx = testContext();
  const session = createSession({ taskId: 'tsk_1', date: '2025-10-16', startMinutes: 960, endMinutes: 1005, state: 'in_progress' }, ctx);
  assert.equal(session.locked, true);
  assert.equal(isLockedForScheduling(session), true);
});

test('validateSession：空区间、超长时段、时长不符都会被拦截', () => {
  const ctx = testContext();
  const base = makeSession({ taskId: 'tsk_1' }, ctx);

  assert.equal(validateSession(base).ok, true);

  const empty = validateSession({ ...base, endMinutes: base.startMinutes });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((i) => i.code === VALIDATION_CODES.SESSION_EMPTY_SPAN));

  const tooLong = validateSession({ ...base, endMinutes: base.startMinutes + SESSION_MAX_MINUTES + 1, plannedMinutes: SESSION_MAX_MINUTES + 1 });
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.errors.some((i) => i.code === VALIDATION_CODES.SESSION_LENGTH_INVALID));

  const mismatched = validateSession({ ...base, plannedMinutes: 999 });
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.errors.some((i) => i.path.endsWith('.plannedMinutes')));
});

test('validateSession：可校验 taskId 是否存在（悬空引用）', () => {
  const ctx = testContext();
  const session = makeSession({ taskId: 'tsk_missing' }, ctx);
  const validation = validateSession(session, 'session', { taskExists: () => false });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((i) => i.code === VALIDATION_CODES.ENTITY_DANGLING_REF));
});

test('validateSession：进行中的时段必须锁定（创建时会自动锁定，非法数据会被拦截）', () => {
  const ctx = testContext();
  // createSession 会把 in_progress 自动规范化为 locked=true，这是"开始学习即锁定"的落地方式
  const normalized = makeSession({ state: 'in_progress' }, ctx);
  assert.equal(normalized.locked, true);
  assert.equal(validateSession(normalized).ok, true);

  // 但从导入/迁移等外部来源拿到"进行中却没锁定"的数据时，必须被校验器拒绝
  const malformed = { ...normalized, locked: false };
  const validation = validateSession(malformed);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((i) => i.path.endsWith('.locked')));
});

test('业务日归属：凌晨时段归前一天，可用于每日视图分组', () => {
  const ctx = testContext();
  const lateNight = makeSession({ date: '2025-10-17', startMinutes: 90, endMinutes: 150 }, ctx);
  assert.equal(businessDateOf(lateNight, 4), '2025-10-16');

  const daytime = makeSession({ date: '2025-10-17', startMinutes: 960, endMinutes: 1020 }, ctx);
  assert.equal(businessDateOf(daytime, 4), '2025-10-17');

  assert.equal(sessionsForBusinessDate([lateNight, daytime], '2025-10-16', 4).length, 1);
  assert.equal(sessionsForBusinessDate([lateNight, daytime], '2025-10-17', 4).length, 1);
});

test('界面上展示四种状态：flexible / pinned / in_progress / completed', () => {
  const ctx = testContext();
  const flex = makeSession({}, ctx);
  const pinned = { ...flex, locked: true };
  const running = { ...flex, state: 'in_progress', locked: true };
  const done = { ...flex, state: 'completed' };

  assert.equal(displayStateOf(flex), SESSION_DISPLAY_STATE.FLEXIBLE);
  assert.equal(displayStateOf(pinned), SESSION_DISPLAY_STATE.PINNED);
  assert.equal(displayStateOf(running), SESSION_DISPLAY_STATE.IN_PROGRESS);
  assert.equal(displayStateOf(done), SESSION_DISPLAY_STATE.COMPLETED);
});

test('完成状态是终态：自动流程不得把它改回未完成，只能通过 reopenSession 显式撤销', () => {
  const ctx = testContext();
  const session = makeSession({}, ctx);
  const { session: completed, issue } = completeSession(session, { nowIso: FIXED_NOW_ISO }, { actualMinutes: 40 });
  assert.equal(issue, null);
  assert.equal(completed.state, SESSION_STATE.COMPLETED);
  assert.equal(completed.actualMinutes, 40);
  assert.equal(completed.completedAt, FIXED_NOW_ISO);

  assert.equal(canTransitionSession(SESSION_STATE.COMPLETED, SESSION_STATE.FLEXIBLE), false, '终态没有自动出口');

  const reopened = reopenSession(completed, { nowIso: FIXED_NOW_ISO });
  assert.equal(reopened.issue, null);
  assert.equal(reopened.session.state, SESSION_STATE.IN_PROGRESS);
  assert.equal(reopened.session.actualMinutes, null);

  const notCompleted = reopenSession(session, { nowIso: FIXED_NOW_ISO });
  assert.ok(notCompleted.issue, '未完成的时段不能"撤销完成"');
});

test('开始学习：flexible → in_progress 并记录开始时间；重复开始是幂等的', () => {
  const ctx = testContext();
  const session = makeSession({}, ctx);
  const started = startSession(session, { nowIso: FIXED_NOW_ISO });
  assert.equal(started.issue, null);
  assert.equal(started.session.state, SESSION_STATE.IN_PROGRESS);
  assert.equal(started.session.startedAt, FIXED_NOW_ISO);
  assert.equal(started.session.locked, true);

  const again = startSession(started.session, { nowIso: FIXED_NOW_ISO });
  assert.equal(again.issue, null);
  assert.equal(again.session.state, SESSION_STATE.IN_PROGRESS);
});

test('锁定与解锁：只有未开始的时段才能解锁', () => {
  const ctx = testContext();
  const session = makeSession({}, ctx);

  const locked = lockSession(session, { nowIso: FIXED_NOW_ISO });
  assert.equal(locked.issue, null);
  assert.equal(locked.session.locked, true);

  const unlocked = unlockSession(locked.session, { nowIso: FIXED_NOW_ISO });
  assert.equal(unlocked.issue, null);
  assert.equal(unlocked.session.locked, false);

  const running = { ...session, state: 'in_progress', locked: true };
  const cannotUnlock = unlockSession(running, { nowIso: FIXED_NOW_ISO });
  assert.ok(cannotUnlock.issue, '进行中的时段不可解锁');
  assert.equal(cannotUnlock.session.locked, true);
});

test('移动时段：锁定时段被拒绝，已完成时段被拒绝，未锁定时段成功并留下历史记录', () => {
  const ctx = testContext();
  const session = makeSession({}, ctx);

  const moved = moveSession(session, { startMinutes: 1080, endMinutes: 1125 }, { nowIso: FIXED_NOW_ISO });
  assert.equal(moved.issue, null);
  assert.equal(moved.session.startMinutes, 1080);
  assert.equal(moved.session.plannedMinutes, 45);
  assert.equal(moved.session.source, SESSION_SOURCE.USER_MOVE);
  assert.equal(moved.session.history.length, 1);
  assert.deepEqual(moved.session.history[0].from, { date: '2025-10-16', startMinutes: 960, endMinutes: 1020 });

  const lockedMove = moveSession({ ...session, locked: true }, { startMinutes: 1080, endMinutes: 1125 });
  assert.ok(lockedMove.issue, '锁定时段必须先解锁才能移动');
  assert.equal(lockedMove.session.startMinutes, session.startMinutes);

  const completedMove = moveSession({ ...session, state: 'completed' }, { startMinutes: 1080, endMinutes: 1125 });
  assert.ok(completedMove.issue, '已完成时段不可移动');
});

test('移动时段：非法长度被拒绝', () => {
  const ctx = testContext();
  const session = makeSession({}, ctx);
  const zero = moveSession(session, { startMinutes: 1080, endMinutes: 1080 });
  assert.equal(zero.issue.code, VALIDATION_CODES.SESSION_LENGTH_INVALID);
  assert.equal(zero.session.startMinutes, session.startMinutes);
});

test('重叠判定：同日半开区间、跨夜相邻日、相隔多日', () => {
  const ctx = testContext();
  const a = makeSession({ id: 'ses_a', date: '2025-10-16', startMinutes: 960, endMinutes: 1020 }, ctx);
  const adjacent = makeSession({ id: 'ses_b', date: '2025-10-16', startMinutes: 1020, endMinutes: 1080 }, ctx);
  const overlapping = makeSession({ id: 'ses_c', date: '2025-10-16', startMinutes: 1000, endMinutes: 1060 }, ctx);
  const farAway = makeSession({ id: 'ses_d', date: '2025-10-20', startMinutes: 960, endMinutes: 1020 }, ctx);

  assert.equal(sessionsOverlap(a, adjacent), false, '首尾相接不算重叠');
  assert.equal(sessionsOverlap(a, overlapping), true);
  assert.equal(sessionsOverlap(a, farAway), false);
  assert.equal(sessionsOverlap(a, a), false, '自身不算重叠');

  // 跨夜时段与次日凌晨时段的比较
  const overnight = makeSession({ id: 'ses_e', date: '2025-10-16', startMinutes: 1410, endMinutes: 1470 }, ctx);
  const nextMorning = makeSession({ id: 'ses_f', date: '2025-10-17', startMinutes: 0, endMinutes: 60 }, ctx);
  assert.equal(sessionsOverlap(overnight, nextMorning), true, '23:30–00:30 与次日 00:00–01:00 重叠');
});

test('sortSessions 按日期 → 开始时间 → id 稳定排序', () => {
  const ctx = testContext();
  const list = [
    makeSession({ id: 'ses_b', date: '2025-10-17', startMinutes: 600, endMinutes: 660 }, ctx),
    makeSession({ id: 'ses_a', date: '2025-10-16', startMinutes: 960, endMinutes: 1020 }, ctx),
    makeSession({ id: 'ses_c', date: '2025-10-16', startMinutes: 960, endMinutes: 1020 }, ctx),
  ];
  assert.deepEqual(sortSessions(list).map((s) => s.id), ['ses_a', 'ses_c', 'ses_b']);
  assert.deepEqual(list.map((s) => s.id), ['ses_b', 'ses_a', 'ses_c'], '不修改入参数组');
});

test('effectiveCompletedMinutes：只有已完成时段计入，优先实际时长', () => {
  const ctx = testContext();
  assert.equal(effectiveCompletedMinutes(makeSession({ taskId: 'tsk_1' }, ctx)), 0);
  assert.equal(
    effectiveCompletedMinutes(makeSession({ taskId: 'tsk_1', date: '2025-10-16', startMinutes: 960, endMinutes: 1005, state: 'completed', actualMinutes: null }, ctx)),
    45,
    '没有实际时长时退回计划时长（16:00–16:45 = 45 分钟）',
  );
  assert.equal(effectiveCompletedMinutes(makeSession({ taskId: 'tsk_1', state: 'completed', startMinutes: 960, endMinutes: 1005, actualMinutes: 20 }, ctx)), 20);
});
