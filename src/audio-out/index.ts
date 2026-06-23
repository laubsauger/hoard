// Procedural WebAudio output lane — public surface. The pure event→sound mapping is testable headless;
// GameAudio is the thin Web Audio boundary the viewport constructs + drives.
export * from './audioMapping';
export { GameAudio, resolveAudioOutTuning, type AudioFrameInput } from './gameAudio';
