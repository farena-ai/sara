// V4d (docs/ops/V4_DESIGN.md → V4d): her picture in the new look. Settings → Appearance → Her picture
// (this device, sara.herPicture): the presence orb (default), her portrait, or the picture you
// uploaded (Settings → Her). A picture shows round with the orb's live state as a thin ring
// (web/v4-pages.css). Sara Classic always shows her picture, as before.

/** The mode to show: 'orb', 'portrait' or 'own'. Nothing picked: your picture if you uploaded one (as in 3.0.0), else the orb. */
export function herPictureMode(stored, custom) {
  if (stored === 'orb') return 'orb';
  if (stored === 'portrait') return 'portrait';
  if (stored === 'own') return custom ? 'own' : 'portrait';
  return custom ? 'own' : 'orb';
}
