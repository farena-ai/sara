import { plugin } from './native.mjs';
import { only, text, list, result, tool } from './workflow.mjs';
plugin({ tools: [tool('Organize explicitly approved supplied device and scene metadata into a read-only, non-live snapshot. No connection, scene execution or device control.', async args => {
  only(args, ['observedAt', 'devices', 'scenes']);
  const observedAt = text(args.observedAt, 'observedAt', 30);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt.replace(/Z$/, observedAt.includes('.') ? 'Z' : '.000Z')) throw new Error('Use a real UTC ISO observedAt timestamp.');
  const ids = new Set();
  const clean = (x, scene) => {
    only(x, scene ? ['id', 'name', 'approved'] : ['id', 'name', 'state', 'approved']);
    if (x.approved !== true) throw new Error('Include only explicitly approved metadata.');
    const id = text(x.id, 'id', 100), name = text(x.name, 'name', 100);
    if (!/^[a-z_]+\.[a-z0-9_]+$/.test(id) || (scene && !id.startsWith('scene.'))) throw new Error('Use an entity ID; scenes must start scene.');
    if (ids.has(id)) throw new Error('Entity IDs must be unique.'); ids.add(id);
    return { id, name, ...(scene ? {} : { suppliedState: text(x.state, 'state', 100), freshness: 'unverified supplied snapshot' }) };
  };
  const devices = list(args.devices, 'devices').map(x => clean(x, false)), scenes = list(args.scenes, 'scenes', 6).map(x => clean(x, true));
  return result({ observedAt, devices, scenes, live: false, controlled: false, prerequisite: 'For current states, configure Home Assistant in Sara Settings → Add-ons, then separately invoke the existing home_status tool. No tokens or private network addresses belong here.', limitation: 'Prepare-only: plugin broker approval may outlive the 30-second handler timeout. No home_control authority, no locks/alarms/doors/climate control and no hidden scene effects.' });
})] });
