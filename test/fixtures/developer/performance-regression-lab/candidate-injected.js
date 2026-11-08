// Same benchmark with a deliberately injected regression: four passes instead of one (about 4x, a
// 300% slowdown, ~16 ms a sample in the lab's vm). A 2x slowdown sat close enough to the 20% threshold
// and the noise limit that a busy host (the full suite) honestly reported 'inconclusive'; 4x stays
// conclusive and far below the 250 ms sample limit.
function work(n){let h=2166136261;for(let i=0;i<n;i++){h^=i;h=Math.imul(h,16777619);}return h>>>0;}
function bench(){let r=work(50000);r^=work(50000);r^=work(50000);r^=work(50000);return r;}
