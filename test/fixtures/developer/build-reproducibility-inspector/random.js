// Nondeterminism the inspector cannot attribute to time or path.
function build(inputs) { return {'dist/id.txt': String(Math.random()) + '\n'}; }
