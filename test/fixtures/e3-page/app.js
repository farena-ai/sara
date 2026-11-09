// E3 fixture: the wrong selector means the click does nothing.
document.querySelector('#save-button')?.addEventListener('click', () => {
  document.querySelector('#status').hidden = false;
});
