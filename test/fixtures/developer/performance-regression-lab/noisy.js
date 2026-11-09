// Deliberately noisy: each sample ends on a fixed repeating ladder of 6, 12, 24, 48 and 96 ms of wall
// time, so the verdict must stay inconclusive. The spread is the fixture's own (relative spread 0.75;
// still about 0.33 if a busy host adds 30 ms to every sample) against the lab's 0.25 noise limit.
// Random CPU work (1x..16x) was squeezed below the limit by host load and once read as a regression:
// load stretches CPU work, but it cannot shorten a paced sample.
function work(n){let h=2166136261;for(let i=0;i<n;i++){h^=i;h=Math.imul(h,16777619);}return h>>>0;}
// Sleeps until `end` (Date.now() time), spinning only the last 20 ms (timer ticks are coarse on Windows).
function until(end){const left=end-Date.now();if(left>20)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,left-20);while(Date.now()<end){}}
const ladder=[6,12,24,48,96];let step=0;
function bench(){const end=Date.now()+ladder[step++%ladder.length];const r=work(50000);until(end);return r;}
