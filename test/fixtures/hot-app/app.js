// The shop page. Storage keeps the visit count (it works only at a real address, not a preview link).
var visits = Number(localStorage.getItem('visits') || 0) + 1;
localStorage.setItem('visits', String(visits));
document.getElementById('visits').textContent = 'Visits: ' + visits;

fetch('/api/cart')
  .then(function (r) { return r.json(); })
  .then(function (cart) {
    var list = document.getElementById('items');
    cart.items.forEach(function (it) {
      var li = document.createElement('li');
      li.textContent = it.name + ': $' + it.price.toFixed(2);
      list.appendChild(li);
    });
    document.getElementById('total').textContent = 'Total: $' + cart.totl.toFixed(2);
  });
