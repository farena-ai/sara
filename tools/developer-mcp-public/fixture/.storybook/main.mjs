import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
export default {
  stories:[resolve(here,'../../../../test/fixtures/developer/mcp-public/Button.stories.js')],
  framework:{name:resolve(here,'../../node_modules/@storybook/html-vite'),options:{}},
  addons:[{name:resolve(here,'../../node_modules/@storybook/addon-mcp'),options:{toolsets:{dev:true,docs:false,test:false}}}],
  core:{disableTelemetry:true},
  features:{componentsManifest:false,changeDetection:false,experimentalReview:false},
  viteFinal(config){return {...config,server:{...config.server,host:'127.0.0.1',fs:{strict:true,allow:[resolve(here,'../..'),resolve(here,'../../../../test/fixtures/developer/mcp-public')]}}};}
};
