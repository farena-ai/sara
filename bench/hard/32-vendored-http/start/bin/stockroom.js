#!/usr/bin/env node
// Sends one request to a fresh app and prints the response:
//   node bin/stockroom.js GET /items?tag=metal
//   node bin/stockroom.js POST /items '{"sku":"PIN-1","name":"Pin","stock":3}'
import { createApp } from '../src/app.js';

const [method = 'GET', path = '/health', body] = process.argv.slice(2);
const app = createApp();
const res = await app.dispatch({ method, path, body, headers: { 'X-Api-Key': 'dev-key' } });
console.log(res.status, JSON.stringify(res.headers));
if (res.text) console.log(res.text);
