import {plugin} from './sara-plugin.mjs';
import {handle,parameters,labels} from './workflow.mjs';
const tool={name:'analyze',description:labels.en.description,parameters,permission:'ask',run:(args,sara)=>handle(args,sara.lang)};
plugin({tools:[tool],init:sara=>{tool.description=(labels[sara.lang]??labels.en).description;}});
