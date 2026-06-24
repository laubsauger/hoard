// Phase 3 (GameViewport decomposition): the tactical camera rig for the viewport.
// The CameraRig already owns the zoom/rotate/pitch math (clamped + stepped); this thin factory just
// constructs it at the resolved tier settings with the canvas's initial aspect. Rotate/zoom are driven
// by the input handlers and the engine handle; the frame loop calls setTarget each frame.

import { CameraRig, resolveCameraSettings } from '../../render/engine';
import type { QualityTier } from '../../config/types';

export function createCameraController(canvas: HTMLCanvasElement, tier: QualityTier): CameraRig {
  return new CameraRig(resolveCameraSettings(tier), canvas.clientWidth / Math.max(1, canvas.clientHeight));
}
