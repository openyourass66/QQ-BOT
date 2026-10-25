import { readFileSync } from 'node:fs';
if(process.env.FAKE_AUTONOMY_CLOCK) {
  let last=Date.now();
  Date.now=()=>{try{const value=Number(readFileSync(process.env.FAKE_AUTONOMY_CLOCK,'utf8'));if(Number.isFinite(value)&&value>0)last=value;}catch{}return last;};
}
