'use strict'

var scan = require('./scan.cjs')
var parse = require('./parse.cjs')

module.exports = function (source) {
  return parse(scan(source))
}
