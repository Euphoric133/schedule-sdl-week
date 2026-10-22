/**
 * 学习任务计时的音频引擎（背景音 + 完成提示音）。
 *
 * 为什么自己写一份：花园里的背景音是它打包内部实现、且绑定它自己的
 * `ambientTrack` / `ambientVolume` 设置。直接复用会污染番茄钟的状态，
 * 所以这里用 Web Audio **合成**一套独立音轨（不引入任何音频文件）。
 *
 * 设计要点：
 * - 通过依赖注入接收 `audioContextFactory`，Node 测试可以塞替身，不需要真实音频；
 * - 所有节点在一个 AudioContext + master gain 下，切换音轨先淡出旧节点；
 * - 音量只改 gain，不重建音频图；
 * - 任何一步失败都返回结构化结果，绝不让计时本身崩掉。
 */

export const AMBIENT_TRACKS = Object.freeze({
  OFF: 'off',
  RAIN: 'rain',
  STREAM: 'stream',
  WIND: 'wind',
  BROWN: 'brown',
});

export const AMBIENT_LABELS = Object.freeze({
  off: '关闭',
  rain: '雨声',
  stream: '溪流',
  wind: '风声',
  brown: '低频噪声',
});

export const CHIME_KINDS = Object.freeze({
  BELL: 'bell',
  CHIME: 'chime',
  SOFT: 'soft',
  DIGITAL: 'digital',
});

export const CHIME_LABELS = Object.freeze({
  bell: '花园钟声',
  chime: '清脆铃音',
  soft: '柔和提示',
  digital: '电子提示',
});

const FADE_SECONDS = 0.25;

/** 各音轨的噪声与滤波参数（参数化，便于调整） */
const TRACK_PARAMS = {
  [AMBIENT_TRACKS.RAIN]: { color: 'white', type: 'highpass', frequency: 900, q: 0.7, gain: 0.5 },
  [AMBIENT_TRACKS.STREAM]: { color: 'white', type: 'bandpass', frequency: 1100, q: 0.8, gain: 0.45 },
  [AMBIENT_TRACKS.WIND]: { color: 'pink', type: 'lowpass', frequency: 420, q: 0.6, gain: 0.55 },
  [AMBIENT_TRACKS.BROWN]: { color: 'brown', type: 'lowpass', frequency: 300, q: 0.5, gain: 0.6 },
};

/** 提示音：频率序列与包络（用振荡器合成，不用音频文件） */
const CHIME_PARAMS = {
  [CHIME_KINDS.BELL]: { notes: [523.25, 784], decay: 1.4, type: 'sine', gain: 0.35 },
  [CHIME_KINDS.CHIME]: { notes: [880, 1320], decay: 0.9, type: 'triangle', gain: 0.3 },
  [CHIME_KINDS.SOFT]: { notes: [440], decay: 1.8, type: 'sine', gain: 0.25 },
  [CHIME_KINDS.DIGITAL]: { notes: [660, 990, 1320], decay: 0.5, type: 'square', gain: 0.18 },
};

/**
 * 创建音频引擎。
 *
 * @param {{audioContextFactory?: () => object, now?: () => number}} [options]
 */
