#!/usr/bin/env python3
"""Validate large native source response envelopes through the production C parser."""
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
OPERATION = '11111111-1111-4111-8111-111111111111'
HARNESS = r'''
#include "transport.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char **argv){
 if(argc!=4)return 2;
 FILE *file=fopen(argv[2],"rb");if(!file)return 3;
 if(fseek(file,0,SEEK_END))return 3;
 long size=ftell(file);rewind(file);
 if(size<0||size>96L*1024L*1024L)return 3;
 char *text=malloc((size_t)size+1);HfJson *json=malloc(sizeof *json);
 if(!text||!json||fread(text,1,(size_t)size,file)!=(size_t)size)return 4;
 fclose(file);text[size]=0;
 size_t maximum=(size_t)strtoull(argv[3],NULL,10);
 int valid=!strcmp(argv[1],"envelope")?hf_json_parse_envelope(json,text,maximum):hf_json_parse_bounded(json,text,maximum);
 if(valid){
  char operation[37];int64_t version=0;const char *fields[]={"protocol_version","operation_id","result","error"};
  valid=hf_json_only(json,0,fields,4)&&hf_json_get(json,"operation_id",operation,sizeof operation)&&!strcmp(operation,"11111111-1111-4111-8111-111111111111")&&hf_json_i64(json,hf_json_field(json,0,"protocol_version"),&version)&&version==1;
  int result=hf_json_field(json,0,"result"),error=hf_json_field(json,0,"error");
  valid=valid&&((result>=0)!=(error>=0));
  char *raw=valid?hf_json_raw(json,result>=0?result:error):NULL;
  valid=valid&&raw!=NULL;
  free(raw);
 }
 free(json);free(text);return valid?0:1;
}
'''


def main():
    with tempfile.TemporaryDirectory(prefix='hf-source-envelope-') as temporary:
        directory = Path(temporary)
        source, binary = directory / 'parser.c', directory / 'parser'
        source.write_text(HARNESS)
        subprocess.run(['cc', '-Wall', '-Wextra', '-Werror', '-O2', '-I', str(ROOT / 'core/native/src/hyperfide'), str(source), str(ROOT / 'core/native/src/hyperfide/transport.c'), '-lcurl', '-lcrypto', '-lpthread', '-o', str(binary)], check=True, capture_output=True)

        def run(raw, accepted, limit=96 * 1024 * 1024, mode='envelope'):
            encoded = raw.encode('utf-8') if isinstance(raw, str) else raw
            filename = directory / 'response.json'
            filename.write_bytes(encoded)
            result = subprocess.run([str(binary), mode, str(filename), str(limit)], capture_output=True, timeout=30)
            assert result.returncode == (0 if accepted else 1), (mode, result.returncode, result.stderr.decode())

        large = json.dumps({'protocol_version': 1, 'operation_id': OPERATION, 'result': {'entries': [{'path': f'src/file-{i}.ts', 'mode': '100644', 'object_id': 'sha256:' + 'a' * 64} for i in range(100000)]}}, separators=(',', ':'))
        run(large, False, mode='normal')
        run(large, True)
        run(large, False, limit=len(large.encode()) - 1)
        prefix = '{"protocol_version":1,"operation_id":' + json.dumps(OPERATION) + ',"result":'
        for payload in ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '[{"path":"one","path":"two"}]', '{"entries":[1,]}', '{"value":"\\ud800"}', '{"value":"\\udc00"}', '{"value":"\\ud800A"}']:
            run(prefix + payload + '}', False)
        for payload in ['{"value":"\\ud83d\\ude80"}', '{"entries":[{"one":[1,2,3]},{"two":{"three":true}}]}']:
            run(prefix + payload + '}', True)
        run(prefix + '[' * 65 + '0' + ']' * 65 + '}', False)
        run(large[:-2], False)
        run(prefix.encode() + b'{"value":"\xff"}}', False)
        run(prefix + '{} ,"result":{}}', False)
        run('{"protocol_version":1,"operation_id":' + json.dumps(OPERATION) + ',"error":{"code":"SCOPE_DENIED","message":"Denied","retry":"NEVER","outcome":"KNOWN"}}', True)
        receipt = {'status': 'PASS', 'scope': 'production C response-envelope parser', 'large_manifest_entries': 100000, 'large_manifest_bytes': len(large.encode()), 'checks': ['large valid manifest succeeds beyond normal token budget', 'response byte limit and truncation are enforced', 'duplicate keys including escaped aliases are rejected at every nesting level', 'invalid Unicode and excessive nesting are rejected', 'root envelope fields remain readable for result and error responses']}
        evidence = ROOT / 'build/source-control/envelope-parser'
        evidence.mkdir(parents=True, exist_ok=True)
        (evidence / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
