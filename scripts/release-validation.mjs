import {lstat,readFile,readdir} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {createRequire,isBuiltin} from 'node:module';
import ts from 'typescript';

export const releaseScripts=['app-paths.mjs','setup.mjs','run.mjs','storage.mjs','maintenance.mjs','installer-core.mjs','install-worker.mjs','install-check.mjs','release-integrity.mjs','diagnostic-export.mjs','maintenance-cleanup.mjs','credentials.mjs','env-file.mjs','process-guard.mjs','managed-entry.mjs','supervisor.mjs','bounded-lines.mjs','component-paths.mjs','components.mjs','napcat-node.mjs','qq-runtime.mjs','qq-profile.mjs','qq-profile-preload.mjs','runtime-service.mjs','runtime-configuration.mjs','runtime-lease.mjs','media-cleaner.mjs'];
export const releaseRequired=['QQ-BOT.exe','WhaleSetup.exe','WhaleLauncher.exe','components/release-trust.json','开始使用.cmd','使用说明.html','release-manifest.json','runtime/node.exe','runtime/LICENSE','runtime/node_modules/npm/bin/npm-cli.js','package.json','package-lock.json','.env.example','LICENSE','templates/bot-persona.md','components/catalog.json','desktop/window.xaml','desktop/host.mjs','desktop/config-worker.mjs','desktop/component-worker.mjs','desktop/maintenance-worker.mjs','desktop/runtime-guard.exe','desktop/media-cleaner.exe','dist/bridge.js','dist/mcp-qq.js',...releaseScripts.map(file=>'scripts/'+file)];

/** Validate emitted modules without importing entry points that start services or mutate data. */
export async function validateRelease(root){
  root=resolve(root);const files=[];
  const inside=path=>{const rel=relative(root,path);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('发行模块引用越过程序目录');return rel.replaceAll('\\','/');};
  for(const name of ['.env','bot.config.json','data','user-data','napcat','bot-workspace','.credentials','.dsh'])if(await lstat(join(root,name)).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;}))throw new Error('发行目录包含个人配置或运行数据：'+name);
  for(const name of releaseRequired){const info=await lstat(join(root,name)).catch(()=>undefined);if(!info?.isFile()||info.isSymbolicLink())throw new Error('发行文件缺失或类型无效：'+name);}
  async function walk(path){
    for(const entry of await readdir(path,{withFileTypes:true})){
      const file=join(path,entry.name),info=await lstat(file);if(info.isSymbolicLink())throw new Error('发行程序模块不接受链接：'+inside(file));
      if(info.isDirectory())await walk(file);else if(info.isFile()&&/\.(?:mjs|js)$/.test(entry.name))files.push(file);
    }
  }
  for(const directory of ['desktop','dist','scripts'])await walk(join(root,directory));
  let relativeImports=0,packageImports=0;
  for(const file of files){
    const tree=ts.createSourceFile(file,await readFile(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),references=[];
    if(tree.parseDiagnostics.length)throw new Error('发行模块语法无效：'+inside(file));
    const visit=node=>{
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))references.push(node.moduleSpecifier.text);
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments.length&&ts.isStringLiteral(node.arguments[0]))references.push(node.arguments[0].text);
      if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='URL'&&node.arguments?.length&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text.startsWith('.'))references.push(node.arguments[0].text);
      ts.forEachChild(node,visit);
    };visit(tree);
    for(const specifier of new Set(references)){
      if(isBuiltin(specifier))continue;
      if(specifier.startsWith('.')){
        const path=resolve(file,'..',specifier);inside(path);const info=await lstat(path).catch(()=>undefined);
        if(!info?.isFile()||info.isSymbolicLink())throw new Error('发行模块缺少依赖：'+inside(file)+' → '+specifier);relativeImports++;
      }else{
        try{createRequire(file).resolve(specifier);}catch{throw new Error('发行模块缺少生产依赖：'+inside(file)+' → '+specifier);}packageImports++;
      }
    }
  }
  return {modules:files.length,relativeImports,packageImports};
}
