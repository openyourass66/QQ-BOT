import {cp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';

export async function copyRuntimeHost(root) {
  for(const directory of ['desktop','scripts','dist/core'])await mkdir(join(root,directory),{recursive:true});
  for(const file of ['desktop/host.mjs','desktop/runtime-fields.mjs','scripts/runtime-service.mjs','scripts/runtime-configuration.mjs','scripts/runtime-lease.mjs','scripts/app-paths.mjs','scripts/setup.mjs','scripts/component-paths.mjs','dist/core/resource-lock.js'])await cp(resolve(file),join(root,file));
  await mkdir(join(root,'dist/agent'),{recursive:true});
  await cp(resolve('dist/agent/chat-model.js'),join(root,'dist/agent/chat-model.js'));
}
