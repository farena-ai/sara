/** Owned synthetic component. No external requests, scripts or application imports. */
export function Button({label,disabled=false}) {
  const button=document.createElement('button');
  button.type='button';button.textContent=label;button.disabled=disabled;
  button.dataset.fixture='sara-mcp-public';return button;
}
