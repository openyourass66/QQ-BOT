import {test} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';

test('超长受限集合在校验元素前拒绝，错误数量不随输入条目增长',()=>{
  let checked=0;
  const schema=z.array(z.string().refine(()=>{checked++;return true;})).max(8);
  const result=schema.safeParse(Array(10000).fill('oversized-fixture'));
  assert.equal(result.success,false);assert.equal(checked,0);assert.equal(result.error.issues.length,1);
});
