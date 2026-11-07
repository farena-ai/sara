// Same benchmark with a deliberately injected second pass (the regression under test).
function work(n){let h=2166136261;for(let i=0;i<n;i++){h^=i;h=Math.imul(h,16777619);}return h>>>0;}
function bench(){let r=work(50000);r^=work(50000);return r;}
