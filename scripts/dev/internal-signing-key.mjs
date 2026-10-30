import {generateKeyPairSync} from 'node:crypto';
import {mkdir,writeFile,lstat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{directory:{type:'string'}}});if(!values.directory)throw Error('需要指定独立的 --directory，用于内部验证密钥');
const directory=resolve(values.directory);for(let path=directory;;path=dirname(path)){const state=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});if(state?.isSymbolicLink())throw Error('内部密钥目录不能使用链接');if(dirname(path)===path)break;}
await mkdir(directory,{recursive:true});const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:3072}),jwk=publicKey.export({format:'jwk'}),keyId='internal-validation';
const keyFile=join(directory,'internal-signing.pem'),trustFile=join(directory,'internal-trust.json');
await writeFile(keyFile,privateKey.export({format:'pem',type:'pkcs8'}),{flag:'wx',mode:0o600});await writeFile(trustFile,JSON.stringify({formatVersion:1,keys:[{id:keyId,algorithm:'rsa-sha256',modulus:Buffer.from(jwk.n,'base64url').toString('base64'),exponent:'AQAB',channels:['internal-validation']}]},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({keyId,keyFile,trustFile,scope:'internal-validation-only',formalPublisherIdentity:false}));
