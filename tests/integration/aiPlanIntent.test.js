/**
 * 气泡的「意图识别」：决定要不要显示"去 AI 助手页改计划"的按钮。
 *
 * 这条断点的背景：气泡走普通聊天通道，不能产生可执行提议。
 * 如果用户在气泡里说"帮我加个任务"，模型只能拒绝，用户会以为功能没做。
 * 识别到意图就显示跳转按钮，把人带到真正能改的页面。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { looksLikePlanChange } from '../../src/ai/planIntent.js';

const projectRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const read = (rel) => readFile(join(projectRoot, rel), 'utf8');

test('识别：新建类请求', () => {
  for (const text of [
    '给我添加一个数学作业的任务',
    '帮我加个任务：生物实验报告',
    '新建一个作业',
    '安排一个英语背诵',
  ]) {
    assert.equal(looksLikePlanChange(text), true, text);
  }
});

test('识别：修改类请求', () => {
  for (const text of [
    '把数学作业改到周六截止',
    '把化学实验的截止日期改到上个月',
    '把用时调整成 90 分钟',
    '改一下重要度',
  ]) {
    assert.equal(looksLikePlanChange(text), true, text);
  }
});

test('识别：删除 / 完成 / 取消', () => {
  for (const text of ['帮我删掉数学作业', '彻底删除数学作业', '英语作文我已经写完了', '这个任务取消吧']) {
    assert.equal(looksLikePlanChange(text), true, text);
  }
});

test('识别：普通咨询与闲聊不应误判', () => {
  for (const text of [
    '我今天有什么安排',
    '数学作业还剩多久',
    '我最近哪个科目总是超时',
    '谢谢',
    '',
  ]) {
    assert.equal(looksLikePlanChange(text), false, JSON.stringify(text));
  }
});

test('组件：识别到意图时给回复挂跳转按钮，而不是让模型拒绝', async () => {
  const widget = await read('src/ai/assistantWidget.js');
  assert.match(widget, /looksLikePlanChange/, '应使用意图识别');
  assert.match(widget, /cta: looksLikePlanChange\(clean\)/, '命中时给消息打标记');
  assert.match(widget, /ai-assistant__cta/, '应渲染跳转按钮');
  assert.match(widget, /location\.hash = '#\/ai'/, '按钮应跳到 AI 助手页');
});

test('提示词：普通聊天不能回答"我无法添加任务"，而要引导到「帮我改计划」', async () => {
  for (const file of ['cloudflare/ai-chat-worker.js', 'netlify/functions/ai-chat.mjs']) {
    const source = await read(file);
    assert.match(source, /帮我改计划/, `${file} 应提到「帮我改计划」`);
    assert.match(source, /不要回答"我无法添加任务"/, `${file} 应明确禁止那句话`);
  }
});