export function createAudioEngine({ audioContextFactory = defaultContextFactory } = {}) {
  let ctx = null;
  let master = null;
  let ambientNodes = null;
  let currentTrack = AMBIENT_TRACKS.OFF;
  let ambientVolume = 0.35;
  let chimeVolume = 0.5;

  function ensureContext() {
    if (ctx) return ctx;
    let created = null;
    try {
      created = audioContextFactory?.();
    } catch {
      created = null;
    }
    if (!created) return null;
    ctx = created;
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    return ctx;
  }

  /** 生成噪声缓冲（white / pink / brown） */
  function makeNoiseBuffer(kind) {
    const seconds = 2;
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      if (kind === 'brown') {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      } else if (kind === 'pink') {
        last = 0.98 * last + 0.02 * white;
        data[i] = last * 2.4 + white * 0.2;
      } else {
        data[i] = white;
      }
    }
    return buffer;
  }

  function stopAmbientNodes(immediate = false) {
    if (!ambientNodes) return;
    const { source, gain } = ambientNodes;
    const at = ctx?.currentTime ?? 0;
    try {
      if (gain?.gain) {
        gain.gain.cancelScheduledValues?.(at);
        gain.gain.setValueAtTime?.(gain.gain.value ?? 0, at);
        gain.gain.linearRampToValueAtTime?.(0, at + (immediate ? 0.01 : FADE_SECONDS));
      }
    } catch {
      // 忽略：淡出失败不影响停止
    }
    const stopAt = at + (immediate ? 0.02 : FADE_SECONDS + 0.02);
    try {
      source?.stop?.(stopAt);
    } catch {
      // 已经停止过
    }
    try {
      source?.disconnect?.();
      gain?.disconnect?.();
    } catch {
      // 忽略
    }
    ambientNodes = null;
  }

  /**
   * 开始播放某个背景音。
   *
   * @param {string} track
   * @param {number} [volume]
   * @returns {{ok: boolean, reason?: string, track?: string}}
   */
  function startAmbient(track, volume = ambientVolume) {
    if (!Object.values(AMBIENT_TRACKS).includes(track) || track === AMBIENT_TRACKS.OFF) {
      stopAmbient();
      return { ok: true, track: AMBIENT_TRACKS.OFF };
    }
    const context = ensureContext();
    if (!context) return { ok: false, reason: 'audio-unavailable' };

    // 浏览器策略：被挂起的上下文需要用户手势才能 resume
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      try {
        context.resume();
      } catch {
        return { ok: false, reason: 'audio-suspended' };
      }
    }

    // 切轨：先淡出旧节点，避免叠加与爆音
    stopAmbientNodes();

    const params = TRACK_PARAMS[track] ?? TRACK_PARAMS[AMBIENT_TRACKS.RAIN];
    const source = context.createBufferSource();
    source.buffer = makeNoiseBuffer(params.color);
    source.loop = true;

    const filter = context.createBiquadFilter();
    filter.type = params.type;
    filter.frequency.value = params.frequency;
    filter.Q.value = params.q;

    const gain = context.createGain();
    gain.gain.value = 0;
    const target = Math.max(0, Math.min(1, volume)) * params.gain;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start();
    try {
      const at = context.currentTime ?? 0;
      gain.gain.setValueAtTime?.(0, at);
      gain.gain.linearRampToValueAtTime?.(target, at + FADE_SECONDS);
    } catch {
      gain.gain.value = target;
    }

    ambientNodes = { source, gain, filter };
    currentTrack = track;
    ambientVolume = Math.max(0, Math.min(1, volume));
    return { ok: true, track };
  }

  /** 停止背景音并释放节点 */
  function stopAmbient() {
    stopAmbientNodes();
    currentTrack = AMBIENT_TRACKS.OFF;
    return { ok: true, track: AMBIENT_TRACKS.OFF };
  }

  /** 淡出（暂停计时用） */
  function fadeOutAmbient() {
    if (!ambientNodes) return { ok: true };
    try {
      const at = ctx?.currentTime ?? 0;
      const gain = ambientNodes.gain;
      gain.gain.cancelScheduledValues?.(at);
      gain.gain.setValueAtTime?.(gain.gain.value ?? 0, at);
      gain.gain.linearRampToValueAtTime?.(0, at + FADE_SECONDS);
    } catch {
      // 忽略
    }
    return { ok: true };
  }

  /** 淡入（继续计时用） */
  function fadeInAmbient() {
    if (!ambientNodes || currentTrack === AMBIENT_TRACKS.OFF) return { ok: true };
    const params = TRACK_PARAMS[currentTrack] ?? TRACK_PARAMS[AMBIENT_TRACKS.RAIN];
    try {
      const at = ctx?.currentTime ?? 0;
      const gain = ambientNodes.gain;
      gain.gain.cancelScheduledValues?.(at);
      gain.gain.setValueAtTime?.(gain.gain.value ?? 0, at);
      gain.gain.linearRampToValueAtTime?.(ambientVolume * params.gain, at + FADE_SECONDS);
    } catch {
      // 忽略
    }
    return { ok: true };
  }

  /** 音量：只改 gain，不重建音频图 */
  function setAmbientVolume(volume) {
    ambientVolume = Math.max(0, Math.min(1, Number(volume) || 0));
    if (!ambientNodes) return { ok: true };
    const params = TRACK_PARAMS[currentTrack] ?? TRACK_PARAMS[AMBIENT_TRACKS.RAIN];
    try {
      ambientNodes.gain.gain.setTargetAtTime?.(ambientVolume * params.gain, ctx?.currentTime ?? 0, 0.05);
    } catch {
      try {
        ambientNodes.gain.gain.value = ambientVolume * params.gain;
      } catch {
        // 忽略
      }
    }
    return { ok: true };
  }

  /**
   * 播放一次完成提示音。
   *
   * @param {string} kind
   * @param {number} [volume]
   * @returns {{ok: boolean, reason?: string}}
   */
  function playChime(kind = CHIME_KINDS.BELL, volume = chimeVolume) {
    const context = ensureContext();
    if (!context) return { ok: false, reason: 'audio-unavailable' };

    const params = CHIME_PARAMS[kind] ?? CHIME_PARAMS[CHIME_KINDS.BELL];
    const at = (context.currentTime ?? 0) + 0.02;
    for (const [index, frequency] of params.notes.entries()) {
      const start = at + index * 0.16;
      try {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = params.type;
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.001, params.gain * volume), start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + params.decay);
        osc.connect(gain);
        gain.connect(master);
        osc.start(start);
        osc.stop(start + params.decay + 0.05);
      } catch {
        return { ok: false, reason: 'chime-failed' };
      }
    }
    return { ok: true };
  }

  /** 释放整个引擎（切换页面/结束计时时） */
  function dispose() {
    stopAmbientNodes(true);
    try {
      master?.disconnect?.();
    } catch {
      // 忽略
    }
    try {
      ctx?.close?.();
    } catch {
      // 忽略
    }
    ctx = null;
    master = null;
    currentTrack = AMBIENT_TRACKS.OFF;
  }

  return {
    startAmbient,
    stopAmbient,
    fadeInAmbient,
    fadeOutAmbient,
    setAmbientVolume,
    playChime,
    dispose,
    get currentTrack() {
      return currentTrack;
    },
    get hasContext() {
      return Boolean(ctx);
    },
  };
}

/** 默认使用浏览器 AudioContext；不可用时返回 null（调用方安静降级） */
function defaultContextFactory() {
  try {
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    return typeof Ctor === 'function' ? new Ctor() : null;
  } catch {
    return null;
  }
}
