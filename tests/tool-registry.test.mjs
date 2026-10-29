import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHandlerGroups,createSocialHandlers} from '../dist/qq/handlers/registry.js';
import {socialTools} from '../dist/qq/social-tools.js';

test('工具处理器登记拒绝缺失、重复和未定义工具，完整定义只分派对应处理器',async()=>{
  let calls=0;const handler=async(name,args)=>{calls++;return {name,value:args.value};};
  const registered=registerHandlerGroups([{names:['known'],execute:handler}],['known']);assert.deepEqual(await registered.get('known')('known',{value:1},{}),{name:'known',value:1});assert.equal(calls,1);
  for(const [groups,expected]of [[[],['missing']],[[{names:['known','known'],execute:handler}],['known']],[[{names:['unknown'],execute:handler}],['known']],[[{names:['known'],execute:handler}],['known','known']]])assert.throws(()=>registerHandlerGroups(groups,expected),{code:'TOOL_REGISTRY_INVALID'});
  const complete=createSocialHandlers({});assert.deepEqual([...complete.keys()].sort(),socialTools.map(tool=>tool.name).sort());assert.ok([...complete.values()].every(value=>typeof value==='function'));
});
