/**
 * Audio, synthesised at runtime with the Web Audio API.
 *
 * There are no sample files in this project -- not for licensing convenience,
 * but because a procedural engine can track speed and boost continuously in a
 * way a looped sample can't. The engine is two detuned sawtooths whose pitch
 * follows speed, with a noise layer that opens up under boost.
 */

import { clamp } from '../core/math';

interface EngineVoice {
  osc: OscillatorNode[];
  gain: GainNode;
  filter: BiquadFilterNode;
  noise: GainNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private engine: EngineVoice | null = null;
  private crowdGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private masterVolume = 0.7;
  private sfxVolume = 0.9;
  private enabled = true;

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture -- browsers block audio otherwise. */
  async resume(): Promise<void> {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.master) this.master.gain.value = enabled ? this.masterVolume : 0;
  }

  setVolume(volume: number): void {
    this.masterVolume = clamp(volume, 0, 1);
    if (this.master && this.enabled) this.master.gain.value = this.masterVolume;
  }

  private init(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.masterVolume : 0;
    this.master.connect(ctx.destination);

    // A gentle limiter keeps a pile-up of goal explosions from clipping.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVolume;
    this.sfxBus.connect(limiter);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.35;
    this.musicBus.connect(limiter);

    this.noiseBuffer = this.makeNoiseBuffer(ctx);
    this.buildEngine(ctx);
    this.buildCrowd(ctx);
  }

  /** Two seconds of pink-ish noise, reused by every noise-based effect. */
  private makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      // Cheap pink filter: warmer than white, less fizzy under a resonant sweep.
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57555 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2;
    }
    return buffer;
  }

  private buildEngine(ctx: AudioContext): void {
    if (!this.sfxBus) return;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 3;

    const osc: OscillatorNode[] = [];
    for (const detune of [-9, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 70;
      o.detune.value = detune;
      o.connect(filter);
      o.start();
      osc.push(o);
    }

    // Boost layer: filtered noise that swells with the throttle.
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = this.noiseBuffer;
    noiseSource.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 1400;
    noiseFilter.Q.value = 1.1;
    const noise = ctx.createGain();
    noise.gain.value = 0;
    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noise);
    noise.connect(gain);
    noiseSource.start();

    filter.connect(gain);
    gain.connect(this.sfxBus);

    this.engine = { osc, gain, filter, noise };
  }

  private buildCrowd(ctx: AudioContext): void {
    if (!this.musicBus) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 620;
    filter.Q.value = 0.6;
    const gain = ctx.createGain();
    gain.gain.value = 0.12;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.musicBus);
    source.start();
    this.crowdGain = gain;
  }

  /**
   * Continuous engine state. `speed` is 0..1 of top speed, `throttle` 0..1,
   * `boosting` opens the noise layer and pushes the filter up.
   */
  updateEngine(speed: number, throttle: number, boosting: boolean, airborne: boolean): void {
    if (!this.engine || !this.ctx) return;
    const now = this.ctx.currentTime;
    const smooth = 0.08;

    // Pitch tracks speed across roughly two octaves, with a lift under boost.
    const base = 58 + speed * 168 + (boosting ? 26 : 0);
    for (const o of this.engine.osc) {
      o.frequency.setTargetAtTime(base, now, smooth);
    }

    // Airborne engines get quieter and duller -- no load on the wheels.
    const load = airborne ? 0.35 : 0.5 + throttle * 0.5;
    const level = (0.06 + speed * 0.14) * load;
    this.engine.gain.gain.setTargetAtTime(level, now, smooth);
    this.engine.filter.frequency.setTargetAtTime(
      620 + speed * 2400 + (boosting ? 1500 : 0),
      now,
      smooth,
    );
    this.engine.noise.gain.setTargetAtTime(boosting ? 0.16 : 0, now, 0.05);
  }

  /** Crowd excitement, 0..1: drives ambience volume and brightness. */
  setCrowdExcitement(level: number): void {
    if (!this.crowdGain || !this.ctx) return;
    this.crowdGain.gain.setTargetAtTime(0.08 + clamp(level, 0, 1) * 0.5, this.ctx.currentTime, 0.4);
  }

  // ------------------------------------------------------------------ one-shots

  private noiseBurst(duration: number, frequency: number, q: number, gainValue: number, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || !this.noiseBuffer) return;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = 0.8 + Math.random() * 0.4;

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(frequency, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(60, frequency * 0.35),
      ctx.currentTime + duration,
    );
    filter.Q.value = q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus);
    source.start();
    source.stop(ctx.currentTime + duration + 0.02);
  }

  private tone(freq: number, duration: number, gainValue: number, type: OscillatorType = 'sine', slideTo?: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + duration);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(gainValue, ctx.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(this.sfxBus);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
  }

  /** Ball contact: pitch and level scale with the impulse. */
  ballHit(impulse: number): void {
    const strength = clamp(impulse / 40000, 0.05, 1);
    this.noiseBurst(0.1 + strength * 0.12, 500 + strength * 1400, 1.4, 0.16 + strength * 0.4);
    this.tone(120 + strength * 90, 0.16, 0.1 + strength * 0.22, 'triangle', 70);
  }

  ballBounce(impulse: number): void {
    const strength = clamp(impulse / 30000, 0.05, 1);
    this.noiseBurst(0.09, 320 + strength * 700, 2.2, 0.06 + strength * 0.2);
  }

  jump(): void {
    this.noiseBurst(0.09, 1500, 2.5, 0.1, 'highpass');
  }

  dodge(): void {
    this.noiseBurst(0.16, 900, 1.6, 0.14);
    this.tone(320, 0.14, 0.07, 'square', 180);
  }

  land(impact: number): void {
    const strength = clamp(impact / 2300, 0, 1);
    if (strength < 0.06) return;
    this.noiseBurst(0.1, 260 + strength * 320, 1.2, 0.06 + strength * 0.18);
  }

  boostPickup(big: boolean): void {
    this.tone(big ? 520 : 700, big ? 0.24 : 0.13, big ? 0.16 : 0.09, 'sine', big ? 1180 : 1020);
  }

  bump(impulse: number): void {
    const strength = clamp(impulse / 90000, 0.05, 1);
    this.noiseBurst(0.13, 260, 1.1, 0.1 + strength * 0.3, 'lowpass');
  }

  explosion(): void {
    this.noiseBurst(0.75, 1700, 0.6, 0.55, 'lowpass');
    this.tone(90, 0.6, 0.3, 'sawtooth', 32);
  }

  goal(): void {
    this.explosion();
    // A short rising fanfare over the blast.
    const notes = [392, 523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      window.setTimeout(() => this.tone(freq, 0.5, 0.13, 'square'), i * 105);
    });
  }

  countdownTick(final: boolean): void {
    this.tone(final ? 880 : 520, final ? 0.35 : 0.12, 0.13, 'square');
  }

  whistle(): void {
    this.noiseBurst(0.4, 2600, 9, 0.2);
  }
}
