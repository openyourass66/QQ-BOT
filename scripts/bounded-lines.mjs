import {StringDecoder} from 'node:string_decoder';

export function consumeLines(stream,onLine,maxLength=8000) {
  const decoder=new StringDecoder('utf8');let buffer='',discard=false;
  const accept=text=>{
    for(const part of text.split(/(?<=\n)/)){
      const ended=part.endsWith('\n');
      if(!discard){buffer+=part;if(buffer.length>maxLength){onLine(buffer.slice(0,maxLength)+' [内容过长，已省略]');buffer='';discard=true;}else if(ended){onLine(buffer.replace(/\r?\n$/,''));buffer='';}}
      if(ended)discard=false;
    }
  };
  stream.on('data',chunk=>accept(decoder.write(chunk)));
  stream.once('end',()=>{accept(decoder.end());if(buffer&&!discard)onLine(buffer);buffer='';});
}
