/**
 * 音频引擎：背景音切换、音量、提示音、降级（用替身 AudioContext，不需要真实音频）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AMBIENT_TRACKS, CHIME_KINDS, createAudioEngine } from '../../src/services/audioEngine.js';

/** 极简 AudioContext 替身：记录节点创建与连接 */
function makeFakeContext({ fail = false } = {}) {
  const state = { created: 0, gains: 0, filters: 0, sources: 0, oscillators: 0, started: 0, stopped: 0, connected: 0 };
  const ctx = {
    state: 'running',
    sampleRate: 8000,
    currentTime: 0,
    destination: {},
    createGain() {
      state.gains += 1;
      return {
        gain: {
          value: 1,
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
          cancelScheduledValues() {},
          setTargetAtTime() {},
        },
        connect() {
          state.connected += 1;
        },
        disconnect() {},
      };
    },
    createBufferSource() {
      if (fail) throw new Error('no audio');
      state.sources += 1;
      return {
        buffer: null,
        loop: false,
        connect() {
          state.connected += 1;
        },
        disconnect() {},
        start() {
          state.started += 1;
        },
        stop() {
          state.stopped += 1;
        },
      };
    },
    createBuffer(_channels, length) {
      return { getChannelData: () => new Float32Array(length) };
    },
    createBiquadFilter() {
      state.filters += 1;
      return { type: 'lowpass', frequency: { value: 0 }, Q: { value: 0 }, connect() {}, disconnect() {} };
    },
    createOscillator() {
      state.oscillators += 1;
      return {
        type: 'sine',
        frequency: { value: 0 },
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      };
    },
    resume() {},
    close() {},
  };
  return { ctx, state };
}

test('T-17 没有 AudioContext 时安静降级，不抛错', () => {
  const engine = createAudioEngine({ audioContextFactory: () => null });
  const result = engine.startAmbient(AMBIENT_TRACKS.RAIN);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'audio-unavailable');
  assert.equal(engine.hasContext, false);
});

test('T-18 启动雨声：只创建一个 AudioContext，建立 gain/filter，当前音轨正确', () => {
  const { ctx, state } = makeFakeContext();
  let created = 0;
  const engine = createAudioEngine({
    audioContextFactory: () => {
      created += 1;
      return ctx;
    },
  });

  const result = engine.startAmbient(AMBIENT_TRACKS.RAIN);
  assert.equal(result.ok, true);
  assert.equal(result.track, 'rain');
  assert.equal(created, 1, '只创建一次 AudioContext');
  assert.ok(state.filters >= 1, '应有滤波器');
  assert.ok(state.sources >= 1, '应有噪声源');
  assert.equal(engine.currentTrack, 'rain');
});

test('T-19 切换音轨：旧节点被停止，同一时刻只有一个音轨', () => {
  const { ctx, state } = makeFakeContext();
  const engine = createAudioEngine({ audioContextFactory: () => ctx });

  engine.startAmbient(AMBIENT_TRACKS.RAIN);
  const sourcesAfterFirst = state.sources;
  engine.startAmbient(AMBIENT_TRACKS.STREAM);

  assert.equal(engine.currentTrack, 'stream');
  assert.ok(state.sources > sourcesAfterFirst, '应启动新音轨');
  assert.ok(state.stopped >= 1, '旧音轨必须被停止（否则会叠加）');
});

test('T-20 设置音量：只更新 gain，不重建音频图', () => {
  const { ctx, state } = makeFakeContext();
  const engine = createAudioEngine({ audioContextFactory: () => ctx });

  engine.startAmbient(AMBIENT_TRACKS.WIND);
  const sourcesBefore = state.sources;
  engine.setAmbientVolume(0.5);

  assert.equal(state.sources, sourcesBefore, '不应新建音频源');
  assert.equal(engine.currentTrack, 'wind');
});

test('T-21 关闭背景音：停止并回到 off', () => {
  const { ctx, state } = makeFakeContext();
  const engine = createAudioEngine({ audioContextFactory: () => ctx });

  engine.startAmbient(AMBIENT_TRACKS.BROWN);
  const stopped = engine.stopAmbient();
  assert.equal(stopped.track, 'off');
  assert.equal(engine.currentTrack, 'off');
  assert.ok(state.stopped >= 1);
});

test('T-22 提示音：四种音色都能合成，且使用振荡器', () => {
  const { ctx, state } = makeFakeContext();
  const engine = createAudioEngine({ audioContextFactory: () => ctx });

  for (const kind of Object.values(CHIME_KINDS)) {
    const result = engine.playChime(kind);
    assert.equal(result.ok, true, `${kind} 应能播放`);
  }
  assert.ok(state.oscillators >= 4, '提示音必须用振荡器合成');
});

test('T-23 暂停/继续：背景音淡出/淡入，不影响计时状态', () => {
  const { ctx } = makeFakeContext();
  const engine = createAudioEngine({ audioContextFactory: () => ctx });

  engine.startAmbient(AMBIENT_TRACKS.RAIN);
  assert.equal(engine.fadeOutAmbient().ok, true);
  assert.equal(engine.fadeInAmbient().ok, true);
  assert.equal(engine.currentTrack, 'rain', '淡出淡入不改变当前音轨');
});

test('音频不可用时提示音也安静失败，不抛异常', () => {
  const engine = createAudioEngine({ audioContextFactory: () => null });
  const result = engine.playChime(CHIME_KINDS.BELL);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'audio-unavailable');
});
