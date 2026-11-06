import { Button } from './Button.js';
export default {title:'Owned/Button',render:Button,argTypes:{label:{control:'text',description:'Visible synthetic button label'},disabled:{control:'boolean',description:'Whether interaction is disabled'}},parameters:{docs:{description:{component:'Owned synthetic Button fixture for no-account qualification.'}}}};
export const Primary={args:{label:'SARA PUBLIC MCP PRIMARY',disabled:false}};
export const Disabled={args:{label:'SARA PUBLIC MCP DISABLED',disabled:true}};
