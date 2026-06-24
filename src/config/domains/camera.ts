// Config domain: camera. Owned by lane R (render).
// V21 — near-orthographic, ~35-45 deg downward pitch, diagonal yaw, 90 deg rotation steps,
// limited tactical zoom, stable combat framing. Every limit is a typed spec (V4), invalid throws.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const cameraConfig = registerDomain('camera', {
  // ---- Pitch (downward tilt) ----
  pitchDegreesMin: num({
    owner: 'camera',
    unit: 'degrees',
    doc: 'Minimum downward pitch (V21 lower bound of ~35-45 deg band).',
    default: 35,
    min: 10,
    max: 89,
  }),
  pitchDegreesMax: num({
    owner: 'camera',
    unit: 'degrees',
    doc: 'Maximum downward pitch (V21 upper bound of ~35-45 deg band).',
    default: 45,
    min: 10,
    max: 89,
  }),
  pitchDegreesDefault: num({
    owner: 'camera',
    unit: 'degrees',
    doc: 'Default downward pitch within the V21 band.',
    default: 40,
    min: 10,
    max: 89,
  }),

  // ---- Yaw (diagonal framing + 90 deg steps) ----
  yawDegreesDefault: num({
    owner: 'camera',
    unit: 'degrees',
    doc: 'Default diagonal yaw (V21 diagonal framing).',
    default: 45,
    min: 0,
    max: 360,
  }),
  rotationStepDegrees: num({
    owner: 'camera',
    unit: 'degrees',
    doc: '90-degree rotation step default (V21).',
    default: 90,
    min: 15,
    max: 180,
  }),

  // ---- Tactical zoom (orthographic frustum half-height in world meters) ----
  zoomMetersMin: num({
    owner: 'camera',
    unit: 'meters',
    doc: 'Closest tactical zoom: visible frustum half-height in meters (indoors / detail).',
    default: 6,
    min: 1,
    max: 100,
  }),
  zoomMetersMax: num({
    owner: 'camera',
    unit: 'meters',
    doc: 'Farthest tactical zoom: visible frustum half-height in meters (pull back for horde / survey the block).',
    default: 85,
    min: 1,
    max: 400,
  }),
  zoomMetersDefault: num({
    owner: 'camera',
    unit: 'meters',
    doc: 'Default tactical zoom (frustum half-height in meters).',
    default: 18,
    min: 1,
    max: 200,
  }),

  // ---- Near-orthographic perspective: narrow FOV + large distance => minimal convergence ----
  fovDegrees: num({
    owner: 'camera',
    unit: 'degrees',
    doc: 'Narrow vertical FOV producing a near-orthographic (not perfect ortho) projection (V21).',
    default: 18,
    min: 4,
    max: 60,
  }),
  nearPlaneMeters: num({
    owner: 'camera',
    unit: 'meters',
    doc: 'Camera near clip plane.',
    default: 1,
    min: 0.01,
    max: 100,
  }),
  farPlaneMeters: num({
    owner: 'camera',
    unit: 'meters',
    doc: 'Camera far clip plane.',
    default: 2000,
    min: 100,
    max: 100000,
  }),
});
