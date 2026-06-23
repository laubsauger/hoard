// Phase 3 (GameViewport decomposition): pointer→world aiming for the viewport.
// Owns the NDC cursor + a ground-plane raycaster, shared by the input handlers (which update the NDC
// on mousemove and read the world point on click) and the frame loop (which re-projects each frame so
// the player keeps facing the cursor). Pure render-side state — never touches the sim (V2).

import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import type { CameraRig } from '../../render/engine';

export class AimRaycaster {
  private readonly ndc = new Vector2(0, 0);
  private readonly raycaster = new Raycaster();
  private readonly groundPlane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly aimPoint = new Vector3();

  /** Update the aim NDC from a pointer event relative to the canvas. */
  setFromPointer(clientX: number, clientY: number, rect: DOMRect): void {
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  /** Project the current aim NDC onto the ground plane (y=0), or null when the ray is parallel. */
  worldPoint(camera: CameraRig): Vector3 | null {
    this.raycaster.setFromCamera(this.ndc, camera.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, this.aimPoint) ? this.aimPoint : null;
  }
}
