// T5 / T7 — render engine barrel.

export {
  detectQualityTier,
  applyTierOverride,
  CapabilityError,
  type AdapterLimits,
} from './capability';
export { ResourceRegistry, type Disposable, type ResourceKind } from './resources';
export {
  FrameLoop,
  type SimUpdate,
  type RenderFn,
  type FrameResult,
  type TimeSource,
} from './frame';
export {
  RendererHost,
  type RendererBackend,
  type RendererBackendFactory,
  type HostStatus,
  type HostEvents,
  type ToneMappingMode,
} from './renderer';
export { createWebGpuBackendFactory, type WebGpuBackendOptions } from './webgpuBackend';
export {
  CameraRig,
  resolveCameraSettings,
  computeViewParams,
  rotateStep,
  normalizeYaw,
  clampZoom,
  clampPitch,
  type CameraSettings,
  type ViewParams,
  type ViewInput,
  type Vec3,
} from './camera';
