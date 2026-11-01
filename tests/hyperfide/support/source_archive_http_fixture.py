"""HTTP boundary for the real Blaxel SDK, backed by owned Unix files and caller-owned native processes."""
import email.parser,email.policy,json,os,threading,uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote,urlsplit,parse_qs
class BlaxelHttpFixture:
 def __init__(self,metadata,resolve_path,process_handler):
  self.metadata=metadata;self.resolve_path=resolve_path;self.process_handler=process_handler;self.requests=[];self.uploads={};self.lock=threading.RLock();owner=self
  class Handler(BaseHTTPRequestHandler):
   protocol_version='HTTP/1.1'
   def log_message(self,*args):pass
   def send(self,status,value=None,binary=False):
    data=value if binary else json.dumps(value if value is not None else {}).encode();self.send_response(status);self.send_header('Content-Type','application/octet-stream' if binary else 'application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
   def route(self):
    parsed=urlsplit(self.path);path=unquote(parsed.path);query=parse_qs(parsed.query);length=int(self.headers.get('content-length','0'));body=self.rfile.read(length) if length else b''
    with owner.lock:owner.requests.append({'method':self.command,'path':path,'body_size':len(body)})
    marker='/sandboxes/'+owner.metadata['metadata']['name'];position=path.find(marker)
    if position>=0:
     suffix=path[position+len(marker):]
     if not suffix and self.command=='GET':return self.send(200,owner.metadata)
     path=suffix
    if path.startswith('/process'):
     identifier=path[len('/process'):].lstrip('/') or None;payload=json.loads(body) if body else None
     status,value=owner.process_handler(self.command,identifier,payload);return self.send(status,value)
    if path.startswith('/filesystem-multipart/initiate/') and self.command=='POST':
     remote=path[len('/filesystem-multipart/initiate/'):];remote='/'+remote.lstrip('/');destination=Path(owner.resolve_path(remote));mode=json.loads(body).get('permissions','0600');upload=str(uuid.uuid4())
     with owner.lock:owner.uploads[upload]={'path':destination,'mode':int(mode,8),'parts':{}}
     return self.send(200,{'uploadId':upload})
    if path.startswith('/filesystem-multipart/'):
     rest=path[len('/filesystem-multipart/'):];upload,_,action=rest.partition('/');pending=owner.uploads.get(upload)
     if pending is None:return self.send(404,{'error':'No owned upload'})
     if action=='part' and self.command=='PUT':
      message=email.parser.BytesParser(policy=email.policy.default).parsebytes(('Content-Type: '+self.headers['Content-Type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+body)
      chunks=[part.get_payload(decode=True) for part in message.iter_parts() if part.get_param('name',header='content-disposition')=='file'];assert len(chunks)==1
      number=int(query['partNumber'][0]);pending['parts'][number]=chunks[0];return self.send(200,{'partNumber':number,'etag':'fixture-part-'+str(number)})
     if action=='complete' and self.command=='POST':
      destination=pending['path'];destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700);data=b''.join(pending['parts'][n] for n in sorted(pending['parts']));destination.write_bytes(data);destination.chmod(pending['mode']);return self.send(200,{'path':str(destination),'size':len(data)})
     if action=='abort' and self.command=='DELETE':owner.uploads.pop(upload,None);return self.send(200,{})
    if path.startswith('/filesystem/') and self.command=='GET':
     remote='/'+path[len('/filesystem/'):].lstrip('/');target=Path(owner.resolve_path(remote))
     if not target.exists():return self.send(404,{'error':'Owned path absent'})
     if target.is_dir():
      files=[];directories=[]
      for child in sorted(target.iterdir()):
       entry={'name':child.name,'path':remote.rstrip('/')+'/'+child.name,'size':child.stat().st_size}
       (directories if child.is_dir() else files).append(entry)
      return self.send(200,{'path':remote,'files':files,'subdirectories':directories})
     return self.send(200,target.read_bytes(),binary=True)
    return self.send(400,{'error':'Unsupported isolated SDK route'})
   def dispatch(self):
    try:self.route()
    except Exception as error:self.send(500,{'error':type(error).__name__,'message':str(error)[:512]})
   do_GET=do_POST=do_PUT=do_DELETE=dispatch
  self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True;self.endpoint='http://127.0.0.1:'+str(self.server.server_port);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
 def close(self):self.server.shutdown();self.server.server_close();self.thread.join(timeout=5)
