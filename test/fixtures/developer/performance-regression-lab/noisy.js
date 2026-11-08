// Deliberately noisy: work varies randomly per sample (uniformly 1x to 16x), so a verdict must stay
// inconclusive. The relative spread (about 0.47) sits well above the lab's 0.25 noise limit; the earlier
// 1x..8x spread (about 0.39) once read as a steady regression on a loaded host.
function work(n){let h=2166136261;for(let i=0;i<n;i++){h^=i;h=Math.imul(h,16777619);}return h>>>0;}
function bench(){return work(Math.floor(50000*(1+Math.random()*15)));}
