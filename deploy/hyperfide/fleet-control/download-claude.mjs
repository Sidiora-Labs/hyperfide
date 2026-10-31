import fs from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable,Transform} from 'node:stream';
import {createHash} from 'node:crypto';
const url='https://downloads.claude.ai/claude-code-releases/2.1.300/linux-x64/claude',expected='674deba0bba9aee479f4503c438b49303b6fdd304b9a471b14977aaec5215453',size=266972344;
const target='/opt/hyperfide/bin/claude',temporary=target+'.download';
try{
 const response=await fetch(url,{signal:AbortSignal.timeout(300000)});if(!response.ok||!response.body)throw Error('CLAUDE_DOWNLOAD_FAILED');
 const hash=createHash('sha256');let bytes=0;
 await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>size){callback(Error('CLAUDE_SIZE_MISMATCH'));return;}hash.update(chunk);callback(null,chunk);}}),fs.createWriteStream(temporary,{flags:'wx',mode:0o755}));
 if(bytes!==size||hash.digest('hex')!==expected)throw Error('CLAUDE_ARTIFACT_MISMATCH');fs.renameSync(temporary,target);
}catch(error){try{fs.unlinkSync(temporary);}catch{}throw error;}
