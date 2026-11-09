import {plugin} from './sara-plugin.mjs';
import {run,parameters,labels} from './workflow.mjs';
const tool={name:'request',description:labels.en[1],parameters,permission:'ask',run};
plugin({tools:[tool],init:sara=>{tool.description=(labels[sara.lang]??labels.en)[1];}});
