// Fixture build with two deliberate nondeterminism sources: wall-clock time and the build path.
function build(inputs, env) {
  const banner = '// built ' + new Date().toISOString() + ' from ' + env.buildRoot + '/src\n';
  const body = Object.keys(inputs).sort().filter(p => p.endsWith('.js')).map(p => inputs[p]).join('');
  return {
    'dist/bundle.js': banner + body,
    'dist/version.json': JSON.stringify({version: inputs['src/version.txt'].trim(), builtAt: Date.now()}) + '\n',
    'dist/LICENSE.txt': 'Synthetic fixture\n'
  };
}
