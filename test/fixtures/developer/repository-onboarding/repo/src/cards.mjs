export function render(template, city) {
  return template.trim().replace(/\{\{(\w+)\}\}/g, (_, k) => String(city[k]));
}
