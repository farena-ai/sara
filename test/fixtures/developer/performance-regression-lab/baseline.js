// Synthetic benchmark: fixed FNV-style integer work.
function work(n){let h=2166136261;for(let i=0;i<n;i++){h^=i;h=Math.imul(h,16777619);}return h>>>0;}
function bench(){return work(50000);}
