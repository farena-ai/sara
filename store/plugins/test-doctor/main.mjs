import {plugin} from './sara-plugin.mjs';
import {handle} from './doctor.mjs';
import parameters from './schema.json' with {type:'json'};
import labels from './labels.json' with {type:'json'};
const tool={name:'diagnose',description:labels.en.description,permission:'ask',parameters,run:(args,sara)=>handle(args,sara.lang)};
plugin({tools:[tool],init:sara=>{tool.description=(labels[sara.lang]??labels.en).description;}});
