/** 按真实赋值边界替换，避免多行值中的正文被误当字段或遗留在文件里。 */
export function replaceEnvAssignments(text,changes) {
  const assignment=/^[ \t\uFEFF]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/gm;
  const found=new Set();let result='',cursor=0,match;
  while((match=assignment.exec(text))) {
    const start=assignment.lastIndex,quote=text[start];let end;
    if(['"',"'",'`'].includes(quote)) {
      const close=text.indexOf(quote,start+1);if(close<0)throw new Error('连接配置格式无效：配置中的引号未闭合');
      end=text.indexOf('\n',close+1);
    }else end=text.indexOf('\n',start);
    if(end<0)end=text.length;
    if(Object.hasOwn(changes,match[1])){result+=text.slice(cursor,match.index)+(changes[match[1]]??'');cursor=end;found.add(match[1]);}
    assignment.lastIndex=end+1;
  }
  result+=text.slice(cursor);
  for(const [key,line] of Object.entries(changes))if(!found.has(key)&&line!==null)result+='\n'+line;
  return result;
}
