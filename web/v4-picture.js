// V4d (docs/ops/V4_DESIGN.md → V4d): her picture in the new look. Settings → Appearance → Her picture
// (this device, sara.herPicture): the presence orb (default), her portrait, or the picture you
// uploaded (Settings → Her). A picture shows round with the orb's live state as a thin ring
// (web/v4-pages.css). Sara Classic always shows her picture, as before.
// A1 (docs/ops/A1_AVATAR_DESIGN.md): her portrait is now animated (web/avatar.js); 'portrait-still'
// keeps the still picture, 'vrm' shows a 3D model brought by the owner (web/avatar-vrm.js).

/** The mode to show: 'orb', 'portrait', 'still', 'own' or 'vrm'. Nothing picked: your picture if you uploaded one (as in 3.0.0), else the orb. */
export function herPictureMode(stored, custom) {
  if (stored === 'orb') return 'orb';
  if (stored === 'portrait') return 'portrait';
  if (stored === 'portrait-still') return 'still';
  if (stored === 'vrm') return 'vrm';
  if (stored === 'own') return custom ? 'own' : 'portrait';
  return custom ? 'own' : 'orb';
}

/**
 * How the picture moves: 'rig' (her portrait with its frames), 'warp' (your picture, fitted),
 * 'breathe' (your picture, not fitted yet: breathing and the ring), 'vrm', or null (still / the orb).
 */
export function pictureMotion(mode, { fitted = false, vrm = false } = {}) {
  if (mode === 'portrait') return 'rig';
  if (mode === 'vrm') return vrm ? 'vrm' : 'rig';
  if (mode === 'own') return fitted ? 'warp' : 'breathe';
  return null;
}
