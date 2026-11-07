// Same build, reproducible: honors SOURCE_DATE_EPOCH and emits only relative paths.
function build(inputs, env) {
  const stamp = new Date(env.sourceDateEpoch * 1000).toISOString();
  const banner = '// built ' + stamp + ' from src\n';
  const body = Object.keys(inputs).sort().filter(p => p.endsWith('.js')).map(p => inputs[p]).join('');
  return {
    'dist/bundle.js': banner + body,
    'dist/version.json': JSON.stringify({version: inputs['src/version.txt'].trim(), builtAt: env.sourceDateEpoch * 1000}) + '\n',
    'dist/LICENSE.txt': 'Synthetic fixture\n'
  };
}
