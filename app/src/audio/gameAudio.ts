export type GameSound = "shuffle" | "deal" | "card" | "peg" | "count" | "click";

let context: AudioContext | null = null;
let enabled = true;
let volume = 0.55;

function audioContext() {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  context ??= new AudioCtx();
  if (context.state === "suspended") void context.resume();
  return context;
}

export function configureGameAudio(soundEnabled: boolean, soundVolume: number) {
  enabled = soundEnabled;
  volume = Math.max(0, Math.min(1, soundVolume));
}

export function unlockGameAudio() {
  if (enabled) void audioContext()?.resume();
}

function tone(frequency: number, duration: number, delay = 0, type: OscillatorType = "sine", level = 0.1) {
  if (!enabled) return;
  const ctx = audioContext();
  if (!ctx) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const start = ctx.currentTime + delay;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level * volume), start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function noise(duration: number, delay: number, level: number) {
  if (!enabled) return;
  const ctx = audioContext();
  if (!ctx) return;
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * duration)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = (Math.random() * 2 - 1) * (1 - index / data.length);
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.value = 1250;
  gain.gain.value = level * volume;
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(ctx.currentTime + delay);
}

export function playGameSound(sound: GameSound) {
  if (sound === "click") {
    tone(520, 0.045, 0, "triangle", 0.07);
  } else if (sound === "shuffle") {
    for (let index = 0; index < 7; index += 1) noise(0.065, index * 0.045, 0.055);
    tone(175, 0.14, 0.3, "triangle", 0.035);
  } else if (sound === "deal") {
    for (let index = 0; index < 6; index += 1) noise(0.045, index * 0.055, 0.05);
  } else if (sound === "card") {
    noise(0.065, 0, 0.075);
    tone(150, 0.07, 0, "triangle", 0.05);
  } else if (sound === "peg") {
    tone(440, 0.09, 0, "sine", 0.09);
    tone(554, 0.12, 0.07, "sine", 0.08);
  } else {
    tone(523, 0.11, 0, "sine", 0.08);
    tone(659, 0.14, 0.09, "sine", 0.09);
  }
}

