/**
 * 测试辅助：固定时钟与 ID 工厂。
 *
 * 目的：所有测试都必须可重复。任何依赖 Date.now / new Date() / 随机数的行为都要在这里被替换掉，
 * 否则测试会随运行时间与机器不同而出现偶发失败。
 */

import { createIdFactory, createSeededRandom } from '../../src/domain/ids.js';
import { wallTimeFromDateObject } from '../../src/domain/time.js';

/** 固定的"现在"：2025-10-16（周四）20:30 */
export const FIXED_NOW = Object.freeze({
  date: '2025-10-16',
  minutes: 20 * 60 + 30,
  weekday: 4,
  iso: '2025-10-16T20:30:00+08:00',
});

/**
 * 返回一个固定时钟函数，其返回的 Date 用**本地时间**表示目标墙钟时间。
 * 这样 wallTimeFromDateObject() 在任意时区的机器上都能得到相同的日期与分钟数。
 */
export function fixedClock(wall = FIXED_NOW) {
  const [year, month, day] = wall.date.split('-').map(Number);
  const local = new Date(year, month - 1, day, Math.floor(wall.minutes / 60), wall.minutes % 60, 0, 0);
  return () => local;
}

/** 固定时钟的 ISO 字符串形式（用于实体 createdAt/updatedAt 断言） */
export const FIXED_NOW_ISO = FIXED_NOW.iso;

/** 可预测的 ID 工厂（固定时间戳 + 固定种子随机数） */
let idFactorySeq = 0;

/**
 * 每次调用返回一个**独立**的 ID 工厂，并保证不同工厂产生的 ID 互不相同
 * （种子递进），否则同一测试文件里的多个应用实例会产生 ID 碰撞，
 * 导致"时段挂到错误任务上"这类假故障。
 */
export function testIdFactory() {
  idFactorySeq += 1;
  return createIdFactory({
    clock: () => 1760627400000 + idFactorySeq,
    random: createSeededRandom(42 + idFactorySeq),
    seed: 42 + idFactorySeq,
  });
}

/** 便捷：构造 { date, minutes } 墙钟时间 */
export function wall(date, minutes) {
  return { date, minutes };
}

export { wallTimeFromDateObject };
