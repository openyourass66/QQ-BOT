import {DatabaseSync} from 'node:sqlite';
import {dataFromRows} from '../../dist/storage/social-entities.js';
import {entityTables} from '../../dist/storage/database-types.js';

/** 仅供测试断言读取一致性视图，不打开写仓储或执行启动恢复。 */
export async function readSocialData(path){
  const db=new DatabaseSync(path+'.sqlite',{readOnly:true});
  try{
    db.exec('BEGIN');const rows=entityTables.flatMap(table=>db.prepare(`SELECT key,ordinal,payload FROM entity_${table} ORDER BY ordinal,key`).all().map(row=>({table,key:row.key,ordinal:row.ordinal,value:JSON.parse(row.payload)})));
    const data=dataFromRows(rows);data.messages=db.prepare('SELECT payload FROM messages ORDER BY at,id').all().map(row=>JSON.parse(row.payload));db.exec('COMMIT');return data;
  }finally{db.close();}
}
